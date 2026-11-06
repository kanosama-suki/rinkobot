/**
 * M2/M3 持久化引擎。
 *
 * 边界：
 * - 事件追加和可选快照在同一 SQLite 事务里提交；
 * - 恢复顺序是“先应用独立墓碑，再从最近快照重放事件”，避免旧备份复活删除内容；
 * - 彻底清除会级联正文/记忆/outbox，删除并重建快照，最后 checkpoint + VACUUM；
 * - 长期记忆正文仍只在 bodies；活跃记忆的 FTS5 双列索引可重建、可级联删除；
 * - 所有数据库错误显式抛出，不自动重建、不静默跳过损坏事件。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import type { LoadedConfig } from '../config/types.ts'
import {
  INITIAL_SNAPSHOT_TIME,
  buildSnapshot,
  deleteAllSnapshots,
  readLatestSnapshot,
  writeSnapshot,
} from './snapshots.ts'
import {
  createBackup,
  hasBackupForLocalDay,
  listBackups,
  localDateKey,
} from './backup.ts'
import {
  buildMemorySearchColumns,
  buildMemorySearchMatch,
} from './memory-search.ts'
import {
  openMainDatabase,
  openTombstoneDatabase,
  quickCheckDatabase,
  inspectDatabaseFile,
} from './database.ts'
import {
  StorageError,
  StorageIntegrityError,
} from './errors.ts'
import {
  createStorageOptions,
  resolveStorageLayout,
} from './paths.ts'
import {
  invalid,
  normalizeChatText,
  validateBodyInput,
  validateChatRole,
  validateIdentifier,
  validateInstant,
  validateOutboxRecord,
} from './records.ts'
import type { BodyInput } from './records.ts'
import {
  canonicalJson,
  createInitialState,
  reduceState,
  systemClock,
  validateMemoryRecord,
  validateStateEvent,
  validateTombstone,
} from '../state/index.ts'
import type {
  LifeState,
  MemoryRecord,
  StateEvent,
  Tombstone,
  TombstoneTargetType,
} from '../state/index.ts'
import type {
  AppendedEvent,
  BackupRecord,
  BeginModelCallInput,
  BodyRecord,
  CareItemRecord,
  CareItemStatus,
  ChatMessageInput,
  ChatMessageRecord,
  ChatTurnAuditRecord,
  ConfirmReminderCandidateResult,
  ConversationRecord,
  DailyPlanRecord,
  DailyPlanItemRecord,
  DailySummaryRecord,
  EmergencyStateRecord,
  EnqueueOutboxInput,
  FinishModelCallInput,
  InitiativeRunRecord,
  InitiativeStateRecord,
  MemoryListOptions,
  MemorySearchOptions,
  MemorySearchResult,
  ModelCallRecord,
  ModelCallPurpose,
  ModelPricingRecord,
  ModelUsageRecord,
  OutboxRecord,
  OutboxDeliveryResult,
  OutboxKind,
  OutboxStatus,
  OwnerAuditAction,
  OwnerAuditRecord,
  OwnerAuditTargetType,
  PurgeResult,
  PurgeTarget,
  PutCareItemInput,
  PutDailyPlanInput,
  PutDailySummaryInput,
  PutReplyStyleCheckInput,
  PutReminderCandidateInput,
  PutReminderInput,
  RecordOwnerAuditInput,
  RecordInitiativeRunInput,
  ReminderCandidateRecord,
  ReminderCandidateStatus,
  ReminderRecord,
  ReminderStatus,
  ReplyStyleCheckRecord,
  SetEmergencyStateInput,
  SnapshotResult,
  StorageOptions,
  UpdateInitiativeStateInput,
} from './types.ts'

interface TombstoneEnforcement {
  tombstones: Tombstone[]
  deletedBodies: number
  deletedMessages: number
  deletedMemories: number
  deletedOutbox: number
  deletedSnapshots: number
}

const TOMBSTONE_TARGET_TYPES: readonly TombstoneTargetType[] = [
  'body',
  'memory',
  'outbox',
  'event',
]

const OWNER_AUDIT_ACTIONS: readonly OwnerAuditAction[] = [
  'memory.create',
  'memory.correct',
  'memory.promote',
  'memory.trash',
  'memory.restore',
  'memory.purge',
  'emergency.stop',
  'emergency.resume',
]

const OWNER_AUDIT_TARGET_TYPES: readonly OwnerAuditTargetType[] = [
  'memory',
  'system',
]

const OUTBOX_KINDS: readonly OutboxKind[] = [
  'proactive',
  'reminder',
  'system',
  'legacy',
]

export class KanobotStorage {
  readonly dataDir: string
  readonly databasePath: string
  readonly tombstonePath: string
  readonly backupDir: string

  private readonly options: StorageOptions
  private readonly db: DatabaseSync
  private readonly tombstoneDb: DatabaseSync
  private readonly openedAtMillis: number
  private state: LifeState
  private sequence = 0
  private lastEventId: string | null = null
  private lastEventAt = INITIAL_SNAPSHOT_TIME
  private lastSnapshotSequence = 0
  private lastSnapshotAt: string | null = null
  private closed = false

  static open(options: StorageOptions): KanobotStorage {
    validateOptions(options)
    const openedAt = options.clock.now()
    if (Number.isNaN(openedAt.getTime())) {
      throw new StorageError('IO', 'clock returned an invalid date')
    }

    // 主库和墓碑库必须成对存在。只缺一个时说明恢复不完整，不能现场造一个
    // 空库顶替：空主库会丢数据，空墓碑库会让已删除内容重新出现。
    const mainExists = existsSync(options.databasePath)
    const tombstoneExists = existsSync(options.tombstonePath)
    if (mainExists) inspectDatabaseFile(options.databasePath, 'main')
    if (tombstoneExists) inspectDatabaseFile(options.tombstonePath, 'tombstones')
    if (mainExists !== tombstoneExists) {
      throw new StorageError(
        'SCHEMA_INCOMPATIBLE',
        mainExists
          ? 'tombstone database is missing; refusing to create an empty deletion ledger'
          : 'main database is missing; refusing to create an empty replacement',
        { path: mainExists ? options.databasePath : options.tombstonePath },
      )
    }

    let db: DatabaseSync | undefined
    let tombstoneDb: DatabaseSync | undefined
    try {
      db = openMainDatabase(options.databasePath, openedAt.toISOString())
      tombstoneDb = openTombstoneDatabase(
        options.tombstonePath,
        openedAt.toISOString(),
      )
      const storage = new KanobotStorage(
        options,
        db,
        tombstoneDb,
        openedAt.getTime(),
      )
      db = undefined
      tombstoneDb = undefined
      try {
        storage.initialize()
        return storage
      } catch (error) {
        storage.closeAfterFailedOpen()
        throw error
      }
    } finally {
      db?.close()
      tombstoneDb?.close()
    }
  }

  static openFromConfig(
    loaded: LoadedConfig,
    dataDir: string,
    clock = systemClock,
  ): KanobotStorage {
    const options = createStorageOptions({
      dataDir,
      storage: loaded.system.storage,
      timezone: loaded.system.time.timezone,
      lifeState: loaded.lifeState,
      trashRetentionDays: loaded.memory.trash.retentionDays,
      clock,
    })
    return KanobotStorage.open(options)
  }

  private constructor(
    options: StorageOptions,
    db: DatabaseSync,
    tombstoneDb: DatabaseSync,
    openedAtMillis: number,
  ) {
    this.options = options
    this.db = db
    this.tombstoneDb = tombstoneDb
    this.openedAtMillis = openedAtMillis
    this.dataDir = options.dataDir
    this.databasePath = options.databasePath
    this.tombstonePath = options.tombstonePath
    this.backupDir = options.backupDir
    this.state = createInitialState(options.lifeState)
  }

  currentState(): LifeState {
    this.assertOpen()
    return structuredClone(this.state)
  }

  get lastSequence(): number {
    this.assertOpen()
    return this.sequence
  }

  get latestEventId(): string | null {
    this.assertOpen()
    return this.lastEventId
  }

  eventCount(): number {
    this.assertOpen()
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as
      | Record<string, unknown>
      | undefined
    return Number(row?.count ?? 0)
  }

  appendEvent(input: StateEvent): AppendedEvent {
    this.assertOpen()
    const event = validateStateEvent(input)
    const occurredAtMillis = Date.parse(event.occurredAt)
    if (
      this.sequence > 0 &&
      occurredAtMillis < Date.parse(this.lastEventAt)
    ) {
      invalid(
        'event.occurredAt',
        `event time ${event.occurredAt} is older than the latest event ${this.lastEventAt}`,
      )
    }

    const nextState = reduceState(this.state, event, this.options.lifeState)
    const nextSequence = this.sequence + 1
    const snapshot = this.shouldSnapshot(nextSequence, occurredAtMillis)
      ? buildSnapshot(nextState, nextSequence, event.eventId, event.occurredAt)
      : null
    const payloadJson = canonicalJson(event.payload)
    const evidenceRefsJson = canonicalJson(event.evidenceRefs)

    this.inTransaction(() => {
      try {
        this.db.prepare(
          `INSERT INTO events
            (event_id, schema_version, occurred_at, source, event_type,
             payload_json, evidence_refs_json, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.eventId,
          event.schemaVersion,
          event.occurredAt,
          event.source,
          event.type,
          payloadJson,
          evidenceRefsJson,
          event.confidence,
        )
      } catch (error) {
        if (messageOf(error).includes('UNIQUE constraint failed: events.event_id')) {
          throw new StorageError(
            'DUPLICATE_ID',
            `event "${event.eventId}" already exists`,
            { cause: error },
          )
        }
        throw error
      }
      if (snapshot !== null) {
        writeSnapshot(this.db, snapshot)
      }
    })

    this.state = nextState
    this.sequence = nextSequence
    this.lastEventId = event.eventId
    this.lastEventAt = event.occurredAt
    if (snapshot !== null) {
      this.lastSnapshotSequence = snapshot.snapshot.lastSequence
      this.lastSnapshotAt = snapshot.snapshot.generatedAt
    } else if (this.lastSnapshotAt === null) {
      // 没有快照时用首个事件作为小时窗口锚点；这个值重启时可从事件日志恢复。
      this.lastSnapshotAt = event.occurredAt
    }
    return {
      sequence: nextSequence,
      snapshot,
    }
  }

  createSnapshot(): SnapshotResult {
    this.assertOpen()
    const latest = readLatestSnapshot(this.db)
    if (latest !== null && latest.snapshot.lastSequence === this.sequence) {
      const current = this.buildCurrentSnapshot()
      if (current.json !== latest.json) {
        throw new StorageError(
          'RECORD_INVALID',
          'a different snapshot already exists at the current sequence',
        )
      }
      return latest
    }
    const snapshot = this.buildCurrentSnapshot()
    this.inTransaction(() => {
      writeSnapshot(this.db, snapshot)
    })
    this.lastSnapshotSequence = snapshot.snapshot.lastSequence
    this.lastSnapshotAt = snapshot.snapshot.generatedAt
    return snapshot
  }

  latestSnapshot(): SnapshotResult | null {
    this.assertOpen()
    return readLatestSnapshot(this.db)
  }

  latestSnapshotJson(): string | null {
    return this.latestSnapshot()?.json ?? null
  }

  putBody(input: BodyInput): BodyRecord {
    this.assertOpen()
    const validated = validateBodyInput(input)
    this.assertNotTombstoned('body', validated.id)
    const body: BodyRecord = {
      ...validated,
      createdAt: input.createdAt ?? this.nowIso(),
    }
    validateInstant(body.createdAt, 'body.createdAt')
    try {
      this.db.prepare(
        'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
      ).run(body.id, body.kind, body.content, body.createdAt)
    } catch (error) {
      throw mapInsertError(error, 'body', body.id)
    }
    return body
  }

  getBody(id: string): BodyRecord | null {
    this.assertOpen()
    validateIdentifier(id, 'body.id')
    const row = this.db.prepare(
      'SELECT id, kind, content, created_at FROM bodies WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    if (row === undefined) return null
    if (
      typeof row.id !== 'string' ||
      typeof row.kind !== 'string' ||
      typeof row.content !== 'string' ||
      typeof row.created_at !== 'string'
    ) {
      throw new StorageIntegrityError('body row has invalid column types', ':bodies:')
    }
    return {
      id: row.id,
      kind: row.kind,
      content: row.content,
      createdAt: row.created_at,
    }
  }

  ensureConversation(
    id = 'main',
    at: string = this.nowIso(),
  ): ConversationRecord {
    this.assertOpen()
    const conversationId = validateIdentifier(id, 'conversation.id')
    const createdAt = validateInstant(at, 'conversation.createdAt')
    return this.ensureConversationRow(conversationId, createdAt)
  }

  getConversation(id = 'main'): ConversationRecord | null {
    this.assertOpen()
    const conversationId = validateIdentifier(id, 'conversation.id')
    const row = this.db.prepare(
      'SELECT id, created_at, updated_at FROM conversations WHERE id = ?',
    ).get(conversationId) as Record<string, unknown> | undefined
    return row === undefined ? null : conversationFromRow(row)
  }

  appendChatMessage(input: ChatMessageInput): ChatMessageRecord {
    this.assertOpen()
    const conversationId = validateIdentifier(
      input.conversationId,
      'message.conversationId',
    )
    const role = validateChatRole(input.role)
    const text = normalizeChatText(input.text)
    const messageId = validateIdentifier(
      input.id ?? `message-${randomUUID()}`,
      'message.id',
    )
    const createdAt = validateInstant(
      input.createdAt ?? this.nowIso(),
      'message.createdAt',
    )
    const bodyId = `body-${randomUUID()}`
    const body = validateBodyInput({
      id: bodyId,
      kind: `chat.${role}`,
      content: text,
      createdAt,
    })

    this.inTransaction(() => {
      this.ensureConversationRow(conversationId, createdAt)
      try {
        this.db.prepare(
          'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
        ).run(body.id, body.kind, body.content, body.createdAt)
        this.db.prepare(
          `INSERT INTO messages
            (id, conversation_id, role, body_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(messageId, conversationId, role, body.id, createdAt)
        this.db.prepare(
          `UPDATE conversations
           SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
           WHERE id = ?`,
        ).run(createdAt, createdAt, conversationId)
      } catch (error) {
        throw mapInsertError(error, 'chat message', messageId)
      }
    })

    return {
      id: messageId,
      bodyId: body.id,
      conversationId,
      role,
      text: body.content,
      createdAt,
    }
  }

  getChatMessage(id: string): ChatMessageRecord | null {
    this.assertOpen()
    const messageId = validateIdentifier(id, 'message.id')
    const row = this.db.prepare(
      `SELECT m.id, m.body_id, m.conversation_id, m.role,
              b.content AS body_text, m.created_at
       FROM messages m
       JOIN bodies b ON b.id = m.body_id
       WHERE m.id = ?`,
    ).get(messageId) as Record<string, unknown> | undefined
    return row === undefined ? null : chatMessageFromRow(row)
  }

  listChatMessages(conversationId = 'main', limit = 40): ChatMessageRecord[] {
    this.assertOpen()
    const id = validateIdentifier(conversationId, 'message.conversationId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new StorageError(
        'RECORD_INVALID',
        'message limit must be an integer between 1 and 100',
      )
    }
    const rows = this.db.prepare(
      `SELECT id, body_id, conversation_id, role, body_text, created_at
       FROM (
         SELECT m.seq, m.id, m.body_id, m.conversation_id, m.role,
                b.content AS body_text, m.created_at
         FROM messages m
         JOIN bodies b ON b.id = m.body_id
         WHERE m.conversation_id = ?
         ORDER BY m.seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    ).all(id, limit) as Array<Record<string, unknown>>
    return rows.map(chatMessageFromRow)
  }

  /**
   * 只查最近一条用户消息，用于计算“距上次发言多久”。
   *
   * 不能从有限的上下文窗口倒推：窗口可能被助手消息占满，也可能因为
   * 用户消息被彻底清除而缺少对应条目。
   */
  latestUserChatMessage(
    conversationId = 'main',
  ): ChatMessageRecord | null {
    this.assertOpen()
    const id = validateIdentifier(conversationId, 'message.conversationId')
    const row = this.db.prepare(
      `SELECT m.id, m.body_id, m.conversation_id, m.role,
              b.content AS body_text, m.created_at
       FROM messages m
       JOIN bodies b ON b.id = m.body_id
       WHERE m.conversation_id = ? AND m.role = 'user'
       ORDER BY m.seq DESC
       LIMIT 1`,
    ).get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : chatMessageFromRow(row)
  }

  latestChatMessage(
    conversationId = 'main',
  ): ChatMessageRecord | null {
    this.assertOpen()
    const id = validateIdentifier(conversationId, 'message.conversationId')
    const row = this.db.prepare(
      `SELECT m.id, m.body_id, m.conversation_id, m.role,
              b.content AS body_text, m.created_at
       FROM messages m
       JOIN bodies b ON b.id = m.body_id
       WHERE m.conversation_id = ?
       ORDER BY m.seq DESC
       LIMIT 1`,
    ).get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : chatMessageFromRow(row)
  }

  /**
   * 返回本地日范围内的消息，按时间升序。用于每日整理；上限在 SQL 层
   * 生效，避免一次把整段历史读入内存。
   */
  listChatMessagesBetween(
    conversationId: string,
    start: string,
    end: string,
    limit = 200,
  ): ChatMessageRecord[] {
    this.assertOpen()
    const id = validateIdentifier(conversationId, 'message.conversationId')
    const from = validateInstant(start, 'message.range.start')
    const until = validateInstant(end, 'message.range.end')
    if (Date.parse(until) <= Date.parse(from)) {
      throw new StorageError(
        'RECORD_INVALID',
        'message range end must be later than start',
      )
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StorageError(
        'RECORD_INVALID',
        'message range limit must be an integer between 1 and 1000',
      )
    }
    const rows = this.db.prepare(
      `SELECT id, body_id, conversation_id, role, body_text, created_at
       FROM (
         SELECT m.seq, m.id, m.body_id, m.conversation_id, m.role,
                b.content AS body_text, m.created_at
         FROM messages m
         JOIN bodies b ON b.id = m.body_id
         WHERE m.conversation_id = ?
           AND m.created_at >= ?
           AND m.created_at < ?
         ORDER BY m.seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    ).all(id, from, until, limit) as Array<Record<string, unknown>>
    return rows.map(chatMessageFromRow)
  }

  chatMessageCount(conversationId = 'main'): number {
    this.assertOpen()
    const id = validateIdentifier(conversationId, 'message.conversationId')
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
    ).get(id) as Record<string, unknown> | undefined
    return Number(row?.count ?? 0)
  }

  beginModelCall(input: BeginModelCallInput): ModelCallRecord {
    this.assertOpen()
    const conversationId = validateIdentifier(
      input.conversationId,
      'modelCall.conversationId',
    )
    const userMessageId =
      input.userMessageId === undefined || input.userMessageId === null
        ? null
        : validateIdentifier(
            input.userMessageId,
            'modelCall.userMessageId',
          )
    const provider = validateModelLabel(input.provider, 'modelCall.provider')
    const model = validateModelLabel(input.model, 'modelCall.model')
    const purpose = validateModelCallPurpose(input.purpose ?? 'chat')
    const id = validateIdentifier(
      input.id ?? `model-call-${randomUUID()}`,
      'modelCall.id',
    )
    const startedAt = validateInstant(
      input.startedAt ?? this.nowIso(),
      'modelCall.startedAt',
    )
    if (purpose === 'chat' && userMessageId === null) {
      throw new StorageError(
        'RECORD_INVALID',
        'a chat model call requires a user message anchor',
      )
    }
    if (
      (purpose === 'initiative' || purpose === 'daily_review') &&
      userMessageId !== null
    ) {
      throw new StorageError(
        'RECORD_INVALID',
        'an internal initiative call must not claim a user message anchor',
      )
    }
    if (userMessageId !== null) {
      this.assertMessageRole(userMessageId, conversationId, 'user')
    } else {
      this.ensureConversationRow(conversationId, startedAt)
    }
    const localDay = localDateKey(
      new Date(startedAt),
      this.options.timezone,
    )

    try {
      this.db.prepare(
        `INSERT INTO model_calls
          (id, conversation_id, user_message_id, assistant_message_id,
           purpose, provider, model, started_at, completed_at, local_day, status,
           attempts, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, reasoning_tokens, total_tokens, estimated_cost,
           pricing_json, response_id, error_code)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, 'running',
                 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      ).run(
        id,
        conversationId,
        userMessageId,
        purpose,
        provider,
        model,
        startedAt,
        localDay,
      )
    } catch (error) {
      throw mapInsertError(error, 'model call', id)
    }

    const created = this.getModelCall(id)
    if (created === null) {
      throw new StorageIntegrityError(
        `model call "${id}" disappeared during creation`,
        ':model_calls:',
      )
    }
    return created
  }

  finishModelCall(id: string, input: FinishModelCallInput): ModelCallRecord {
    this.assertOpen()
    const callId = validateIdentifier(id, 'modelCall.id')
    const current = this.getModelCall(callId)
    if (current === null) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `model call "${callId}" does not exist`,
      )
    }
    if (current.status !== 'running') {
      throw new StorageError(
        'RECORD_INVALID',
        `model call "${callId}" is already ${current.status}`,
      )
    }
    if (input.status !== 'succeeded' && input.status !== 'failed' && input.status !== 'aborted') {
      throw new StorageError(
        'RECORD_INVALID',
        `unsupported terminal model call status "${String(input.status)}"`,
      )
    }
    const attempts = validateNonNegativeInteger(
      input.attempts,
      'modelCall.attempts',
    )
    const completedAt = validateInstant(
      input.completedAt ?? this.nowIso(),
      'modelCall.completedAt',
    )
    const assistantMessageId =
      input.assistantMessageId === undefined || input.assistantMessageId === null
        ? null
        : validateIdentifier(
            input.assistantMessageId,
            'modelCall.assistantMessageId',
          )
    if (
      input.status === 'succeeded' &&
      current.purpose === 'chat' &&
      assistantMessageId === null
    ) {
      throw new StorageError(
        'RECORD_INVALID',
        'a succeeded model call must reference its assistant message',
      )
    }
    if (current.purpose === 'memory_extraction' && assistantMessageId !== null) {
      throw new StorageError(
        'RECORD_INVALID',
        'a memory extraction call does not produce an assistant message',
      )
    }
    if (current.purpose === 'vision' && assistantMessageId !== null) {
      throw new StorageError(
        'RECORD_INVALID',
        'a vision call does not produce an assistant message',
      )
    }
    if (
      (current.purpose === 'initiative' ||
        current.purpose === 'daily_review') &&
      assistantMessageId !== null
    ) {
      throw new StorageError(
        'RECORD_INVALID',
        'an internal initiative call does not produce an assistant message',
      )
    }
    if (assistantMessageId !== null) {
      this.assertMessageRole(
        assistantMessageId,
        current.conversationId,
        'assistant',
      )
    }

    const usage = input.usage === undefined || input.usage === null
      ? null
      : validateModelUsage(input.usage)
    const pricing = input.pricing === undefined || input.pricing === null
      ? null
      : validateModelPricing(input.pricing)
    const estimatedCost =
      input.estimatedCost === undefined || input.estimatedCost === null
        ? null
        : validateNonNegativeNumber(
            input.estimatedCost,
            'modelCall.estimatedCost',
          )
    const responseId =
      input.responseId === undefined || input.responseId === null
        ? null
        : validateModelText(input.responseId, 'modelCall.responseId')
    const errorCode =
      input.errorCode === undefined || input.errorCode === null
        ? null
        : validateModelErrorCode(input.errorCode)

    try {
      this.db.prepare(
        `UPDATE model_calls SET
          assistant_message_id = ?, completed_at = ?, status = ?, attempts = ?,
          input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
          cache_write_tokens = ?, reasoning_tokens = ?, total_tokens = ?,
          estimated_cost = ?, pricing_json = ?, response_id = ?, error_code = ?
         WHERE id = ? AND status = 'running'`,
      ).run(
        assistantMessageId,
        completedAt,
        input.status,
        attempts,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheWriteTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.totalTokens ?? null,
        estimatedCost,
        pricing === null ? null : canonicalJson(pricing),
        responseId,
        errorCode,
        callId,
      )
    } catch (error) {
      throw new StorageError(
        'IO',
        `cannot finish model call "${callId}": ${messageOf(error)}`,
        { cause: error },
      )
    }

    const updated = this.getModelCall(callId)
    if (updated === null) {
      throw new StorageIntegrityError(
        `model call "${callId}" disappeared during completion`,
        ':model_calls:',
      )
    }
    return updated
  }

  getModelCall(id: string): ModelCallRecord | null {
    this.assertOpen()
    const callId = validateIdentifier(id, 'modelCall.id')
    const row = this.db.prepare(
      'SELECT * FROM model_calls WHERE id = ?',
    ).get(callId) as Record<string, unknown> | undefined
    return row === undefined ? null : modelCallFromRow(row)
  }

  latestModelCall(
    conversationId = 'main',
    purpose?: ModelCallPurpose,
  ): ModelCallRecord | null {
    this.assertOpen()
    const id = validateIdentifier(conversationId, 'modelCall.conversationId')
    const row = purpose === undefined
      ? this.db.prepare(
          `SELECT * FROM model_calls
           WHERE conversation_id = ?
           ORDER BY started_at DESC, rowid DESC
           LIMIT 1`,
        ).get(id) as Record<string, unknown> | undefined
      : this.db.prepare(
          `SELECT * FROM model_calls
           WHERE conversation_id = ? AND purpose = ?
           ORDER BY started_at DESC, rowid DESC
           LIMIT 1`,
        ).get(id, validateModelCallPurpose(purpose)) as
          | Record<string, unknown>
          | undefined
    return row === undefined ? null : modelCallFromRow(row)
  }

  modelCallCountToday(now: Date = this.options.clock.now()): number {
    this.assertOpen()
    const localDay = localDateKey(now, this.options.timezone)
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM model_calls WHERE local_day = ?',
    ).get(localDay) as Record<string, unknown> | undefined
    return Number(row?.count ?? 0)
  }

  runningModelCallCount(): number {
    this.assertOpen()
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM model_calls WHERE status = 'running'",
    ).get() as Record<string, unknown> | undefined
    return Number(row?.count ?? 0)
  }

  /**
   * 统一审计只读取调用元数据；provider/model/errorCode 都不含提示词或
   * 回复正文。
   */
  listModelCalls(limit = 100): ModelCallRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'model call audit')
    const rows = this.db.prepare(
      `SELECT * FROM model_calls
       ORDER BY started_at DESC, rowid DESC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(modelCallFromRow)
  }

  /**
   * 风格检查属于回复的审计元数据，不复制正文。一个助手消息最多一行，
   * 因此重复写入同一消息会明确失败，而不是覆盖历史检查结果。
   */
  putReplyStyleCheck(input: PutReplyStyleCheckInput): ReplyStyleCheckRecord {
    this.assertOpen()
    const assistantMessageId = validateIdentifier(
      input.assistantMessageId,
      'replyStyleCheck.assistantMessageId',
    )
    const message = this.db.prepare(
      'SELECT role FROM messages WHERE id = ?',
    ).get(assistantMessageId) as Record<string, unknown> | undefined
    if (message === undefined || message.role !== 'assistant') {
      throw new StorageError(
        'REFERENCE_MISSING',
        `assistant message "${assistantMessageId}" does not exist`,
      )
    }
    if (typeof input.ok !== 'boolean') {
      invalid('replyStyleCheck.ok', 'expected a boolean')
    }
    const violationCodes = validateStyleViolationCodes(input.violationCodes)
    if (input.ok !== (violationCodes.length === 0)) {
      invalid(
        'replyStyleCheck.ok',
        'ok must be true exactly when there are no violations',
      )
    }
    const checkedAt = validateInstant(
      input.checkedAt ?? this.nowIso(),
      'replyStyleCheck.checkedAt',
    )
    const id = validateIdentifier(
      input.id ?? `style-${randomUUID()}`,
      'replyStyleCheck.id',
    )
    const retryCount = input.retryCount ?? 0
    if (retryCount !== 0 && retryCount !== 1) {
      invalid('replyStyleCheck.retryCount', 'expected 0 or 1')
    }
    const initialViolationCodes = validateStyleViolationCodes(
      input.initialViolationCodes ?? [],
    )
    if (retryCount === 0 && initialViolationCodes.length > 0) {
      invalid(
        'replyStyleCheck.initialViolationCodes',
        'must be empty when no retry occurred',
      )
    }
    if (retryCount === 1 && initialViolationCodes.length === 0) {
      invalid(
        'replyStyleCheck.initialViolationCodes',
        'must record the failed first check when retryCount is 1',
      )
    }
    try {
      this.db.prepare(
        `INSERT INTO reply_style_checks
          (id, assistant_message_id, schema_version, ok,
           violation_codes_json, retry_count, initial_violation_codes_json,
           checked_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        assistantMessageId,
        input.ok ? 1 : 0,
        canonicalJson(violationCodes),
        retryCount,
        canonicalJson(initialViolationCodes),
        checkedAt,
      )
    } catch (error) {
      throw mapInsertError(error, 'reply style check', id)
    }
    const created = this.getReplyStyleCheck(assistantMessageId)
    if (created === null) {
      throw new StorageIntegrityError(
        `reply style check "${id}" disappeared during creation`,
        ':reply_style_checks:',
      )
    }
    return created
  }

  getReplyStyleCheck(assistantMessageId: string): ReplyStyleCheckRecord | null {
    this.assertOpen()
    const messageId = validateIdentifier(
      assistantMessageId,
      'replyStyleCheck.assistantMessageId',
    )
    const row = this.db.prepare(
      'SELECT * FROM reply_style_checks WHERE assistant_message_id = ?',
    ).get(messageId) as Record<string, unknown> | undefined
    return row === undefined ? null : replyStyleCheckFromRow(row)
  }

  listReplyStyleChecks(limit = 100): ReplyStyleCheckRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'reply style check audit')
    const rows = this.db.prepare(
      `SELECT * FROM reply_style_checks
       ORDER BY checked_at DESC, id DESC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(replyStyleCheckFromRow)
  }

  /**
   * 聊天回合摘要用于把消息、模型调用和风格检查放在同一条时间线上。
   * 查询不 JOIN bodies，正文没有进入这条审计路径的机会。
   */
  listChatTurnAudits(limit = 100): ChatTurnAuditRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'chat turn audit')
    const rows = this.db.prepare(
      `SELECT
         m.id AS assistant_message_id,
         m.conversation_id,
         m.created_at,
         COUNT(mc.id) AS model_call_count,
         COALESCE(SUM(CASE WHEN mc.status = 'succeeded' THEN 1 ELSE 0 END), 0)
           AS succeeded_model_call_count,
         s.ok AS style_ok,
         s.violation_codes_json,
         s.retry_count
       FROM messages m
       LEFT JOIN model_calls mc ON mc.assistant_message_id = m.id
       LEFT JOIN reply_style_checks s ON s.assistant_message_id = m.id
       WHERE m.role = 'assistant'
       GROUP BY m.id, m.conversation_id, m.created_at, s.ok,
                s.violation_codes_json, s.retry_count
       ORDER BY m.created_at DESC, m.seq DESC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(chatTurnAuditFromRow)
  }

  /**
   * 记忆审计只需要记录语气、来源、状态和 ID，不读取正文 body。
   */
  listRecentMemories(limit = 100): MemoryRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'memory audit')
    const rows = this.db.prepare(
      `SELECT * FROM memories
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(memoryFromRow)
  }

  /**
   * 所有者审计只记录动作、对象 ID 和结果，不记录记忆正文。
   * 审计表不随记忆彻底清除而删除，保留“谁在何时做过什么”的事实。
   */
  recordOwnerAudit(input: RecordOwnerAuditInput): OwnerAuditRecord {
    this.assertOpen()
    const action = validateOwnerAuditAction(input.action)
    const targetType = validateOwnerAuditTargetType(input.targetType)
    const targetId = validateIdentifier(input.targetId, 'ownerAudit.targetId')
    const outcome = input.outcome ?? 'succeeded'
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      invalid('ownerAudit.outcome', 'expected "succeeded" or "failed"')
    }
    const detailCode = input.detailCode === undefined || input.detailCode === null
      ? null
      : validateAuditDetailCode(input.detailCode)
    const occurredAt = validateInstant(
      input.occurredAt ?? this.nowIso(),
      'ownerAudit.occurredAt',
    )
    const id = validateIdentifier(
      input.id ?? `audit-${randomUUID()}`,
      'ownerAudit.id',
    )
    try {
      this.db.prepare(
        `INSERT INTO owner_audit
          (id, occurred_at, action, target_type, target_id, outcome, detail_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, occurredAt, action, targetType, targetId, outcome, detailCode)
    } catch (error) {
      throw mapInsertError(error, 'owner audit', id)
    }
    return {
      id,
      occurredAt,
      action,
      targetType,
      targetId,
      outcome,
      detailCode,
    }
  }

  listOwnerAudit(limit = 50): OwnerAuditRecord[] {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new StorageError(
        'RECORD_INVALID',
        'owner audit limit must be an integer between 1 and 200',
      )
    }
    const rows = this.db.prepare(
      `SELECT * FROM owner_audit
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(ownerAuditFromRow)
  }

  ownerAuditCount(): number {
    this.assertOpen()
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM owner_audit',
    ).get() as Record<string, unknown> | undefined
    return Number(row?.count ?? 0)
  }

  getEmergencyState(): EmergencyStateRecord {
    this.assertOpen()
    const row = this.db.prepare(
      'SELECT stopped, updated_at, reason_code FROM emergency_state WHERE id = 1',
    ).get() as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new StorageIntegrityError(
        'emergency state row is missing',
        ':emergency_state:',
      )
    }
    if (row.stopped !== 0 && row.stopped !== 1) {
      throw new StorageIntegrityError(
        'emergency state stopped is not 0 or 1',
        ':emergency_state:',
      )
    }
    return {
      stopped: row.stopped === 1,
      updatedAt: validateInstant(
        String(row.updated_at),
        'emergency.updatedAt',
      ),
      reasonCode: validateReasonCode(row.reason_code, 'emergency.reasonCode'),
    }
  }

  setEmergencyState(input: SetEmergencyStateInput): EmergencyStateRecord {
    this.assertOpen()
    if (typeof input.stopped !== 'boolean') {
      invalid('emergency.stopped', 'expected a boolean')
    }
    const reasonCode = validateReasonCode(
      input.reasonCode,
      'emergency.reasonCode',
    )
    const updatedAt = validateInstant(
      input.updatedAt ?? this.nowIso(),
      'emergency.updatedAt',
    )
    this.db.prepare(
      `INSERT INTO emergency_state (id, stopped, updated_at, reason_code)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         stopped = excluded.stopped,
         updated_at = excluded.updated_at,
         reason_code = excluded.reason_code`,
    ).run(input.stopped ? 1 : 0, updatedAt, reasonCode)
    return this.getEmergencyState()
  }

  purgeChatMessage(id: string, at: string = this.nowIso()): PurgeResult {
    this.assertOpen()
    const messageId = validateIdentifier(id, 'message.id')
    const row = this.db.prepare(
      'SELECT body_id FROM messages WHERE id = ?',
    ).get(messageId) as Record<string, unknown> | undefined
    if (row === undefined || typeof row.body_id !== 'string') {
      throw new StorageError(
        'REFERENCE_MISSING',
        `chat message "${messageId}" does not exist`,
      )
    }
    return this.purge({ targetType: 'body', targetId: row.body_id }, at)
  }

  putMemory(input: MemoryRecord): MemoryRecord {
    this.assertOpen()
    const memory = this.prepareMemoryWrite(input)
    this.inTransaction(() => {
      this.insertMemoryRow(memory)
    })
    return memory
  }

  /**
   * 用户纠正会建立一条新记忆，并在同一事务里把旧记忆标为 replaced。
   * 旧记录的正文仍保留作证据，但不再进入全文检索。
   */
  replaceMemory(oldId: string, replacement: MemoryRecord): MemoryRecord {
    this.assertOpen()
    const previousId = validateIdentifier(oldId, 'memory.oldId')
    const current = this.getMemory(previousId)
    if (current === null) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `memory "${previousId}" does not exist`,
      )
    }
    if (current.status !== 'active') {
      throw new StorageError(
        'RECORD_INVALID',
        `memory "${previousId}" must be active before it can be replaced`,
      )
    }
    const memory = this.prepareMemoryWrite(replacement)
    if (memory.id === previousId) {
      throw new StorageError(
        'RECORD_INVALID',
        'a replacement memory must have a different ID',
      )
    }
    if (memory.status !== 'active') {
      throw new StorageError(
        'RECORD_INVALID',
        'a replacement memory must be active',
      )
    }
    const superseded = validateMemoryRecord({
      ...current,
      status: 'replaced',
      replacedBy: memory.id,
    })
    this.inTransaction(() => {
      this.insertMemoryRow(memory)
      this.updateMemoryRow(superseded, null)
    })
    return memory
  }

  /**
   * 候选转正只能由所有者操作触发；存储层不自行判断证据是否充分。
   */
  promoteMemory(id: string): MemoryRecord {
    this.assertOpen()
    const memoryId = validateIdentifier(id, 'memory.id')
    const current = this.getMemory(memoryId)
    if (current === null) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `memory "${memoryId}" does not exist`,
      )
    }
    if (current.status !== 'candidate') {
      throw new StorageError(
        'RECORD_INVALID',
        `memory "${memoryId}" is ${current.status}, not candidate`,
      )
    }
    this.assertBodyAvailable(current.contentRef, 'memory.contentRef')
    if (current.quoteRef !== null) {
      this.assertBodyAvailable(current.quoteRef, 'memory.quoteRef')
    }
    const promoted = validateMemoryRecord({
      ...current,
      status: 'active',
    })
    this.inTransaction(() => {
      this.updateMemoryRow(promoted, null)
    })
    return promoted
  }

  searchMemories(
    query: string,
    options: MemorySearchOptions = {},
  ): MemorySearchResult[] {
    this.assertOpen()
    const limit = options.limit ?? 5
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new StorageError(
        'RECORD_INVALID',
        'memory search limit must be an integer between 1 and 50',
      )
    }
    let match: string | null
    try {
      match = buildMemorySearchMatch(query, options.matchMode ?? 'all')
    } catch (error) {
      throw new StorageError(
        'RECORD_INVALID',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
    if (match === null) return []

    const rows = this.db.prepare(
      `SELECT m.*, b.content AS memory_text,
              bm25(memory_search, 0.0, 2.0, 1.0) AS search_rank
       FROM memory_search
       JOIN memories m ON m.id = memory_search.memory_id
       JOIN bodies b ON b.id = m.content_ref
       WHERE memory_search MATCH ?
         AND m.status = 'active'
       -- 相关性先于“永久重要”：永久记忆不应劫持一个主题完全不同的当前问题。
       -- 召回时间较近的条目排在同等相关度之后，减少同一旧事被连续复述。
       ORDER BY
         search_rank ASC,
         CASE m.importance
           WHEN 'permanent' THEN 0
           WHEN 'important' THEN 1
           ELSE 2
         END ASC,
         CASE WHEN m.last_recalled_at IS NULL THEN 0 ELSE 1 END ASC,
         m.last_recalled_at ASC,
         m.created_at DESC,
         m.id ASC
       LIMIT ?`,
    ).all(match, limit) as Array<Record<string, unknown>>

    const results = rows.map(row => {
      if (typeof row.memory_text !== 'string') {
        throw new StorageIntegrityError(
          'memory search row has invalid body text',
          ':memory_search:',
        )
      }
      if (typeof row.search_rank !== 'number' || !Number.isFinite(row.search_rank)) {
        throw new StorageIntegrityError(
          'memory search row has invalid rank',
          ':memory_search:',
        )
      }
      return {
        memory: memoryFromRow(row),
        text: row.memory_text,
        rank: row.search_rank,
      }
    })

    if (options.markRecalled === true && results.length > 0) {
      this.markMemoriesRecalled(results.map(result => result.memory.id))
    }
    return results
  }

  markMemoriesRecalled(ids: readonly string[], at: string = this.nowIso()): void {
    this.assertOpen()
    const recalledAt = validateInstant(at, 'memory.lastRecalledAt')
    const uniqueIds = new Set<string>()
    for (const id of ids) {
      uniqueIds.add(validateIdentifier(id, 'memory.id'))
    }
    this.inTransaction(() => {
      for (const id of uniqueIds) {
        const memory = this.getMemory(id)
        if (memory === null) {
          throw new StorageError(
            'REFERENCE_MISSING',
            `memory "${id}" does not exist`,
          )
        }
        if (memory.status !== 'active' || memory.lastRecalledAt === recalledAt) {
          continue
        }
        // 召回时间不参与 FTS 内容，无需重建索引。
        this.updateMemoryRow(
          validateMemoryRecord({
            ...memory,
            lastRecalledAt: recalledAt,
          }),
          null,
          false,
        )
      }
    })
  }

  getMemory(id: string): MemoryRecord | null {
    this.assertOpen()
    validateIdentifier(id, 'memory.id')
    const row = this.db.prepare(
      'SELECT * FROM memories WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : memoryFromRow(row)
  }

  listMemories(options: MemoryListOptions = {}): MemoryRecord[] {
    this.assertOpen()
    let sql = 'SELECT * FROM memories'
    if (options.onlyDeleted === true) {
      sql += " WHERE status = 'deleted'"
    } else if (options.includeDeleted !== true) {
      sql += " WHERE status <> 'deleted'"
    }
    sql += ' ORDER BY created_at ASC, id ASC'
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>
    return rows.map(memoryFromRow)
  }

  trashMemory(id: string, at: string = this.nowIso()): MemoryRecord {
    this.assertOpen()
    const current = this.getMemory(id)
    if (current === null) {
      throw new StorageError('REFERENCE_MISSING', `memory "${id}" does not exist`)
    }
    if (current.status === 'deleted') return current
    const deletedAt = validateInstant(at, 'memory.deletedAt')
    const purgeAfter = new Date(
      Date.parse(deletedAt) + this.options.trashRetentionDays * 86_400_000,
    ).toISOString()
    const updated = validateMemoryRecord({
      ...current,
      status: 'deleted',
      deletedAt,
      purgeAfter,
    })
    // 回收站恢复要回到删除前状态；previous_status 是内部列，不新增正文。
    this.inTransaction(() => {
      this.updateMemoryRow(updated, current.status)
    })
    return updated
  }

  restoreMemory(id: string, at: string = this.nowIso()): MemoryRecord {
    this.assertOpen()
    const current = this.getMemory(id)
    if (current === null) {
      throw new StorageError('REFERENCE_MISSING', `memory "${id}" does not exist`)
    }
    if (current.status !== 'deleted') return current
    const now = Date.parse(validateInstant(at, 'memory.restoreAt'))
    if (current.purgeAfter === null || now > Date.parse(current.purgeAfter)) {
      throw new StorageError(
        'RECORD_INVALID',
        'memory trash retention has expired; restore is no longer available',
      )
    }
    this.assertBodyAvailable(current.contentRef, 'memory.contentRef')
    if (current.quoteRef !== null) {
      this.assertBodyAvailable(current.quoteRef, 'memory.quoteRef')
    }
    const previousRow = this.db.prepare(
      'SELECT previous_status FROM memories WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    const storedPreviousStatus = previousRow?.previous_status
    if (
      storedPreviousStatus !== 'candidate' &&
      storedPreviousStatus !== 'active' &&
      storedPreviousStatus !== 'replaced'
    ) {
      throw new StorageIntegrityError(
        `deleted memory "${id}" has no valid previous_status`,
        ':memories:',
      )
    }
    const previousStatus = storedPreviousStatus
    const restored = validateMemoryRecord({
      ...current,
      status: previousStatus,
      deletedAt: null,
      purgeAfter: null,
    })
    this.inTransaction(() => {
      this.updateMemoryRow(restored, null)
    })
    return restored
  }

  purgeMemory(id: string, at: string = this.nowIso()): PurgeResult {
    return this.purge({ targetType: 'memory', targetId: id }, at)
  }

  purgeExpiredTrash(at: string = this.nowIso()): number {
    this.assertOpen()
    const timestamp = validateInstant(at, 'memory.purgeAt')
    const rows = this.db.prepare(
      `SELECT id FROM memories
       WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?
       ORDER BY id`,
    ).all(timestamp) as Array<Record<string, unknown>>
    let purged = 0
    for (const row of rows) {
      if (typeof row.id !== 'string') {
        throw new StorageIntegrityError('memory id is not text', ':memories:')
      }
      this.purge({ targetType: 'memory', targetId: row.id }, timestamp)
      purged += 1
    }
    return purged
  }

  putOutbox(input: OutboxRecord): OutboxRecord {
    this.assertOpen()
    const record = validateOutboxRecord(input)
    this.assertNotTombstoned('outbox', record.id)
    this.assertBodyAvailable(record.payloadRef, 'outbox.payloadRef')
    try {
      this.db.prepare(
        `INSERT INTO outbox
          (id, target, payload_ref, kind, status, due_at, created_at,
           updated_at, attempts, max_attempts, last_error_code,
           delivered_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.target,
        record.payloadRef,
        record.kind,
        record.status,
        record.dueAt,
        record.createdAt,
        record.updatedAt,
        record.attempts,
        record.maxAttempts,
        record.lastErrorCode,
        record.deliveredMessageId,
      )
    } catch (error) {
      throw mapInsertError(error, 'outbox', record.id)
    }
    return record
  }

  getOutbox(id: string): OutboxRecord | null {
    this.assertOpen()
    validateIdentifier(id, 'outbox.id')
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? null : outboxFromRow(row)
  }

  getInitiativeState(): InitiativeStateRecord {
    this.assertOpen()
    const row = this.db.prepare(
      'SELECT * FROM initiative_state WHERE id = 1',
    ).get() as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new StorageIntegrityError(
        'initiative_state singleton row is missing',
        ':initiative_state:',
      )
    }
    return initiativeStateFromRow(row)
  }

  updateInitiativeState(
    input: UpdateInitiativeStateInput,
  ): InitiativeStateRecord {
    this.assertOpen()
    const current = this.getInitiativeState()
    const updatedAt = validateInstant(
      input.updatedAt ?? this.nowIso(),
      'initiativeState.updatedAt',
    )
    const next: InitiativeStateRecord = {
      lastTickAt: input.lastTickAt === undefined
        ? current.lastTickAt
        : nullableInstant(input.lastTickAt, 'initiativeState.lastTickAt'),
      nextProactiveAt: input.nextProactiveAt === undefined
        ? current.nextProactiveAt
        : nullableInstant(
            input.nextProactiveAt,
            'initiativeState.nextProactiveAt',
          ),
      lastProactiveAt: input.lastProactiveAt === undefined
        ? current.lastProactiveAt
        : nullableInstant(
            input.lastProactiveAt,
            'initiativeState.lastProactiveAt',
          ),
      consecutiveUnanswered:
        input.consecutiveUnanswered === undefined
          ? current.consecutiveUnanswered
          : validateNonNegativeInteger(
              input.consecutiveUnanswered,
              'initiativeState.consecutiveUnanswered',
            ),
      circuitOpenedAt: input.circuitOpenedAt === undefined
        ? current.circuitOpenedAt
        : nullableInstant(
            input.circuitOpenedAt,
            'initiativeState.circuitOpenedAt',
          ),
      lastDailyPlanDay: input.lastDailyPlanDay === undefined
        ? current.lastDailyPlanDay
        : nullableLocalDay(
            input.lastDailyPlanDay,
            'initiativeState.lastDailyPlanDay',
          ),
      lastDailyReviewDay: input.lastDailyReviewDay === undefined
        ? current.lastDailyReviewDay
        : nullableLocalDay(
            input.lastDailyReviewDay,
            'initiativeState.lastDailyReviewDay',
          ),
      lastReviewAttemptDay: input.lastReviewAttemptDay === undefined
        ? current.lastReviewAttemptDay
        : nullableLocalDay(
            input.lastReviewAttemptDay,
            'initiativeState.lastReviewAttemptDay',
          ),
      dailyReviewAttempts: input.dailyReviewAttempts === undefined
        ? current.dailyReviewAttempts
        : validateNonNegativeInteger(
            input.dailyReviewAttempts,
            'initiativeState.dailyReviewAttempts',
          ),
      lastTrashPurgeDay: input.lastTrashPurgeDay === undefined
        ? current.lastTrashPurgeDay
        : nullableLocalDay(
            input.lastTrashPurgeDay,
            'initiativeState.lastTrashPurgeDay',
          ),
      updatedAt,
    }
    this.db.prepare(
      `UPDATE initiative_state SET
         last_tick_at = ?, next_proactive_at = ?, last_proactive_at = ?,
         consecutive_unanswered = ?, circuit_opened_at = ?,
         last_daily_plan_day = ?, last_daily_review_day = ?,
         last_review_attempt_day = ?, daily_review_attempts = ?,
         last_trash_purge_day = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      next.lastTickAt,
      next.nextProactiveAt,
      next.lastProactiveAt,
      next.consecutiveUnanswered,
      next.circuitOpenedAt,
      next.lastDailyPlanDay,
      next.lastDailyReviewDay,
      next.lastReviewAttemptDay,
      next.dailyReviewAttempts,
      next.lastTrashPurgeDay,
      next.updatedAt,
    )
    return this.getInitiativeState()
  }

  putDailyPlan(input: PutDailyPlanInput): DailyPlanRecord {
    this.assertOpen()
    const localDay = validateLocalDay(input.localDay, 'dailyPlan.localDay')
    const createdAt = validateInstant(
      input.createdAt ?? this.nowIso(),
      'dailyPlan.createdAt',
    )
    if (!Array.isArray(input.items) || input.items.length < 1) {
      invalid('dailyPlan.items', 'expected at least one plan item')
    }
    if (input.items.length > 12) {
      invalid('dailyPlan.items', 'expected at most 12 plan items')
    }
    const positions = new Set<number>()
    const prepared = input.items.map((item, index) => {
      const id = validateIdentifier(item.id, `dailyPlan.items[${index}].id`)
      validatePositiveInteger(
        item.position,
        `dailyPlan.items[${index}].position`,
      )
      if (positions.has(item.position)) {
        invalid(
          `dailyPlan.items[${index}].position`,
          'duplicate plan position',
        )
      }
      positions.add(item.position)
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(item.kind)) {
        invalid(
          `dailyPlan.items[${index}].kind`,
          'expected a lowercase kind',
        )
      }
      const startsAt = validateInstant(
        item.startsAt,
        `dailyPlan.items[${index}].startsAt`,
      )
      const endsAt = validateInstant(
        item.endsAt,
        `dailyPlan.items[${index}].endsAt`,
      )
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        invalid(
          `dailyPlan.items[${index}].endsAt`,
          'must be later than startsAt',
        )
      }
      if (
        localDateKey(new Date(startsAt), this.options.timezone) !== localDay ||
        localDateKey(new Date(endsAt), this.options.timezone) !== localDay
      ) {
        invalid(
          `dailyPlan.items[${index}].startsAt`,
          'plan item must stay inside its local day',
        )
      }
      return {
        id,
        position: item.position,
        kind: item.kind,
        title: normalizeChatText(
          item.title,
          `dailyPlan.items[${index}].title`,
        ),
        startsAt,
        endsAt,
      }
    })

    this.inTransaction(() => {
      try {
        for (const item of prepared) {
          const bodyId = `body-plan-${randomUUID()}`
          this.db.prepare(
            'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
          ).run(bodyId, 'daily_plan_item', item.title, createdAt)
          this.db.prepare(
            `INSERT INTO life_plan_items
              (id, local_day, position, kind, title_ref, starts_at, ends_at,
               status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
          ).run(
            item.id,
            localDay,
            item.position,
            item.kind,
            bodyId,
            item.startsAt,
            item.endsAt,
            createdAt,
          )
        }
      } catch (error) {
        throw mapInsertError(error, 'daily plan', localDay)
      }
    })
    const plan = this.getDailyPlan(localDay)
    if (plan === null) {
      throw new StorageIntegrityError(
        `daily plan "${localDay}" disappeared during creation`,
        ':life_plan_items:',
      )
    }
    return plan
  }

  getDailyPlan(localDay: string): DailyPlanRecord | null {
    this.assertOpen()
    const day = validateLocalDay(localDay, 'dailyPlan.localDay')
    const rows = this.db.prepare(
      `SELECT id, local_day, position, kind, title_ref, starts_at, ends_at,
              status, created_at
       FROM life_plan_items
       WHERE local_day = ?
       ORDER BY position`,
    ).all(day) as Array<Record<string, unknown>>
    if (rows.length === 0) return null
    const items = rows.map(dailyPlanItemFromRow)
    return {
      localDay: day,
      createdAt: items[0]?.createdAt ?? this.nowIso(),
      items,
    }
  }

  setDailyPlanItemStatus(
    id: string,
    status: 'planned' | 'active' | 'completed' | 'skipped',
  ): DailyPlanItemRecord {
    this.assertOpen()
    const itemId = validateIdentifier(id, 'dailyPlanItem.id')
    if (
      status !== 'planned' &&
      status !== 'active' &&
      status !== 'completed' &&
      status !== 'skipped'
    ) {
      invalid('dailyPlanItem.status', 'unsupported status')
    }
    const result = this.db.prepare(
      'UPDATE life_plan_items SET status = ? WHERE id = ?',
    ).run(status, itemId)
    if (Number(result.changes) !== 1) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `daily plan item "${itemId}" does not exist`,
      )
    }
    const row = this.db.prepare(
      `SELECT id, local_day, position, kind, title_ref, starts_at, ends_at,
              status, created_at
       FROM life_plan_items WHERE id = ?`,
    ).get(itemId) as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new StorageIntegrityError(
        `daily plan item "${itemId}" disappeared after update`,
        ':life_plan_items:',
      )
    }
    return dailyPlanItemFromRow(row)
  }

  putReminderCandidate(
    input: PutReminderCandidateInput,
  ): ReminderCandidateRecord {
    this.assertOpen()
    const text = normalizeChatText(input.text, 'reminderCandidate.text')
    const dueAt = validateInstant(input.dueAt, 'reminderCandidate.dueAt')
    const sourceMessageId = validateIdentifier(
      input.sourceMessageId,
      'reminderCandidate.sourceMessageId',
    )
    const source = this.getChatMessage(sourceMessageId)
    if (source === null || source.role !== 'user') {
      throw new StorageError(
        'REFERENCE_MISSING',
        'reminder candidate source must be an existing user message',
      )
    }
    const createdAt = validateInstant(
      input.createdAt ?? this.nowIso(),
      'reminderCandidate.createdAt',
    )
    const id = validateIdentifier(
      input.id ?? `reminder-candidate-${randomUUID()}`,
      'reminderCandidate.id',
    )
    const bodyRef = `body-reminder-candidate-${randomUUID()}`

    this.inTransaction(() => {
      try {
        this.db.prepare(
          'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
        ).run(bodyRef, 'reminder_candidate', text, createdAt)
        this.db.prepare(
          `INSERT INTO reminder_candidates
            (id, body_ref, due_at, status, created_at, source_message_id,
             confirmed_reminder_id)
           VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
        ).run(id, bodyRef, dueAt, createdAt, sourceMessageId)
      } catch (error) {
        throw mapInsertError(error, 'reminder candidate', id)
      }
    })
    const created = this.getReminderCandidate(id)
    if (created === null) {
      throw new StorageIntegrityError(
        `reminder candidate "${id}" disappeared during creation`,
        ':reminder_candidates:',
      )
    }
    return created
  }

  getReminderCandidate(id: string): ReminderCandidateRecord | null {
    this.assertOpen()
    const candidateId = validateIdentifier(id, 'reminderCandidate.id')
    const row = this.db.prepare(
      'SELECT * FROM reminder_candidates WHERE id = ?',
    ).get(candidateId) as Record<string, unknown> | undefined
    return row === undefined ? null : reminderCandidateFromRow(row)
  }

  listReminderCandidates(
    status: ReminderCandidateStatus | 'all' = 'pending',
    limit = 50,
  ): ReminderCandidateRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'reminder candidate')
    if (
      status !== 'pending' &&
      status !== 'confirmed' &&
      status !== 'rejected' &&
      status !== 'all'
    ) {
      invalid('reminderCandidate.status', 'unsupported status')
    }
    const rows = status === 'all'
      ? this.db.prepare(
          `SELECT * FROM reminder_candidates
           ORDER BY created_at DESC LIMIT ?`,
        ).all(limit)
      : this.db.prepare(
          `SELECT * FROM reminder_candidates
           WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        ).all(status, limit)
    return (rows as Array<Record<string, unknown>>).map(
      reminderCandidateFromRow,
    )
  }

  confirmReminderCandidate(
    id: string,
    at: string = this.nowIso(),
  ): ConfirmReminderCandidateResult {
    this.assertOpen()
    const candidateId = validateIdentifier(id, 'reminderCandidate.id')
    const confirmedAt = validateInstant(at, 'reminder.confirmedAt')
    const reminderId = `reminder-${randomUUID()}`
    this.inTransaction(() => {
      const candidate = this.getReminderCandidate(candidateId)
      if (candidate === null) {
        throw new StorageError(
          'REFERENCE_MISSING',
          `reminder candidate "${candidateId}" does not exist`,
        )
      }
      if (candidate.status !== 'pending') {
        throw new StorageError(
          'RECORD_INVALID',
          `reminder candidate is already ${candidate.status}`,
        )
      }
      this.db.prepare(
        `INSERT INTO reminders
          (id, body_ref, due_at, status, created_at, confirmed_at,
           delivered_at, outbox_id)
         VALUES (?, ?, ?, 'confirmed', ?, ?, NULL, NULL)`,
      ).run(
        reminderId,
        candidate.bodyRef,
        candidate.dueAt,
        confirmedAt,
        confirmedAt,
      )
      this.db.prepare(
        `UPDATE reminder_candidates
         SET status = 'confirmed', confirmed_reminder_id = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(reminderId, candidateId)
    })
    const candidate = this.getReminderCandidate(candidateId)
    const reminder = this.getReminder(reminderId)
    if (
      candidate === null ||
      candidate.status !== 'confirmed' ||
      reminder === null
    ) {
      throw new StorageIntegrityError(
        'reminder candidate confirmation did not commit consistently',
        ':reminder_candidates:',
      )
    }
    return { candidate, reminder }
  }

  rejectReminderCandidate(id: string): ReminderCandidateRecord {
    this.assertOpen()
    const candidateId = validateIdentifier(id, 'reminderCandidate.id')
    const result = this.db.prepare(
      `UPDATE reminder_candidates SET status = 'rejected'
       WHERE id = ? AND status = 'pending'`,
    ).run(candidateId)
    if (Number(result.changes) !== 1) {
      throw new StorageError(
        'RECORD_INVALID',
        'reminder candidate is missing or is no longer pending',
      )
    }
    const candidate = this.getReminderCandidate(candidateId)
    if (candidate === null) {
      throw new StorageIntegrityError(
        `reminder candidate "${candidateId}" disappeared after rejection`,
        ':reminder_candidates:',
      )
    }
    return candidate
  }

  getReminder(id: string): ReminderRecord | null {
    this.assertOpen()
    const reminderId = validateIdentifier(id, 'reminder.id')
    const row = this.db.prepare(
      'SELECT * FROM reminders WHERE id = ?',
    ).get(reminderId) as Record<string, unknown> | undefined
    return row === undefined ? null : reminderFromRow(row)
  }

  listReminders(
    status: ReminderStatus | 'all' = 'all',
    limit = 50,
  ): ReminderRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'reminder')
    if (
      status !== 'confirmed' &&
      status !== 'queued' &&
      status !== 'delivered' &&
      status !== 'cancelled' &&
      status !== 'failed' &&
      status !== 'all'
    ) {
      invalid('reminder.status', 'unsupported status')
    }
    const rows = status === 'all'
      ? this.db.prepare(
          `SELECT * FROM reminders
           ORDER BY due_at DESC LIMIT ?`,
        ).all(limit)
      : this.db.prepare(
          `SELECT * FROM reminders
           WHERE status = ? ORDER BY due_at ASC LIMIT ?`,
        ).all(status, limit)
    return (rows as Array<Record<string, unknown>>).map(reminderFromRow)
  }

  listDueReminders(
    now: string = this.nowIso(),
    limit = 50,
  ): ReminderRecord[] {
    this.assertOpen()
    const timestamp = validateInstant(now, 'reminder.now')
    assertAuditLimit(limit, 'reminder')
    const rows = this.db.prepare(
      `SELECT * FROM reminders
       WHERE status = 'confirmed' AND due_at <= ?
       ORDER BY due_at ASC LIMIT ?`,
    ).all(timestamp, limit) as Array<Record<string, unknown>>
    return rows.map(reminderFromRow)
  }

  queueReminderOutbox(
    id: string,
    at: string = this.nowIso(),
    maxAttempts = 5,
  ): OutboxRecord {
    this.assertOpen()
    const reminderId = validateIdentifier(id, 'reminder.id')
    const createdAt = validateInstant(at, 'reminder.queueAt')
    validatePositiveInteger(maxAttempts, 'outbox.maxAttempts')
    const outboxId = `outbox-reminder-${randomUUID()}`
    this.inTransaction(() => {
      const reminder = this.getReminder(reminderId)
      if (reminder === null) {
        throw new StorageError(
          'REFERENCE_MISSING',
          `reminder "${reminderId}" does not exist`,
        )
      }
      if (reminder.status !== 'confirmed') {
        throw new StorageError(
          'RECORD_INVALID',
          `reminder is already ${reminder.status}`,
        )
      }
      this.db.prepare(
        `INSERT INTO outbox
          (id, target, payload_ref, kind, status, due_at, created_at,
           updated_at, attempts, max_attempts, last_error_code,
           delivered_message_id)
         VALUES (?, 'web:owner', ?, 'reminder', 'pending', ?, ?, ?,
                 0, ?, NULL, NULL)`,
      ).run(
        outboxId,
        reminder.bodyRef,
        createdAt,
        createdAt,
        createdAt,
        maxAttempts,
      )
      this.db.prepare(
        `UPDATE reminders
         SET status = 'queued', outbox_id = ?
         WHERE id = ? AND status = 'confirmed'`,
      ).run(outboxId, reminderId)
    })
    const outbox = this.getOutbox(outboxId)
    if (outbox === null) {
      throw new StorageIntegrityError(
        `reminder outbox "${outboxId}" disappeared during creation`,
        ':outbox:',
      )
    }
    return outbox
  }

  cancelReminder(id: string): ReminderRecord {
    this.assertOpen()
    const reminderId = validateIdentifier(id, 'reminder.id')
    this.inTransaction(() => {
      const reminder = this.getReminder(reminderId)
      if (reminder === null) {
        throw new StorageError(
          'REFERENCE_MISSING',
          `reminder "${reminderId}" does not exist`,
        )
      }
      if (reminder.status === 'delivered' || reminder.status === 'cancelled') {
        throw new StorageError(
          'RECORD_INVALID',
          `reminder is already ${reminder.status}`,
        )
      }
      if (reminder.outboxId !== null) {
        const outbox = this.getOutbox(reminder.outboxId)
        if (outbox?.status === 'sending') {
          throw new StorageError(
            'RECORD_INVALID',
            'reminder is currently being delivered',
          )
        }
        this.db.prepare(
          `UPDATE outbox SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'failed', 'unknown')`,
        ).run(this.nowIso(), reminder.outboxId)
      }
      this.db.prepare(
        `UPDATE reminders SET status = 'cancelled' WHERE id = ?`,
      ).run(reminderId)
    })
    const cancelled = this.getReminder(reminderId)
    if (cancelled === null) {
      throw new StorageIntegrityError(
        `reminder "${reminderId}" disappeared after cancellation`,
        ':reminders:',
      )
    }
    return cancelled
  }

  putCareItem(input: PutCareItemInput): CareItemRecord {
    this.assertOpen()
    const text = normalizeChatText(input.text, 'careItem.text')
    const sourceMessageId = validateIdentifier(
      input.sourceMessageId,
      'careItem.sourceMessageId',
    )
    const source = this.getChatMessage(sourceMessageId)
    if (source === null || source.role !== 'user') {
      throw new StorageError(
        'REFERENCE_MISSING',
        'care item source must be an existing user message',
      )
    }
    const dueFrom = validateInstant(input.dueFrom, 'careItem.dueFrom')
    const dueUntil = validateInstant(input.dueUntil, 'careItem.dueUntil')
    if (Date.parse(dueUntil) <= Date.parse(dueFrom)) {
      invalid('careItem.dueUntil', 'must be later than dueFrom')
    }
    const createdAt = validateInstant(
      input.createdAt ?? this.nowIso(),
      'careItem.createdAt',
    )
    const id = validateIdentifier(
      input.id ?? `care-${randomUUID()}`,
      'careItem.id',
    )
    const bodyRef = `body-care-${randomUUID()}`
    this.inTransaction(() => {
      try {
        this.db.prepare(
          'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
        ).run(bodyRef, 'care_item', text, createdAt)
        this.db.prepare(
          `INSERT INTO care_items
            (id, source_message_id, body_ref, due_from, due_until, status,
             created_at, delivered_at, outbox_id)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
        ).run(id, sourceMessageId, bodyRef, dueFrom, dueUntil, createdAt)
      } catch (error) {
        throw mapInsertError(error, 'care item', id)
      }
    })
    const created = this.getCareItem(id)
    if (created === null) {
      throw new StorageIntegrityError(
        `care item "${id}" disappeared during creation`,
        ':care_items:',
      )
    }
    return created
  }

  getCareItem(id: string): CareItemRecord | null {
    this.assertOpen()
    const careId = validateIdentifier(id, 'careItem.id')
    const row = this.db.prepare(
      'SELECT * FROM care_items WHERE id = ?',
    ).get(careId) as Record<string, unknown> | undefined
    return row === undefined ? null : careItemFromRow(row)
  }

  listCareItems(
    status: CareItemStatus | 'all' = 'all',
    limit = 50,
  ): CareItemRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'care item')
    if (
      status !== 'pending' &&
      status !== 'queued' &&
      status !== 'delivered' &&
      status !== 'dismissed' &&
      status !== 'expired' &&
      status !== 'all'
    ) {
      invalid('careItem.status', 'unsupported status')
    }
    const rows = status === 'all'
      ? this.db.prepare(
          `SELECT * FROM care_items
           ORDER BY created_at DESC LIMIT ?`,
        ).all(limit)
      : this.db.prepare(
          `SELECT * FROM care_items
           WHERE status = ? ORDER BY due_from ASC LIMIT ?`,
        ).all(status, limit)
    return (rows as Array<Record<string, unknown>>).map(careItemFromRow)
  }

  listDueCareItems(
    now: string = this.nowIso(),
    limit = 50,
  ): CareItemRecord[] {
    this.assertOpen()
    const timestamp = validateInstant(now, 'careItem.now')
    assertAuditLimit(limit, 'care item')
    const rows = this.db.prepare(
      `SELECT * FROM care_items
       WHERE status = 'pending' AND due_from <= ? AND due_until > ?
       ORDER BY due_from ASC LIMIT ?`,
    ).all(timestamp, timestamp, limit) as Array<Record<string, unknown>>
    return rows.map(careItemFromRow)
  }

  expireCareItems(now: string = this.nowIso()): number {
    this.assertOpen()
    const timestamp = validateInstant(now, 'careItem.now')
    const result = this.db.prepare(
      `UPDATE care_items SET status = 'expired'
       WHERE status = 'pending' AND due_until <= ?`,
    ).run(timestamp)
    return Number(result.changes)
  }

  putDailySummary(input: PutDailySummaryInput): DailySummaryRecord {
    this.assertOpen()
    const localDay = validateLocalDay(input.localDay, 'dailySummary.localDay')
    const summary = normalizeChatText(input.summary, 'dailySummary.summary')
    if (!Array.isArray(input.sourceMessageIds)) {
      invalid('dailySummary.sourceMessageIds', 'expected an array')
    }
    const sourceIds = [...new Set(input.sourceMessageIds)]
    if (sourceIds.length > 1_000) {
      invalid(
        'dailySummary.sourceMessageIds',
        'expected at most 1000 source messages',
      )
    }
    for (const sourceId of sourceIds) {
      validateIdentifier(sourceId, 'dailySummary.sourceMessageIds')
    }
    const createdAt = validateInstant(
      input.createdAt ?? this.nowIso(),
      'dailySummary.createdAt',
    )
    const id = `daily-summary-${randomUUID()}`
    const bodyRef = `body-daily-summary-${randomUUID()}`
    this.inTransaction(() => {
      try {
        this.db.prepare(
          'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
        ).run(bodyRef, 'daily_summary', summary, createdAt)
        this.db.prepare(
          `INSERT INTO daily_summaries
            (id, local_day, body_ref, source_refs_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          id,
          localDay,
          bodyRef,
          canonicalJson(sourceIds),
          createdAt,
        )
      } catch (error) {
        throw mapInsertError(error, 'daily summary', localDay)
      }
    })
    const created = this.getDailySummary(localDay)
    if (created === null) {
      throw new StorageIntegrityError(
        `daily summary "${localDay}" disappeared during creation`,
        ':daily_summaries:',
      )
    }
    return created
  }

  getDailySummary(localDay: string): DailySummaryRecord | null {
    this.assertOpen()
    const day = validateLocalDay(localDay, 'dailySummary.localDay')
    const row = this.db.prepare(
      'SELECT * FROM daily_summaries WHERE local_day = ?',
    ).get(day) as Record<string, unknown> | undefined
    return row === undefined ? null : dailySummaryFromRow(row)
  }

  listDailySummaries(limit = 30): DailySummaryRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'daily summary')
    const rows = this.db.prepare(
      `SELECT * FROM daily_summaries
       ORDER BY local_day DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(dailySummaryFromRow)
  }

  recordInitiativeRun(
    input: RecordInitiativeRunInput,
  ): InitiativeRunRecord {
    this.assertOpen()
    const kind = input.kind
    if (
      kind !== 'tick' &&
      kind !== 'daily_plan' &&
      kind !== 'daily_review' &&
      kind !== 'proactive' &&
      kind !== 'reminder' &&
      kind !== 'outbox' &&
      kind !== 'circuit'
    ) {
      invalid('initiativeRun.kind', 'unsupported kind')
    }
    const outcome = input.outcome
    if (
      outcome !== 'allowed' &&
      outcome !== 'sent' &&
      outcome !== 'skipped' &&
      outcome !== 'failed'
    ) {
      invalid('initiativeRun.outcome', 'unsupported outcome')
    }
    const occurredAt = validateInstant(
      input.occurredAt ?? this.nowIso(),
      'initiativeRun.occurredAt',
    )
    const detailCode = validateReasonCode(
      input.detailCode,
      'initiativeRun.detailCode',
    )
    const targetId = input.targetId === undefined || input.targetId === null
      ? null
      : validateIdentifier(input.targetId, 'initiativeRun.targetId')
    const id = validateIdentifier(
      input.id ?? `initiative-run-${randomUUID()}`,
      'initiativeRun.id',
    )
    try {
      this.db.prepare(
        `INSERT INTO initiative_runs
          (id, occurred_at, kind, outcome, detail_code, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, occurredAt, kind, outcome, detailCode, targetId)
    } catch (error) {
      throw mapInsertError(error, 'initiative run', id)
    }
    const row = this.db.prepare(
      'SELECT * FROM initiative_runs WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new StorageIntegrityError(
        `initiative run "${id}" disappeared during creation`,
        ':initiative_runs:',
      )
    }
    return initiativeRunFromRow(row)
  }

  listInitiativeRuns(limit = 50): InitiativeRunRecord[] {
    this.assertOpen()
    assertAuditLimit(limit, 'initiative run')
    const rows = this.db.prepare(
      `SELECT * FROM initiative_runs
       ORDER BY occurred_at DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(initiativeRunFromRow)
  }

  enqueueOutbox(input: EnqueueOutboxInput): OutboxRecord {
    this.assertOpen()
    const text = normalizeChatText(input.text, 'outbox.text')
    if (!OUTBOX_KINDS.includes(input.kind)) {
      invalid('outbox.kind', 'unsupported kind')
    }
    if (input.kind === 'legacy') {
      invalid('outbox.kind', 'new outbox rows cannot use the legacy kind')
    }
    if (
      input.target.length === 0 ||
      input.target.length > 512 ||
      input.target.includes('\0')
    ) {
      invalid('outbox.target', 'expected 1..512 characters without NUL')
    }
    validatePositiveInteger(input.maxAttempts, 'outbox.maxAttempts')
    const createdAt = validateInstant(
      input.createdAt ?? this.nowIso(),
      'outbox.createdAt',
    )
    const dueAt = input.dueAt === undefined || input.dueAt === null
      ? null
      : validateInstant(input.dueAt, 'outbox.dueAt')
    const id = validateIdentifier(
      input.id ?? `outbox-${randomUUID()}`,
      'outbox.id',
    )
    const careItemIds = [...new Set(input.careItemIds ?? [])]
    for (const careItemId of careItemIds) {
      validateIdentifier(careItemId, 'outbox.careItemIds')
    }
    const payloadRef = `body-outbox-${randomUUID()}`

    this.inTransaction(() => {
      try {
        this.db.prepare(
          'INSERT INTO bodies (id, kind, content, created_at) VALUES (?, ?, ?, ?)',
        ).run(payloadRef, `outbox_${input.kind}`, text, createdAt)
        this.db.prepare(
          `INSERT INTO outbox
            (id, target, payload_ref, kind, status, due_at, created_at,
             updated_at, attempts, max_attempts, last_error_code,
             delivered_message_id)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, NULL, NULL)`,
        ).run(
          id,
          input.target,
          payloadRef,
          input.kind,
          dueAt,
          createdAt,
          createdAt,
          input.maxAttempts,
        )
        for (const careItemId of careItemIds) {
          const result = this.db.prepare(
            `UPDATE care_items SET status = 'queued', outbox_id = ?
             WHERE id = ? AND status = 'pending'`,
          ).run(id, careItemId)
          if (Number(result.changes) !== 1) {
            throw new StorageError(
              'RECORD_INVALID',
              `care item "${careItemId}" is missing or not pending`,
            )
          }
        }
      } catch (error) {
        if (error instanceof StorageError) throw error
        throw mapInsertError(error, 'outbox', id)
      }
    })
    const outbox = this.getOutbox(id)
    if (outbox === null) {
      throw new StorageIntegrityError(
        `outbox "${id}" disappeared during creation`,
        ':outbox:',
      )
    }
    return outbox
  }

  listDueOutbox(
    now: string = this.nowIso(),
    limit = 50,
    kind?: OutboxKind,
  ): OutboxRecord[] {
    this.assertOpen()
    const timestamp = validateInstant(now, 'outbox.now')
    assertAuditLimit(limit, 'outbox')
    if (kind !== undefined && !OUTBOX_KINDS.includes(kind)) {
      invalid('outbox.kind', 'unsupported kind')
    }
    const rows = kind === undefined
      ? this.db.prepare(
          `SELECT * FROM outbox
           WHERE status IN ('pending', 'failed')
             AND attempts < max_attempts
             AND (due_at IS NULL OR due_at <= ?)
           ORDER BY created_at ASC LIMIT ?`,
        ).all(timestamp, limit)
      : this.db.prepare(
          `SELECT * FROM outbox
           WHERE status IN ('pending', 'failed')
             AND kind = ?
             AND attempts < max_attempts
             AND (due_at IS NULL OR due_at <= ?)
           ORDER BY created_at ASC LIMIT ?`,
        ).all(kind, timestamp, limit)
    return (rows as Array<Record<string, unknown>>).map(outboxFromRow)
  }

  claimOutbox(id: string, at: string = this.nowIso()): OutboxRecord {
    this.assertOpen()
    const outboxId = validateIdentifier(id, 'outbox.id')
    const claimedAt = validateInstant(at, 'outbox.claimedAt')
    const result = this.db.prepare(
      `UPDATE outbox
       SET status = 'sending', attempts = attempts + 1, updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'failed')
         AND attempts < max_attempts
         AND (due_at IS NULL OR due_at <= ?)`,
    ).run(claimedAt, outboxId, claimedAt)
    if (Number(result.changes) !== 1) {
      throw new StorageError(
        'RECORD_INVALID',
        `outbox "${outboxId}" is not claimable`,
      )
    }
    const claimed = this.getOutbox(outboxId)
    if (claimed === null) {
      throw new StorageIntegrityError(
        `outbox "${outboxId}" disappeared after claim`,
        ':outbox:',
      )
    }
    return claimed
  }

  markOutboxFailure(
    id: string,
    errorCode: string,
    at: string = this.nowIso(),
    retryAt: string | null = null,
  ): OutboxRecord {
    this.assertOpen()
    const outboxId = validateIdentifier(id, 'outbox.id')
    const code = validateReasonCode(errorCode, 'outbox.errorCode')
    const updatedAt = validateInstant(at, 'outbox.updatedAt')
    const nextDueAt = retryAt === null
      ? null
      : validateInstant(retryAt, 'outbox.retryAt')
    this.inTransaction(() => {
      const result = this.db.prepare(
        `UPDATE outbox
         SET status = 'failed', last_error_code = ?, updated_at = ?, due_at = ?
         WHERE id = ? AND status = 'sending'`,
      ).run(code, updatedAt, nextDueAt, outboxId)
      if (Number(result.changes) !== 1) {
        throw new StorageError(
          'RECORD_INVALID',
          `outbox "${outboxId}" is not sending`,
        )
      }
      const failed = this.requireOutbox(outboxId)
      if (failed.attempts >= failed.maxAttempts) {
        this.releaseUndeliveredDependents(failed, updatedAt)
      }
    })
    return this.requireOutbox(outboxId)
  }

  markOutboxUnknown(
    id: string,
    errorCode: string,
    at: string = this.nowIso(),
  ): OutboxRecord {
    this.assertOpen()
    const outboxId = validateIdentifier(id, 'outbox.id')
    const code = validateReasonCode(errorCode, 'outbox.errorCode')
    const updatedAt = validateInstant(at, 'outbox.updatedAt')
    const result = this.db.prepare(
      `UPDATE outbox
       SET status = 'unknown', last_error_code = ?, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    ).run(code, updatedAt, outboxId)
    if (Number(result.changes) !== 1) {
      throw new StorageError(
        'RECORD_INVALID',
        `outbox "${outboxId}" is not sending`,
      )
    }
    return this.requireOutbox(outboxId)
  }

  recoverStaleOutbox(
    staleBefore: string,
    at: string = this.nowIso(),
  ): number {
    this.assertOpen()
    const before = validateInstant(staleBefore, 'outbox.staleBefore')
    const updatedAt = validateInstant(at, 'outbox.updatedAt')
    const result = this.db.prepare(
      `UPDATE outbox
       SET status = 'failed', last_error_code = 'stale_sending',
           updated_at = ?, due_at = ?
       WHERE status = 'sending' AND updated_at < ?`,
    ).run(updatedAt, updatedAt, before)
    return Number(result.changes)
  }

  expireOutbox(
    createdBefore: string,
    at: string = this.nowIso(),
  ): number {
    this.assertOpen()
    const cutoff = validateInstant(createdBefore, 'outbox.createdBefore')
    const updatedAt = validateInstant(at, 'outbox.updatedAt')
    let expired = 0
    this.inTransaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM outbox
         WHERE status IN ('pending', 'failed') AND created_at < ?`,
      ).all(cutoff) as Array<Record<string, unknown>>
      for (const row of rows) {
        const record = outboxFromRow(row)
        const result = this.db.prepare(
          `UPDATE outbox SET status = 'expired', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'failed')`,
        ).run(updatedAt, record.id)
        if (Number(result.changes) !== 1) continue
        expired += 1
        this.releaseUndeliveredDependents(record, updatedAt)
      }
    })
    return expired
  }

  expireOutboxRecord(
    id: string,
    at: string = this.nowIso(),
  ): OutboxRecord {
    this.assertOpen()
    const outboxId = validateIdentifier(id, 'outbox.id')
    const updatedAt = validateInstant(at, 'outbox.updatedAt')
    this.inTransaction(() => {
      const result = this.db.prepare(
        `UPDATE outbox SET status = 'expired', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')`,
      ).run(updatedAt, outboxId)
      if (Number(result.changes) !== 1) {
        throw new StorageError(
          'RECORD_INVALID',
          `outbox "${outboxId}" is not pending or failed`,
        )
      }
      this.releaseUndeliveredDependents(
        this.requireOutbox(outboxId),
        updatedAt,
      )
    })
    return this.requireOutbox(outboxId)
  }

  deliverOutbox(
    id: string,
    at: string = this.nowIso(),
  ): OutboxDeliveryResult {
    this.assertOpen()
    const outboxId = validateIdentifier(id, 'outbox.id')
    const createdAt = validateInstant(at, 'outbox.deliveredAt')
    const existing = this.getOutbox(outboxId)
    if (existing === null) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `outbox "${outboxId}" does not exist`,
      )
    }
    if (existing.status === 'delivered') {
      if (existing.deliveredMessageId === null) {
        throw new StorageIntegrityError(
          'delivered outbox has no delivered message',
          ':outbox:',
        )
      }
      const message = this.getChatMessage(existing.deliveredMessageId)
      if (message === null) {
        throw new StorageIntegrityError(
          'delivered outbox message is missing',
          ':outbox:',
        )
      }
      return { outbox: existing, message }
    }
    if (existing.status !== 'sending') {
      throw new StorageError(
        'RECORD_INVALID',
        `outbox is ${existing.status}, not sending`,
      )
    }

    const messageId = `message-${randomUUID()}`
    let message: ChatMessageRecord | undefined
    this.inTransaction(() => {
      const current = this.getOutbox(outboxId)
      if (current === null || current.status !== 'sending') {
        throw new StorageError(
          'RECORD_INVALID',
          'outbox changed while it was being delivered',
        )
      }
      this.ensureConversationRow('main', createdAt)
      try {
        this.db.prepare(
          `INSERT INTO messages
            (id, conversation_id, role, body_id, created_at)
           VALUES (?, 'main', 'assistant', ?, ?)`,
        ).run(messageId, current.payloadRef, createdAt)
        this.db.prepare(
          `UPDATE conversations
           SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
           WHERE id = 'main'`,
        ).run(createdAt, createdAt)
        this.db.prepare(
          `UPDATE outbox
           SET status = 'delivered', delivered_message_id = ?, updated_at = ?
           WHERE id = ? AND status = 'sending'`,
        ).run(messageId, createdAt, outboxId)
        this.db.prepare(
          `UPDATE reminders
           SET status = 'delivered', delivered_at = ?
           WHERE outbox_id = ? AND status = 'queued'`,
        ).run(createdAt, outboxId)
        this.db.prepare(
          `UPDATE care_items
           SET status = 'delivered', delivered_at = ?
           WHERE outbox_id = ? AND status = 'queued'`,
        ).run(createdAt, outboxId)
      } catch (error) {
        throw mapInsertError(error, 'outbox delivery', outboxId)
      }
      message = this.getChatMessage(messageId) ?? undefined
    })
    if (message === undefined) {
      throw new StorageIntegrityError(
        `delivered message "${messageId}" disappeared`,
        ':messages:',
      )
    }
    return {
      outbox: this.requireOutbox(outboxId),
      message,
    }
  }

  countDeliveredOutboxSince(
    kind: OutboxKind,
    since: string,
  ): number {
    this.assertOpen()
    if (!OUTBOX_KINDS.includes(kind)) {
      invalid('outbox.kind', 'unsupported kind')
    }
    const timestamp = validateInstant(since, 'outbox.since')
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = ? AND status = 'delivered' AND updated_at >= ?`,
    ).get(kind, timestamp) as Record<string, unknown> | undefined
    return Number(row?.count ?? 0)
  }

  listTombstones(): Tombstone[] {
    this.assertOpen()
    return this.readLedgerTombstones()
  }

  purge(target: PurgeTarget, at: string = this.nowIso()): PurgeResult {
    this.assertOpen()
    if (!TOMBSTONE_TARGET_TYPES.includes(target.targetType)) {
      throw new StorageError(
        'RECORD_INVALID',
        `unsupported tombstone target type "${target.targetType}"`,
      )
    }
    const targetId = validateIdentifier(target.targetId, 'purge.targetId')
    const purgedAt = validateInstant(at, 'purge.at')
    this.insertLedgerTombstone({
      schemaVersion: 1,
      targetType: target.targetType,
      targetId,
      purgedAt,
    })

    const enforcement = this.enforceTombstones(purgedAt)
    this.restoreStateFromLog()
    const snapshot = this.writeCurrentSnapshot()
    this.checkpointAndVacuum()
    this.lastSnapshotSequence = snapshot.snapshot.lastSequence
    this.lastSnapshotAt = snapshot.snapshot.generatedAt
    return {
      target: { targetType: target.targetType, targetId },
      tombstones: enforcement.tombstones,
      deletedBodies: enforcement.deletedBodies,
      deletedMessages: enforcement.deletedMessages,
      deletedMemories: enforcement.deletedMemories,
      deletedOutbox: enforcement.deletedOutbox,
      rebuiltSnapshotSequence: snapshot.snapshot.lastSequence,
    }
  }

  createBackup(now: Date = this.options.clock.now()): BackupRecord {
    this.assertOpen()
    return createBackup(
      this.db,
      this.backupDir,
      this.options.backupRetention,
      now,
    )
  }

  maybeCreateDailyBackup(now: Date = this.options.clock.now()): BackupRecord | null {
    this.assertOpen()
    if (
      hasBackupForLocalDay(
        this.backupDir,
        now,
        this.options.timezone,
      )
    ) {
      return null
    }
    return this.createBackup(now)
  }

  listBackups(): BackupRecord[] {
    this.assertOpen()
    return listBackups(this.backupDir)
  }

  checkpoint(): void {
    this.assertOpen()
    const row = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | Record<string, unknown>
      | undefined
    if (row === undefined || Number(row.busy) !== 0) {
      throw new StorageError('IO', 'WAL checkpoint is busy; old pages were not truncated')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    let firstError: unknown
    try {
      this.db.close()
    } catch (error) {
      firstError = error
    }
    try {
      this.tombstoneDb.close()
    } catch (error) {
      firstError ??= error
    }
    if (firstError !== undefined) {
      throw new StorageError(
        'IO',
        `database close failed: ${messageOf(firstError)}`,
        { cause: firstError },
      )
    }
  }

  private initialize(): void {
    const now = this.nowIso()
    const enforcement = this.enforceTombstones(now)
    this.ensureMemorySearchIndex()
    this.restoreStateFromLog()
    if (enforcement.tombstones.length > 0) {
      // 墓碑出现后旧快照可能含已删除引用，必须从被抑制的事件流重建。
      const snapshot = this.writeCurrentSnapshot()
      this.lastSnapshotSequence = snapshot.snapshot.lastSequence
      this.lastSnapshotAt = snapshot.snapshot.generatedAt
    } else {
      const latest = readLatestSnapshot(this.db)
      this.lastSnapshotSequence = latest?.snapshot.lastSequence ?? 0
      this.lastSnapshotAt =
        latest?.snapshot.generatedAt ?? this.earliestEventTime()
    }
    // 从旧备份恢复时，墓碑可能刚刚删掉旧正文；启动恢复也必须清掉 WAL/自由页。
    if (
      enforcement.deletedBodies > 0 ||
      enforcement.deletedMemories > 0 ||
      enforcement.deletedOutbox > 0
    ) {
      this.checkpointAndVacuum()
    }
  }

  private closeAfterFailedOpen(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // 原始初始化错误优先；关闭尽力而为。
    }
    try {
      this.tombstoneDb.close()
    } catch {
      // 同上。
    }
  }

  private restoreStateFromLog(): void {
    const snapshot = readLatestSnapshot(this.db)
    let state = createInitialState(this.options.lifeState)
    let startSequence = 0
    let eventId: string | null = null
    let eventAt = INITIAL_SNAPSHOT_TIME

    if (snapshot !== null) {
      state = snapshot.snapshot.state
      startSequence = snapshot.snapshot.lastSequence
      eventId = snapshot.snapshot.lastEventId
      eventAt = snapshot.snapshot.generatedAt
      if (startSequence > 0) {
        const anchor = this.db.prepare(
          'SELECT event_id, occurred_at FROM events WHERE seq = ?',
        ).get(startSequence) as Record<string, unknown> | undefined
        if (
          anchor === undefined ||
          anchor.event_id !== snapshot.snapshot.lastEventId ||
          anchor.occurred_at !== snapshot.snapshot.generatedAt
        ) {
          throw new StorageIntegrityError(
            `snapshot sequence ${startSequence} does not match the event log`,
            ':snapshots:',
          )
        }
      }
    }

    const ledger = this.readLedgerTombstones()
    const suppressedIds = new Set(ledger.map(tombstone => tombstone.targetId))
    const eventIds = new Set(
      ledger
        .filter(tombstone => tombstone.targetType === 'event')
        .map(tombstone => tombstone.targetId),
    )
    const rows = this.db.prepare(
      `SELECT seq, event_id, schema_version, occurred_at, source, event_type,
              payload_json, evidence_refs_json, confidence
       FROM events WHERE seq > ? ORDER BY seq ASC`,
    ).all(startSequence) as Array<Record<string, unknown>>

    const parsedRows = rows.map(row => {
      const rowSequence = Number(row.seq)
      return { rowSequence, event: eventFromRow(row) }
    })
    const skippedEventIds = computeSuppressedEvents(
      parsedRows,
      suppressedIds,
      eventIds,
    )

    let expected = startSequence + 1
    let sequence = startSequence
    for (const { rowSequence, event } of parsedRows) {
      if (!Number.isInteger(rowSequence) || rowSequence !== expected) {
        throw new StorageIntegrityError(
          `event sequence gap: expected ${expected}, found ${String(rowSequence)}`,
          ':events:',
        )
      }
      if (Date.parse(event.occurredAt) < Date.parse(eventAt)) {
        throw new StorageIntegrityError(
          `event ${rowSequence} moves time backwards`,
          ':events:',
        )
      }
      if (!skippedEventIds.has(event.eventId)) {
        try {
          state = reduceState(state, event, this.options.lifeState)
        } catch (error) {
          throw new StorageIntegrityError(
            `event ${rowSequence} cannot be replayed: ${messageOf(error)}`,
            ':events:',
            error,
          )
        }
      }
      sequence = rowSequence
      eventId = event.eventId
      eventAt = event.occurredAt
      expected += 1
    }

    this.state = state
    this.sequence = sequence
    this.lastEventId = eventId
    this.lastEventAt = eventAt
  }

  private enforceTombstones(cascadeTime: string): TombstoneEnforcement {
    // 墓碑先写独立库，再动主库；中途崩溃时下次启动会从固定点继续收敛。
    let iterations = 0
    while (true) {
      iterations += 1
      if (iterations > 100) {
        throw new StorageError(
          'RECORD_INVALID',
          'tombstone cascade did not converge after 100 rounds',
        )
      }
      const current = this.readLedgerTombstones()
      const keys = new Set(current.map(tombstoneKey))
      const additions: Tombstone[] = []

      for (const tombstone of current) {
        if (tombstone.targetType === 'body') {
          const memories = this.db.prepare(
            'SELECT id FROM memories WHERE content_ref = ? OR quote_ref = ?',
          ).all(tombstone.targetId, tombstone.targetId) as Array<Record<string, unknown>>
          for (const memory of memories) {
            this.queueTombstone(
              additions,
              keys,
              'memory',
              String(memory.id),
              cascadeTime,
            )
          }
          const outbox = this.db.prepare(
            'SELECT id FROM outbox WHERE payload_ref = ?',
          ).all(tombstone.targetId) as Array<Record<string, unknown>>
          for (const item of outbox) {
            this.queueTombstone(
              additions,
              keys,
              'outbox',
              String(item.id),
              cascadeTime,
            )
          }
        } else if (tombstone.targetType === 'memory') {
          const memory = this.db.prepare(
            'SELECT content_ref, quote_ref FROM memories WHERE id = ?',
          ).get(tombstone.targetId) as Record<string, unknown> | undefined
          if (memory !== undefined) {
            for (const ref of [memory.content_ref, memory.quote_ref]) {
              if (typeof ref === 'string') {
                this.queueTombstone(additions, keys, 'body', ref, cascadeTime)
              }
            }
          }
        } else if (tombstone.targetType === 'outbox') {
          const item = this.db.prepare(
            'SELECT payload_ref FROM outbox WHERE id = ?',
          ).get(tombstone.targetId) as Record<string, unknown> | undefined
          if (item !== undefined && typeof item.payload_ref === 'string') {
            this.queueTombstone(
              additions,
              keys,
              'body',
              item.payload_ref,
              cascadeTime,
            )
          }
        }
      }

      if (additions.length === 0) break
      for (const tombstone of additions) {
        this.insertLedgerTombstone(tombstone)
      }
    }

    const tombstones = this.readLedgerTombstones()
    const bodyIds = tombstones
      .filter(tombstone => tombstone.targetType === 'body')
      .map(tombstone => tombstone.targetId)
    const memoryIds = tombstones
      .filter(tombstone => tombstone.targetType === 'memory')
      .map(tombstone => tombstone.targetId)
    const outboxIds = tombstones
      .filter(tombstone => tombstone.targetType === 'outbox')
      .map(tombstone => tombstone.targetId)
    // 计数必须在删除前算：v9 的 outbox.payload_ref 有级联外键，删除正文时
    // outbox 行可能先被 SQLite 自动删掉，事后再数 changes 会得到 0。
    const deletedBodies = countExistingRows(
      this.db,
      'bodies',
      bodyIds,
    )
    let deletedMessages = 0
    for (const bodyId of bodyIds) {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE body_id = ?',
      ).get(bodyId) as Record<string, unknown> | undefined
      deletedMessages += Number(row?.count ?? 0)
    }
    const deletedMemories = countExistingRows(
      this.db,
      'memories',
      memoryIds,
    )
    const deletedOutbox = countExistingRows(
      this.db,
      'outbox',
      outboxIds,
    )
    let deletedSnapshots = 0

    this.inTransaction(() => {
      for (const tombstone of tombstones) {
        this.db.prepare(
          `INSERT OR IGNORE INTO tombstones (target_type, target_id, purged_at)
           VALUES (?, ?, ?)`,
        ).run(tombstone.targetType, tombstone.targetId, tombstone.purgedAt)
      }
      for (const tombstone of tombstones) {
        if (tombstone.targetType === 'body') {
          this.db.prepare('DELETE FROM bodies WHERE id = ?').run(tombstone.targetId)
        } else if (tombstone.targetType === 'memory') {
          this.deleteMemorySearchRow(tombstone.targetId)
          this.db.prepare('DELETE FROM memories WHERE id = ?').run(tombstone.targetId)
        } else if (tombstone.targetType === 'outbox') {
          this.db.prepare('DELETE FROM outbox WHERE id = ?').run(tombstone.targetId)
        }
      }
      if (tombstones.length > 0) {
        deletedSnapshots = deleteAllSnapshots(this.db)
      }
      // 崩溃恢复或旧备份里可能留下非 active 的索引行；启动收敛时一并清掉。
      this.db.prepare(
        `DELETE FROM memory_search
         WHERE memory_id NOT IN (
           SELECT id FROM memories WHERE status = 'active'
         )`,
      ).run()
    })

    return {
      tombstones,
      deletedBodies,
      deletedMessages,
      deletedMemories,
      deletedOutbox,
      deletedSnapshots,
    }
  }

  private queueTombstone(
    additions: Tombstone[],
    keys: Set<string>,
    targetType: TombstoneTargetType,
    targetId: string,
    purgedAt: string,
  ): void {
    const tombstone: Tombstone = {
      schemaVersion: 1,
      targetType,
      targetId: validateIdentifier(targetId, 'tombstone.targetId'),
      purgedAt,
    }
    const key = tombstoneKey(tombstone)
    if (keys.has(key)) return
    keys.add(key)
    additions.push(tombstone)
  }

  private insertLedgerTombstone(tombstone: Tombstone): void {
    const validated = validateTombstone(tombstone)
    this.tombstoneDb.prepare(
      `INSERT OR IGNORE INTO tombstones (target_type, target_id, purged_at)
       VALUES (?, ?, ?)`,
    ).run(validated.targetType, validated.targetId, validated.purgedAt)
  }

  private readLedgerTombstones(): Tombstone[] {
    const rows = this.tombstoneDb.prepare(
      `SELECT target_type, target_id, purged_at
       FROM tombstones ORDER BY target_type, target_id`,
    ).all() as Array<Record<string, unknown>>
    return rows.map(row => {
      try {
        return validateTombstone({
          schemaVersion: 1,
          targetType: row.target_type,
          targetId: row.target_id,
          purgedAt: row.purged_at,
        })
      } catch (error) {
        throw new StorageIntegrityError(
          `tombstone ledger contains an invalid row: ${messageOf(error)}`,
          this.tombstonePath,
          error,
        )
      }
    })
  }

  private writeCurrentSnapshot(): SnapshotResult {
    const snapshot = this.buildCurrentSnapshot()
    this.inTransaction(() => {
      writeSnapshot(this.db, snapshot)
    })
    this.lastSnapshotSequence = snapshot.snapshot.lastSequence
    this.lastSnapshotAt = snapshot.snapshot.generatedAt
    return snapshot
  }

  private buildCurrentSnapshot(): SnapshotResult {
    return buildSnapshot(
      this.state,
      this.sequence,
      this.lastEventId,
      this.sequence === 0 ? null : this.lastEventAt,
    )
  }

  private shouldSnapshot(nextSequence: number, eventAtMillis: number): boolean {
    const intervalMs = this.options.snapshotIntervalHours * 3_600_000
    if (this.lastSnapshotAt === null) {
      return (
        nextSequence >= this.options.snapshotEveryEvents ||
        this.options.clock.now().getTime() - this.openedAtMillis >= intervalMs
      )
    }
    if (nextSequence - this.lastSnapshotSequence >= this.options.snapshotEveryEvents) {
      return true
    }
    return eventAtMillis - Date.parse(this.lastSnapshotAt) >= intervalMs
  }

  private earliestEventTime(): string | null {
    const row = this.db.prepare(
      'SELECT occurred_at FROM events ORDER BY seq ASC LIMIT 1',
    ).get() as Record<string, unknown> | undefined
    if (row === undefined) return null
    if (typeof row.occurred_at !== 'string') {
      throw new StorageIntegrityError('event occurred_at is not text', ':events:')
    }
    validateInstant(row.occurred_at, 'event.occurredAt')
    return row.occurred_at
  }

  private assertBodyAvailable(id: string, field: string): void {
    this.assertNotTombstoned('body', id)
    const row = this.db.prepare('SELECT 1 AS ok FROM bodies WHERE id = ?').get(id)
    if (row === undefined) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `${field} references missing body "${id}"`,
      )
    }
  }

  private assertNotTombstoned(
    targetType: TombstoneTargetType,
    targetId: string,
  ): void {
    const row = this.tombstoneDb.prepare(
      'SELECT 1 AS ok FROM tombstones WHERE target_type = ? AND target_id = ?',
    ).get(targetType, targetId)
    if (row !== undefined) {
      throw new StorageError(
        'TOMBSTONED',
        `${targetType} "${targetId}" has been permanently purged`,
      )
    }
  }

  private ensureConversationRow(id: string, at: string): ConversationRecord {
    this.db.prepare(
      `INSERT OR IGNORE INTO conversations (id, created_at, updated_at)
       VALUES (?, ?, ?)`,
    ).run(id, at, at)
    const row = this.db.prepare(
      'SELECT id, created_at, updated_at FROM conversations WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new StorageIntegrityError(
        `conversation "${id}" disappeared during creation`,
        ':conversations:',
      )
    }
    return conversationFromRow(row)
  }

  private assertMessageRole(
    messageId: string,
    conversationId: string,
    role: 'user' | 'assistant',
  ): void {
    const row = this.db.prepare(
      'SELECT conversation_id, role FROM messages WHERE id = ?',
    ).get(messageId) as Record<string, unknown> | undefined
    if (
      row === undefined ||
      row.conversation_id !== conversationId ||
      row.role !== role
    ) {
      throw new StorageError(
        'REFERENCE_MISSING',
        `${role} message "${messageId}" does not belong to conversation "${conversationId}"`,
      )
    }
  }

  private updateMemoryRow(
    memory: MemoryRecord,
    previousStatus: MemoryRecord['status'] | null,
    syncSearch = true,
  ): void {
    const json = canonicalJson(memory)
    this.db.prepare(
      `UPDATE memories SET
        status = ?, previous_status = ?, last_recalled_at = ?, replaced_by = ?,
        deleted_at = ?, purge_after = ?, record_json = ?
       WHERE id = ?`,
    ).run(
      memory.status,
      previousStatus,
      memory.lastRecalledAt,
      memory.replacedBy,
      memory.deletedAt,
      memory.purgeAfter,
      json,
      memory.id,
    )
    if (syncSearch) this.syncMemorySearchRow(memory)
  }

  private prepareMemoryWrite(input: MemoryRecord): MemoryRecord {
    const memory = validateMemoryRecord(input)
    this.assertNotTombstoned('memory', memory.id)
    this.assertBodyAvailable(memory.contentRef, 'memory.contentRef')
    if (memory.quoteRef !== null) {
      this.assertBodyAvailable(memory.quoteRef, 'memory.quoteRef')
    }
    return memory
  }

  private insertMemoryRow(memory: MemoryRecord): void {
    let inserted = false
    try {
      this.db.prepare(
        `INSERT INTO memories
          (id, schema_version, kind, content_ref, quote_ref, source, created_at,
           confidence, sensitivity, importance, last_recalled_at, status, previous_status,
           replaced_by, deleted_at, purge_after, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        memory.id,
        memory.schemaVersion,
        memory.kind,
        memory.contentRef,
        memory.quoteRef,
        memory.source,
        memory.createdAt,
        memory.confidence,
        memory.sensitivity,
        memory.importance,
        memory.lastRecalledAt,
        memory.status,
        memory.replacedBy,
        memory.deletedAt,
        memory.purgeAfter,
        canonicalJson(memory),
      )
      inserted = true
      this.syncMemorySearchRow(memory)
    } catch (error) {
      if (error instanceof StorageError) throw error
      if (!inserted) throw mapInsertError(error, 'memory', memory.id)
      throw new StorageError(
        'IO',
        `memory "${memory.id}" was inserted but its search row failed: ${messageOf(error)}`,
        { cause: error, path: this.databasePath },
      )
    }
  }

  private syncMemorySearchRow(memory: MemoryRecord): void {
    this.deleteMemorySearchRow(memory.id)
    if (memory.status !== 'active') return
    const body = this.getBody(memory.contentRef)
    if (body === null) {
      throw new StorageIntegrityError(
        `active memory "${memory.id}" has no searchable body`,
        ':memories:',
      )
    }
    const columns = buildMemorySearchColumns(body.content)
    this.db.prepare(
      `INSERT INTO memory_search(memory_id, word_text, char_text)
       VALUES (?, ?, ?)`,
    ).run(memory.id, columns.wordText, columns.charText)
  }

  private deleteMemorySearchRow(memoryId: string): void {
    this.db.prepare(
      'DELETE FROM memory_search WHERE memory_id = ?',
    ).run(memoryId)
  }

  private ensureMemorySearchIndex(): void {
    const activeRows = this.db.prepare(
      "SELECT * FROM memories WHERE status = 'active' ORDER BY id",
    ).all() as Array<Record<string, unknown>>
    const indexedRows = this.db.prepare(
      'SELECT memory_id, word_text, char_text FROM memory_search',
    ).all() as Array<Record<string, unknown>>
    const indexed = new Map<string, { wordText: string; charText: string }>()
    for (const row of indexedRows) {
      if (
        typeof row.memory_id !== 'string' ||
        typeof row.word_text !== 'string' ||
        typeof row.char_text !== 'string'
      ) {
        throw new StorageIntegrityError(
          'memory search row has invalid column types',
          ':memory_search:',
        )
      }
      indexed.set(row.memory_id, {
        wordText: row.word_text,
        charText: row.char_text,
      })
    }

    this.inTransaction(() => {
      this.db.prepare(
        `DELETE FROM memory_search
         WHERE memory_id NOT IN (
           SELECT id FROM memories WHERE status = 'active'
         )`,
      ).run()
      for (const row of activeRows) {
        const memory = memoryFromRow(row)
        const body = this.getBody(memory.contentRef)
        if (body === null) {
          throw new StorageIntegrityError(
            `active memory "${memory.id}" has no searchable body`,
            ':memories:',
          )
        }
        const expected = buildMemorySearchColumns(body.content)
        const existing = indexed.get(memory.id)
        if (
          existing === undefined ||
          existing.wordText !== expected.wordText ||
          existing.charText !== expected.charText
        ) {
          this.syncMemorySearchRow(memory)
        }
      }
    })
  }

  private checkpointAndVacuum(): void {
    try {
      // VACUUM 重建页面；secure_delete 与 checkpoint 负责删除旧单元格和 WAL 残留。
      this.db.exec('VACUUM')
      const row = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
        | Record<string, unknown>
        | undefined
      if (row === undefined || Number(row.busy) !== 0) {
        throw new StorageError(
          'IO',
          'WAL checkpoint after purge is busy; plaintext could remain in WAL',
        )
      }
      quickCheckDatabase(this.db, this.databasePath)
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(
        'IO',
        `purge cleanup failed: ${messageOf(error)}`,
        { cause: error, path: this.databasePath },
      )
    }
  }

  private inTransaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 原始错误更关键；SQLite 已可能在失败时自动回滚。
      }
      if (error instanceof StorageError) throw error
      throw new StorageError(
        'IO',
        `database transaction failed: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  private requireOutbox(id: string): OutboxRecord {
    const record = this.getOutbox(id)
    if (record === null) {
      throw new StorageIntegrityError(
        `outbox "${id}" disappeared during update`,
        ':outbox:',
      )
    }
    return record
  }

  /**
   * outbox 未投递就终止时，不能把关联的关心项/提醒永久留在 queued。
   * 关心项若仍在有效窗口内就退回 pending，下一条主动消息可以再尝试；
   * 已过窗口则过期，提醒则显式失败。
   */
  private releaseUndeliveredDependents(
    outbox: OutboxRecord,
    at: string,
  ): void {
    if (outbox.kind === 'proactive') {
      this.db.prepare(
        `UPDATE care_items
         SET status = CASE WHEN due_until <= ? THEN 'expired' ELSE 'pending' END,
             outbox_id = NULL
         WHERE outbox_id = ? AND status = 'queued'`,
      ).run(at, outbox.id)
      return
    }
    if (outbox.kind === 'reminder') {
      this.db.prepare(
        `UPDATE reminders SET status = 'failed'
         WHERE outbox_id = ? AND status = 'queued'`,
      ).run(outbox.id)
    }
  }

  private nowIso(): string {
    const now = this.options.clock.now()
    if (Number.isNaN(now.getTime())) {
      throw new StorageError('IO', 'clock returned an invalid date')
    }
    return now.toISOString()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('CLOSED', 'storage is closed')
    }
  }
}

export function openStorageFromConfig(
  loaded: LoadedConfig,
  dataDir: string,
): KanobotStorage {
  return KanobotStorage.openFromConfig(loaded, dataDir)
}

export function resolveConfiguredLayout(
  loaded: LoadedConfig,
  dataDir: string,
): ReturnType<typeof resolveStorageLayout> {
  return resolveStorageLayout(dataDir, loaded.system.storage)
}

function validateOptions(options: StorageOptions): void {
  if (!Number.isInteger(options.snapshotEveryEvents) || options.snapshotEveryEvents < 1) {
    throw new StorageError(
      'RECORD_INVALID',
      'snapshotEveryEvents must be a positive integer',
    )
  }
  if (
    !Number.isInteger(options.snapshotIntervalHours) ||
    options.snapshotIntervalHours < 1
  ) {
    throw new StorageError(
      'RECORD_INVALID',
      'snapshotIntervalHours must be a positive integer',
    )
  }
  if (
    !Number.isInteger(options.trashRetentionDays) ||
    options.trashRetentionDays < 1
  ) {
    throw new StorageError(
      'RECORD_INVALID',
      'trashRetentionDays must be a positive integer',
    )
  }
  if (
    !Number.isInteger(options.backupRetention) ||
    options.backupRetention < 1 ||
    options.backupRetention > 30
  ) {
    throw new StorageError(
      'RECORD_INVALID',
      'backupRetention must be an integer between 1 and 30',
    )
  }
}

function conversationFromRow(row: Record<string, unknown>): ConversationRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string'
  ) {
    throw new StorageIntegrityError(
      'conversation row has invalid column types',
      ':conversations:',
    )
  }
  validateInstant(row.created_at, 'conversation.createdAt')
  validateInstant(row.updated_at, 'conversation.updatedAt')
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function chatMessageFromRow(row: Record<string, unknown>): ChatMessageRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.body_id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    (row.role !== 'user' && row.role !== 'assistant') ||
    typeof row.body_text !== 'string' ||
    typeof row.created_at !== 'string'
  ) {
    throw new StorageIntegrityError(
      'chat message row has invalid column types or role',
      ':messages:',
    )
  }
  validateInstant(row.created_at, 'message.createdAt')
  validateIdentifier(row.body_id, 'message.bodyId')
  return {
    id: row.id,
    bodyId: row.body_id,
    conversationId: row.conversation_id,
    role: row.role,
    text: row.body_text,
    createdAt: row.created_at,
  }
}

function modelCallFromRow(row: Record<string, unknown>): ModelCallRecord {
  const status = row.status
  if (
    status !== 'running' &&
    status !== 'succeeded' &&
    status !== 'failed' &&
    status !== 'aborted'
  ) {
    throw new StorageIntegrityError(
      'model call row has an invalid status',
      ':model_calls:',
    )
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    (row.user_message_id !== null &&
      typeof row.user_message_id !== 'string') ||
    (row.assistant_message_id !== null &&
      typeof row.assistant_message_id !== 'string') ||
    typeof row.purpose !== 'string' ||
    typeof row.provider !== 'string' ||
    typeof row.model !== 'string' ||
    typeof row.started_at !== 'string' ||
    (row.completed_at !== null && typeof row.completed_at !== 'string') ||
    typeof row.local_day !== 'string' ||
    (row.pricing_json !== null && typeof row.pricing_json !== 'string') ||
    (row.response_id !== null && typeof row.response_id !== 'string') ||
    (row.error_code !== null && typeof row.error_code !== 'string')
  ) {
    throw new StorageIntegrityError(
      'model call row has invalid column types',
      ':model_calls:',
    )
  }

  validateIdentifier(row.id, 'modelCall.id')
  validateIdentifier(row.conversation_id, 'modelCall.conversationId')
  if (row.user_message_id !== null) {
    validateIdentifier(row.user_message_id, 'modelCall.userMessageId')
  }
  if (row.assistant_message_id !== null) {
    validateIdentifier(row.assistant_message_id, 'modelCall.assistantMessageId')
  }
  const purpose = validateModelCallPurpose(row.purpose)
  validateModelLabel(row.provider, 'modelCall.provider')
  validateModelLabel(row.model, 'modelCall.model')
  validateInstant(row.started_at, 'modelCall.startedAt')
  if (row.completed_at !== null) {
    validateInstant(row.completed_at, 'modelCall.completedAt')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.local_day)) {
    throw new StorageIntegrityError(
      'model call local_day is not YYYY-MM-DD',
      ':model_calls:',
    )
  }
  if (status === 'running' && row.completed_at !== null) {
    throw new StorageIntegrityError(
      'a running model call cannot have completed_at',
      ':model_calls:',
    )
  }
  if (status !== 'running' && row.completed_at === null) {
    throw new StorageIntegrityError(
      'a terminal model call must have completed_at',
      ':model_calls:',
    )
  }
  if (
    status === 'succeeded' &&
    purpose === 'chat' &&
    row.assistant_message_id === null
  ) {
    throw new StorageIntegrityError(
      'a succeeded model call must have an assistant message',
      ':model_calls:',
    )
  }
  if (purpose === 'memory_extraction' && row.assistant_message_id !== null) {
    throw new StorageIntegrityError(
      'a memory extraction call must not reference an assistant message',
      ':model_calls:',
    )
  }
  if (purpose === 'vision' && row.assistant_message_id !== null) {
    throw new StorageIntegrityError(
      'a vision call must not reference an assistant message',
      ':model_calls:',
    )
  }
  if (
    (purpose === 'initiative' || purpose === 'daily_review') &&
    row.assistant_message_id !== null
  ) {
    throw new StorageIntegrityError(
      'an internal initiative call must not reference an assistant message',
      ':model_calls:',
    )
  }

  let pricing: ModelPricingRecord | null = null
  if (row.pricing_json !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.pricing_json)
    } catch (error) {
      throw new StorageIntegrityError(
        'model call pricing_json is not valid JSON',
        ':model_calls:',
        error,
      )
    }
    pricing = validateModelPricing(parsed)
    if (canonicalJson(pricing) !== row.pricing_json) {
      throw new StorageIntegrityError(
        'model call pricing_json is not canonical JSON',
        ':model_calls:',
      )
    }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    purpose,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    localDay: row.local_day,
    status,
    attempts: validateNonNegativeInteger(row.attempts, 'modelCall.attempts'),
    inputTokens: nullableCount(row.input_tokens, 'modelCall.inputTokens'),
    outputTokens: nullableCount(row.output_tokens, 'modelCall.outputTokens'),
    cacheReadTokens: nullableCount(
      row.cache_read_tokens,
      'modelCall.cacheReadTokens',
    ),
    cacheWriteTokens: nullableCount(
      row.cache_write_tokens,
      'modelCall.cacheWriteTokens',
    ),
    reasoningTokens: nullableCount(
      row.reasoning_tokens,
      'modelCall.reasoningTokens',
    ),
    totalTokens: nullableCount(row.total_tokens, 'modelCall.totalTokens'),
    estimatedCost: nullableNonNegativeNumber(
      row.estimated_cost,
      'modelCall.estimatedCost',
    ),
    pricing,
    responseId: row.response_id === null
      ? null
      : validateModelText(row.response_id, 'modelCall.responseId'),
    errorCode: row.error_code === null
      ? null
      : validateModelErrorCode(row.error_code),
  }
}

function eventFromRow(row: Record<string, unknown>): StateEvent {
  try {
    const payloadJson = row.payload_json
    const evidenceRefsJson = row.evidence_refs_json
    if (typeof payloadJson !== 'string' || typeof evidenceRefsJson !== 'string') {
      throw new StorageIntegrityError('event JSON columns are not text', ':events:')
    }
    const payload = JSON.parse(payloadJson) as unknown
    const evidenceRefs = JSON.parse(evidenceRefsJson) as unknown
    if (canonicalJson(payload) !== payloadJson) {
      throw new StorageIntegrityError('event payload is not canonical JSON', ':events:')
    }
    if (canonicalJson(evidenceRefs) !== evidenceRefsJson) {
      throw new StorageIntegrityError(
        'event evidence refs are not canonical JSON',
        ':events:',
      )
    }
    const event = validateStateEvent({
      eventId: row.event_id,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      source: row.source,
      type: row.event_type,
      payload,
      evidenceRefs,
      confidence: row.confidence,
    })
    if (canonicalJson(event.payload) !== payloadJson) {
      throw new StorageIntegrityError('event payload changed during validation', ':events:')
    }
    return event
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageIntegrityError(
      `event row ${String(row.seq)} is invalid: ${messageOf(error)}`,
      ':events:',
      error,
    )
  }
}

function memoryFromRow(row: Record<string, unknown>): MemoryRecord {
  const json = row.record_json
  if (typeof json !== 'string') {
    throw new StorageIntegrityError('memory record_json is not text', ':memories:')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new StorageIntegrityError(
      'memory record_json is not valid JSON',
      ':memories:',
      error,
    )
  }
  let memory: MemoryRecord
  try {
    memory = validateMemoryRecord(parsed)
  } catch (error) {
    throw new StorageIntegrityError(
      `memory record is invalid: ${messageOf(error)}`,
      ':memories:',
      error,
    )
  }
  const matches =
    row.id === memory.id &&
    Number(row.schema_version) === memory.schemaVersion &&
    row.kind === memory.kind &&
    row.content_ref === memory.contentRef &&
    row.quote_ref === memory.quoteRef &&
    row.source === memory.source &&
    row.created_at === memory.createdAt &&
    Number(row.confidence) === memory.confidence &&
    row.sensitivity === memory.sensitivity &&
    row.importance === memory.importance &&
    row.last_recalled_at === memory.lastRecalledAt &&
    row.status === memory.status &&
    row.replaced_by === memory.replacedBy &&
    row.deleted_at === memory.deletedAt &&
    row.purge_after === memory.purgeAfter &&
    canonicalJson(parsed) === json
  if (!matches) {
    throw new StorageIntegrityError(
      'memory columns or canonical bytes do not match record_json',
      ':memories:',
    )
  }
  return memory
}

function outboxFromRow(row: Record<string, unknown>): OutboxRecord {
  const record = validateOutboxRecord({
    id: String(row.id),
    target: String(row.target),
    payloadRef: String(row.payload_ref),
    kind: row.kind as OutboxRecord['kind'],
    status: row.status as OutboxRecord['status'],
    dueAt: row.due_at === null ? null : String(row.due_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
    deliveredMessageId:
      row.delivered_message_id === null
        ? null
        : String(row.delivered_message_id),
  })
  return record
}

function initiativeStateFromRow(
  row: Record<string, unknown>,
): InitiativeStateRecord {
  if (
    Number(row.id) !== 1 ||
    !nullableText(row.last_tick_at) ||
    !nullableText(row.next_proactive_at) ||
    !nullableText(row.last_proactive_at) ||
    !nullableText(row.circuit_opened_at) ||
    !nullableText(row.last_daily_plan_day) ||
    !nullableText(row.last_daily_review_day) ||
    !nullableText(row.last_review_attempt_day) ||
    !nullableText(row.last_trash_purge_day) ||
    typeof row.updated_at !== 'string'
  ) {
    throw new StorageIntegrityError(
      'initiative_state row has invalid column types',
      ':initiative_state:',
    )
  }
  return {
    lastTickAt: textOrNull(row.last_tick_at),
    nextProactiveAt: textOrNull(row.next_proactive_at),
    lastProactiveAt: textOrNull(row.last_proactive_at),
    consecutiveUnanswered: validateNonNegativeInteger(
      row.consecutive_unanswered,
      'initiativeState.consecutiveUnanswered',
    ),
    circuitOpenedAt: textOrNull(row.circuit_opened_at),
    lastDailyPlanDay: textOrNull(row.last_daily_plan_day),
    lastDailyReviewDay: textOrNull(row.last_daily_review_day),
    lastReviewAttemptDay: textOrNull(row.last_review_attempt_day),
    dailyReviewAttempts: validateNonNegativeInteger(
      row.daily_review_attempts,
      'initiativeState.dailyReviewAttempts',
    ),
    lastTrashPurgeDay: textOrNull(row.last_trash_purge_day),
    updatedAt: row.updated_at,
  }
}

function dailyPlanItemFromRow(
  row: Record<string, unknown>,
): DailyPlanItemRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.local_day !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.title_ref !== 'string' ||
    typeof row.starts_at !== 'string' ||
    typeof row.ends_at !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_at !== 'string'
  ) {
    throw new StorageIntegrityError(
      'life_plan_items row has invalid column types',
      ':life_plan_items:',
    )
  }
  if (
    row.status !== 'planned' &&
    row.status !== 'active' &&
    row.status !== 'completed' &&
    row.status !== 'skipped'
  ) {
    throw new StorageIntegrityError(
      'life_plan_items row has an invalid status',
      ':life_plan_items:',
    )
  }
  return {
    id: row.id,
    localDay: validateLocalDay(row.local_day, 'dailyPlanItem.localDay'),
    position: validatePositiveInteger(
      row.position,
      'dailyPlanItem.position',
    ),
    kind: row.kind,
    titleRef: row.title_ref,
    startsAt: validateInstant(row.starts_at, 'dailyPlanItem.startsAt'),
    endsAt: validateInstant(row.ends_at, 'dailyPlanItem.endsAt'),
    status: row.status,
    createdAt: validateInstant(row.created_at, 'dailyPlanItem.createdAt'),
  }
}

function reminderCandidateFromRow(
  row: Record<string, unknown>,
): ReminderCandidateRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.body_ref !== 'string' ||
    typeof row.due_at !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_at !== 'string' ||
    typeof row.source_message_id !== 'string' ||
    !nullableText(row.confirmed_reminder_id)
  ) {
    throw new StorageIntegrityError(
      'reminder_candidates row has invalid column types',
      ':reminder_candidates:',
    )
  }
  if (
    row.status !== 'pending' &&
    row.status !== 'confirmed' &&
    row.status !== 'rejected'
  ) {
    throw new StorageIntegrityError(
      'reminder_candidates row has an invalid status',
      ':reminder_candidates:',
    )
  }
  return {
    id: row.id,
    bodyRef: row.body_ref,
    dueAt: validateInstant(row.due_at, 'reminderCandidate.dueAt'),
    status: row.status,
    createdAt: validateInstant(row.created_at, 'reminderCandidate.createdAt'),
    sourceMessageId: row.source_message_id,
    confirmedReminderId: textOrNull(row.confirmed_reminder_id),
  }
}

function reminderFromRow(row: Record<string, unknown>): ReminderRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.body_ref !== 'string' ||
    typeof row.due_at !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_at !== 'string' ||
    typeof row.confirmed_at !== 'string' ||
    !nullableText(row.delivered_at) ||
    !nullableText(row.outbox_id)
  ) {
    throw new StorageIntegrityError(
      'reminders row has invalid column types',
      ':reminders:',
    )
  }
  if (
    row.status !== 'confirmed' &&
    row.status !== 'queued' &&
    row.status !== 'delivered' &&
    row.status !== 'cancelled' &&
    row.status !== 'failed'
  ) {
    throw new StorageIntegrityError(
      'reminders row has an invalid status',
      ':reminders:',
    )
  }
  return {
    id: row.id,
    bodyRef: row.body_ref,
    dueAt: validateInstant(row.due_at, 'reminder.dueAt'),
    status: row.status,
    createdAt: validateInstant(row.created_at, 'reminder.createdAt'),
    confirmedAt: validateInstant(row.confirmed_at, 'reminder.confirmedAt'),
    deliveredAt: nullableInstant(row.delivered_at, 'reminder.deliveredAt'),
    outboxId: textOrNull(row.outbox_id),
  }
}

function careItemFromRow(row: Record<string, unknown>): CareItemRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.source_message_id !== 'string' ||
    typeof row.body_ref !== 'string' ||
    typeof row.due_from !== 'string' ||
    typeof row.due_until !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_at !== 'string' ||
    !nullableText(row.delivered_at) ||
    !nullableText(row.outbox_id)
  ) {
    throw new StorageIntegrityError(
      'care_items row has invalid column types',
      ':care_items:',
    )
  }
  if (
    row.status !== 'pending' &&
    row.status !== 'queued' &&
    row.status !== 'delivered' &&
    row.status !== 'dismissed' &&
    row.status !== 'expired'
  ) {
    throw new StorageIntegrityError(
      'care_items row has an invalid status',
      ':care_items:',
    )
  }
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    bodyRef: row.body_ref,
    dueFrom: validateInstant(row.due_from, 'careItem.dueFrom'),
    dueUntil: validateInstant(row.due_until, 'careItem.dueUntil'),
    status: row.status,
    createdAt: validateInstant(row.created_at, 'careItem.createdAt'),
    deliveredAt: nullableInstant(row.delivered_at, 'careItem.deliveredAt'),
    outboxId: textOrNull(row.outbox_id),
  }
}

function dailySummaryFromRow(
  row: Record<string, unknown>,
): DailySummaryRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.local_day !== 'string' ||
    typeof row.body_ref !== 'string' ||
    typeof row.source_refs_json !== 'string' ||
    typeof row.created_at !== 'string'
  ) {
    throw new StorageIntegrityError(
      'daily_summaries row has invalid column types',
      ':daily_summaries:',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.source_refs_json)
  } catch {
    throw new StorageIntegrityError(
      'daily summary source refs are not valid JSON',
      ':daily_summaries:',
    )
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(item => typeof item !== 'string')
  ) {
    throw new StorageIntegrityError(
      'daily summary source refs are invalid',
      ':daily_summaries:',
    )
  }
  const sourceRefs = parsed as string[]
  for (const ref of sourceRefs) {
    validateIdentifier(ref, 'dailySummary.sourceRefs')
  }
  return {
    id: row.id,
    localDay: validateLocalDay(row.local_day, 'dailySummary.localDay'),
    bodyRef: row.body_ref,
    sourceRefs,
    createdAt: validateInstant(row.created_at, 'dailySummary.createdAt'),
  }
}

function initiativeRunFromRow(
  row: Record<string, unknown>,
): InitiativeRunRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.occurred_at !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.outcome !== 'string' ||
    typeof row.detail_code !== 'string' ||
    !nullableText(row.target_id)
  ) {
    throw new StorageIntegrityError(
      'initiative_runs row has invalid column types',
      ':initiative_runs:',
    )
  }
  const kinds = [
    'tick',
    'daily_plan',
    'daily_review',
    'proactive',
    'reminder',
    'outbox',
    'circuit',
  ] as const
  const outcomes = ['allowed', 'sent', 'skipped', 'failed'] as const
  if (!kinds.includes(row.kind as (typeof kinds)[number])) {
    throw new StorageIntegrityError(
      'initiative_runs row has an invalid kind',
      ':initiative_runs:',
    )
  }
  if (!outcomes.includes(row.outcome as (typeof outcomes)[number])) {
    throw new StorageIntegrityError(
      'initiative_runs row has an invalid outcome',
      ':initiative_runs:',
    )
  }
  return {
    id: row.id,
    occurredAt: validateInstant(row.occurred_at, 'initiativeRun.occurredAt'),
    kind: row.kind as InitiativeRunRecord['kind'],
    outcome: row.outcome as InitiativeRunRecord['outcome'],
    detailCode: validateReasonCode(
      row.detail_code,
      'initiativeRun.detailCode',
    ),
    targetId: textOrNull(row.target_id),
  }
}

function replyStyleCheckFromRow(
  row: Record<string, unknown>,
): ReplyStyleCheckRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.assistant_message_id !== 'string' ||
    Number(row.schema_version) !== 1 ||
    (row.ok !== 0 && row.ok !== 1) ||
    typeof row.violation_codes_json !== 'string' ||
    (row.retry_count !== 0 && row.retry_count !== 1) ||
    typeof row.initial_violation_codes_json !== 'string' ||
    typeof row.checked_at !== 'string'
  ) {
    throw new StorageIntegrityError(
      'reply style check row has invalid column types',
      ':reply_style_checks:',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.violation_codes_json)
  } catch (error) {
    throw new StorageIntegrityError(
      'reply style check violation_codes_json is not valid JSON',
      ':reply_style_checks:',
      error,
    )
  }
  const violationCodes = validateStyleViolationCodes(parsed)
  if ((row.ok === 1) !== (violationCodes.length === 0)) {
    throw new StorageIntegrityError(
      'reply style check ok flag does not match violation codes',
      ':reply_style_checks:',
    )
  }
  if (canonicalJson(violationCodes) !== row.violation_codes_json) {
    throw new StorageIntegrityError(
      'reply style check violation_codes_json is not canonical JSON',
      ':reply_style_checks:',
    )
  }
  let parsedInitial: unknown
  try {
    parsedInitial = JSON.parse(row.initial_violation_codes_json)
  } catch (error) {
    throw new StorageIntegrityError(
      'reply style check initial_violation_codes_json is not valid JSON',
      ':reply_style_checks:',
      error,
    )
  }
  const initialViolationCodes = validateStyleViolationCodes(parsedInitial)
  if (
    canonicalJson(initialViolationCodes) !== row.initial_violation_codes_json
  ) {
    throw new StorageIntegrityError(
      'reply style check initial_violation_codes_json is not canonical JSON',
      ':reply_style_checks:',
    )
  }
  if (row.retry_count === 0 && initialViolationCodes.length > 0) {
    throw new StorageIntegrityError(
      'reply style check has initial violations without a retry',
      ':reply_style_checks:',
    )
  }
  if (row.retry_count === 1 && initialViolationCodes.length === 0) {
    throw new StorageIntegrityError(
      'reply style check retry is missing its initial violations',
      ':reply_style_checks:',
    )
  }
  return {
    id: validateIdentifier(row.id, 'replyStyleCheck.id'),
    assistantMessageId: validateIdentifier(
      row.assistant_message_id,
      'replyStyleCheck.assistantMessageId',
    ),
    schemaVersion: 1,
    ok: row.ok === 1,
    violationCodes,
    retryCount: row.retry_count,
    initialViolationCodes,
    checkedAt: validateInstant(
      row.checked_at,
      'replyStyleCheck.checkedAt',
    ),
  }
}

function chatTurnAuditFromRow(
  row: Record<string, unknown>,
): ChatTurnAuditRecord {
  if (
    typeof row.assistant_message_id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    typeof row.created_at !== 'string' ||
    (row.violation_codes_json !== null &&
      typeof row.violation_codes_json !== 'string') ||
    (row.style_ok !== null && row.style_ok !== 0 && row.style_ok !== 1) ||
    (row.retry_count !== null && row.retry_count !== 0 && row.retry_count !== 1)
  ) {
    throw new StorageIntegrityError(
      'chat turn audit row has invalid column types',
      ':chat_turns:',
    )
  }
  let violationCodes: string[] = []
  if (row.violation_codes_json !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.violation_codes_json)
    } catch (error) {
      throw new StorageIntegrityError(
        'chat turn violation codes are not valid JSON',
        ':chat_turns:',
        error,
      )
    }
    violationCodes = validateStyleViolationCodes(parsed)
  }
  return {
    assistantMessageId: validateIdentifier(
      row.assistant_message_id,
      'chatTurn.assistantMessageId',
    ),
    conversationId: validateIdentifier(
      row.conversation_id,
      'chatTurn.conversationId',
    ),
    createdAt: validateInstant(row.created_at, 'chatTurn.createdAt'),
    modelCallCount: validateNonNegativeInteger(
      row.model_call_count,
      'chatTurn.modelCallCount',
    ),
    succeededModelCallCount: validateNonNegativeInteger(
      row.succeeded_model_call_count,
      'chatTurn.succeededModelCallCount',
    ),
    styleOk: row.style_ok === null ? null : row.style_ok === 1,
    violationCodes,
    retryCount: row.retry_count === null ? null : row.retry_count,
  }
}

function ownerAuditFromRow(row: Record<string, unknown>): OwnerAuditRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.occurred_at !== 'string' ||
    typeof row.target_id !== 'string' ||
    (row.detail_code !== null && typeof row.detail_code !== 'string')
  ) {
    throw new StorageIntegrityError(
      'owner audit row has invalid column types',
      ':owner_audit:',
    )
  }
  const outcome = row.outcome
  if (outcome !== 'succeeded' && outcome !== 'failed') {
    throw new StorageIntegrityError(
      'owner audit outcome is invalid',
      ':owner_audit:',
    )
  }
  return {
    id: validateIdentifier(row.id, 'ownerAudit.id'),
    occurredAt: validateInstant(row.occurred_at, 'ownerAudit.occurredAt'),
    action: validateOwnerAuditAction(row.action),
    targetType: validateOwnerAuditTargetType(row.target_type),
    targetId: validateIdentifier(row.target_id, 'ownerAudit.targetId'),
    outcome,
    detailCode: row.detail_code === null
      ? null
      : validateAuditDetailCode(row.detail_code),
  }
}

function mapInsertError(error: unknown, kind: string, id: string): StorageError {
  if (messageOf(error).includes('UNIQUE constraint failed')) {
    return new StorageError('DUPLICATE_ID', `${kind} "${id}" already exists`, {
      cause: error,
    })
  }
  return new StorageError(
    'IO',
    `cannot insert ${kind} "${id}": ${messageOf(error)}`,
    { cause: error },
  )
}

function validateModelLabel(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(field, 'expected 1..200 printable characters')
  }
  return value
}

function assertAuditLimit(limit: number, kind: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new StorageError(
      'RECORD_INVALID',
      `${kind} limit must be an integer between 1 and 200`,
    )
  }
}

function validateModelCallPurpose(value: unknown): ModelCallPurpose {
  if (
    value !== 'chat' &&
    value !== 'memory_extraction' &&
    value !== 'vision' &&
    value !== 'initiative' &&
    value !== 'daily_review'
  ) {
    invalid(
      'modelCall.purpose',
      'expected a supported model call purpose',
    )
  }
  return value
}

function validateStyleViolationCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    invalid(
      'replyStyleCheck.violationCodes',
      'expected an array with at most 64 codes',
    )
  }
  const codes: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(item)
    ) {
      invalid(
        'replyStyleCheck.violationCodes',
        'every violation code must be a lowercase identifier',
      )
    }
    if (seen.has(item)) {
      invalid(
        'replyStyleCheck.violationCodes',
        'duplicate violation codes are not allowed',
      )
    }
    seen.add(item)
    codes.push(item)
  }
  return codes
}

function validateOwnerAuditAction(value: unknown): OwnerAuditAction {
  if (!OWNER_AUDIT_ACTIONS.includes(value as OwnerAuditAction)) {
    invalid('ownerAudit.action', 'unsupported owner audit action')
  }
  return value as OwnerAuditAction
}

function validateOwnerAuditTargetType(value: unknown): OwnerAuditTargetType {
  if (!OWNER_AUDIT_TARGET_TYPES.includes(value as OwnerAuditTargetType)) {
    invalid('ownerAudit.targetType', 'expected "memory" or "system"')
  }
  return value as OwnerAuditTargetType
}

function validateAuditDetailCode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)
  ) {
    invalid('ownerAudit.detailCode', 'expected a lowercase detail code')
  }
  return value
}

function validateReasonCode(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)
  ) {
    invalid(field, 'expected a lowercase reason code')
  }
  return value
}

function validateModelText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    invalid(field, 'expected 1..512 characters without NUL')
  }
  return value
}

function validateModelErrorCode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)
  ) {
    invalid('modelCall.errorCode', 'expected a lowercase error code')
  }
  return value
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function textOrNull(value: unknown): string | null {
  return value === null ? null : String(value)
}

function nullableInstant(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    invalid(field, 'expected a canonical UTC ISO timestamp or null')
  }
  return validateInstant(value, field)
}

function validateLocalDay(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    invalid(field, 'expected a YYYY-MM-DD local day')
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    invalid(field, 'expected a real calendar day')
  }
  return value
}

function nullableLocalDay(value: unknown, field: string): string | null {
  return value === null ? null : validateLocalDay(value, field)
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(field, 'expected a positive safe integer')
  }
  return value
}

function validateNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(field, 'expected a non-negative safe integer')
  }
  return value
}

function validateNonNegativeNumber(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    invalid(field, 'expected a non-negative finite number')
  }
  return value
}

function nullableCount(value: unknown, field: string): number | null {
  return value === null ? null : validateNonNegativeInteger(value, field)
}

function nullableNonNegativeNumber(
  value: unknown,
  field: string,
): number | null {
  return value === null ? null : validateNonNegativeNumber(value, field)
}

function nullablePrice(value: unknown, field: string): number | null {
  return value === null ? null : validateNonNegativeNumber(value, field)
}

function validateModelUsage(value: unknown): ModelUsageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('modelCall.usage', 'expected an object')
  }
  const usage = value as Record<string, unknown>
  return {
    inputTokens: validateNonNegativeInteger(
      usage.inputTokens,
      'modelCall.usage.inputTokens',
    ),
    outputTokens: validateNonNegativeInteger(
      usage.outputTokens,
      'modelCall.usage.outputTokens',
    ),
    cacheReadTokens: validateNonNegativeInteger(
      usage.cacheReadTokens,
      'modelCall.usage.cacheReadTokens',
    ),
    cacheWriteTokens: validateNonNegativeInteger(
      usage.cacheWriteTokens,
      'modelCall.usage.cacheWriteTokens',
    ),
    reasoningTokens: validateNonNegativeInteger(
      usage.reasoningTokens,
      'modelCall.usage.reasoningTokens',
    ),
    totalTokens: validateNonNegativeInteger(
      usage.totalTokens,
      'modelCall.usage.totalTokens',
    ),
  }
}

function validateModelPricing(value: unknown): ModelPricingRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('modelCall.pricing', 'expected an object')
  }
  const pricing = value as Record<string, unknown>
  return {
    prompt: nullablePrice(pricing.prompt, 'modelCall.pricing.prompt'),
    completion: nullablePrice(
      pricing.completion,
      'modelCall.pricing.completion',
    ),
    cacheRead: nullablePrice(pricing.cacheRead, 'modelCall.pricing.cacheRead'),
    cacheWrite: nullablePrice(
      pricing.cacheWrite,
      'modelCall.pricing.cacheWrite',
    ),
  }
}

function tombstoneKey(tombstone: Tombstone): string {
  return `${tombstone.targetType}:${tombstone.targetId}`
}

function containsId(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return ids.has(value)
  if (Array.isArray(value)) return value.some(item => containsId(item, ids))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(item => containsId(item, ids))
  }
  return false
}

function computeSuppressedEvents(
  rows: Array<{ rowSequence: number; event: StateEvent }>,
  tombstonedIds: ReadonlySet<string>,
  tombstonedEventIds: ReadonlySet<string>,
): Set<string> {
  const suppressed = new Set<string>()
  const suppressedCommitments = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const { event } of rows) {
      const commitmentId =
        event.type === 'commitment.created' ? event.payload.commitmentId : null
      const referencesTombstone =
        tombstonedEventIds.has(event.eventId) ||
        containsId(event.payload, tombstonedIds) ||
        containsId(event.evidenceRefs, tombstonedIds)
      const referencesSuppressedCommitment =
        commitmentId !== null
          ? suppressedCommitments.has(commitmentId)
          : event.type === 'commitment.resolved'
            ? suppressedCommitments.has(event.payload.commitmentId)
            : false
      if (referencesTombstone || referencesSuppressedCommitment) {
        if (!suppressed.has(event.eventId)) {
          suppressed.add(event.eventId)
          changed = true
        }
        if (event.type === 'commitment.created') {
          if (!suppressedCommitments.has(event.payload.commitmentId)) {
            suppressedCommitments.add(event.payload.commitmentId)
            changed = true
          }
        }
      }
    }
  }
  return suppressed
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function countExistingRows(
  db: DatabaseSync,
  table: 'bodies' | 'memories' | 'outbox',
  ids: readonly string[],
): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${placeholders})`,
  ).get(...ids) as Record<string, unknown> | undefined
  return Number(row?.count ?? 0)
}
