/**
 * M2 持久化引擎。
 *
 * 边界：
 * - 事件追加和可选快照在同一 SQLite 事务里提交；
 * - 恢复顺序是“先应用独立墓碑，再从最近快照重放事件”，避免旧备份复活删除内容；
 * - 彻底清除会级联正文/记忆/outbox，删除并重建快照，最后 checkpoint + VACUUM；
 * - 所有数据库错误显式抛出，不自动重建、不静默跳过损坏事件。
 */

import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

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
} from './backup.ts'
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
  validateBodyInput,
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
  BodyRecord,
  MemoryListOptions,
  OutboxRecord,
  PurgeResult,
  PurgeTarget,
  SnapshotResult,
  StorageOptions,
} from './types.ts'

interface TombstoneEnforcement {
  tombstones: Tombstone[]
  deletedBodies: number
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

  putMemory(input: MemoryRecord): MemoryRecord {
    this.assertOpen()
    const memory = validateMemoryRecord(input)
    this.assertNotTombstoned('memory', memory.id)
    this.assertBodyAvailable(memory.contentRef, 'memory.contentRef')
    if (memory.quoteRef !== null) {
      this.assertBodyAvailable(memory.quoteRef, 'memory.quoteRef')
    }
    const json = canonicalJson(memory)
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
        json,
      )
    } catch (error) {
      throw mapInsertError(error, 'memory', memory.id)
    }
    return memory
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
    this.updateMemoryRow(updated, current.status)
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
    this.updateMemoryRow(restored, null)
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
          (id, target, payload_ref, status, due_at, created_at, attempts, last_error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.target,
        record.payloadRef,
        record.status,
        record.dueAt,
        record.createdAt,
        record.attempts,
        record.lastErrorCode,
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
    let deletedBodies = 0
    let deletedMemories = 0
    let deletedOutbox = 0
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
          deletedBodies += Number(
            this.db.prepare('DELETE FROM bodies WHERE id = ?').run(tombstone.targetId)
              .changes,
          )
        } else if (tombstone.targetType === 'memory') {
          deletedMemories += Number(
            this.db.prepare('DELETE FROM memories WHERE id = ?').run(tombstone.targetId)
              .changes,
          )
        } else if (tombstone.targetType === 'outbox') {
          deletedOutbox += Number(
            this.db.prepare('DELETE FROM outbox WHERE id = ?').run(tombstone.targetId)
              .changes,
          )
        }
      }
      if (tombstones.length > 0) {
        deletedSnapshots = deleteAllSnapshots(this.db)
      }
    })

    return {
      tombstones,
      deletedBodies,
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

  private updateMemoryRow(
    memory: MemoryRecord,
    previousStatus: MemoryRecord['status'] | null,
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
    status: row.status as OutboxRecord['status'],
    dueAt: row.due_at === null ? null : String(row.due_at),
    createdAt: String(row.created_at),
    attempts: Number(row.attempts),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
  })
  return record
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
