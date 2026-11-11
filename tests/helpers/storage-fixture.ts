/**
 * M2 测试共用的临时目录、配置和事件工厂。
 *
 * 这里不访问真实数据目录，也不使用真实人格或模型凭据。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'

import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import type { LoadedConfig } from '../../src/core/config/index.ts'
import {
  createManualClock,
} from '../../src/core/state/index.ts'
import type {
  EventSource,
  MemoryRecord,
  StateEvent,
} from '../../src/core/state/index.ts'
import { KanobotStorage } from '../../src/core/storage/index.ts'

const examplesDir = fileURLToPath(new URL('../../config/examples', import.meta.url))

export interface Workspace {
  root: string
  loaded: LoadedConfig
  clock: ReturnType<typeof createManualClock>
  open(): KanobotStorage
}

export interface WorkspaceOptions {
  now?: string
  snapshotEveryEvents?: number
  snapshotIntervalHours?: number
  backupRetention?: number
  trashRetentionDays?: number
}

/**
 * 测试需要把当前库降级成某个旧 schema；真实旧库当然没有 M4 表。
 * 先移除这些表，避免“旧版本号 + 新表”这种现实里不存在的混合状态。
 */
export function dropCurrentInitiativeTables(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS care_items;
    DROP TABLE IF EXISTS reminder_candidates;
    DROP TABLE IF EXISTS daily_summaries;
    DROP TABLE IF EXISTS reminders;
    DROP TABLE IF EXISTS life_plan_items;
    DROP TABLE IF EXISTS initiative_runs;
    DROP TABLE IF EXISTS initiative_state;
  `)
}

/** 把当前 v11 库还原成 v10 形状时，先移除 M5 才出现的渠道表。 */
export function dropCurrentChannelTables(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS channel_audit;
    DROP TABLE IF EXISTS channel_inbound;
  `)
}

/**
 * 把当前 v10 的记忆表还原成 v9 形状，供迁移测试从真实旧结构重放。
 * 只在测试夹具里使用；生产迁移永远只向前走。
 */
export function downgradeMemoriesToV9(db: DatabaseSync): void {
  const rows = db.prepare('SELECT * FROM memories').all() as Array<
    Record<string, unknown>
  >
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS memory_decisions;
    CREATE TABLE memories_v9 (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      kind TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      quote_ref TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confidence REAL NOT NULL,
      sensitivity TEXT NOT NULL,
      importance TEXT NOT NULL,
      last_recalled_at TEXT,
      status TEXT NOT NULL,
      previous_status TEXT,
      replaced_by TEXT,
      deleted_at TEXT,
      purge_after TEXT,
      record_json TEXT NOT NULL
    ) STRICT;
  `)
  const insert = db.prepare(
    `INSERT INTO memories_v9
      (id, schema_version, kind, content_ref, quote_ref, source, created_at,
       confidence, sensitivity, importance, last_recalled_at, status,
       previous_status, replaced_by, deleted_at, purge_after, record_json)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const row of rows) {
    const record = JSON.parse(String(row.record_json)) as Record<string, unknown>
    delete record.explicitlyRequested
    record.schemaVersion = 1
    insert.run(
      row.id,
      row.kind,
      row.content_ref,
      row.quote_ref,
      row.source,
      row.created_at,
      row.confidence,
      row.sensitivity,
      row.importance,
      row.last_recalled_at,
      row.status,
      row.previous_status,
      row.replaced_by,
      row.deleted_at,
      row.purge_after,
      JSON.stringify(record),
    )
  }
  db.exec(`
    DROP TABLE memories;
    ALTER TABLE memories_v9 RENAME TO memories;
    CREATE INDEX memories_content_ref_index ON memories(content_ref);
    CREATE INDEX memories_quote_ref_index ON memories(quote_ref);
    CREATE INDEX memories_status_index ON memories(status);
  `)
}

export function createWorkspace(
  t: TestContext,
  options: WorkspaceOptions = {},
): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-m2-'))
  const loaded = structuredClone(loadConfigFromDirectory(examplesDir))
  loaded.system.storage.snapshotEveryEvents =
    options.snapshotEveryEvents ?? loaded.system.storage.snapshotEveryEvents
  loaded.system.storage.snapshotIntervalHours =
    options.snapshotIntervalHours ?? loaded.system.storage.snapshotIntervalHours
  loaded.system.storage.backupRetention =
    options.backupRetention ?? loaded.system.storage.backupRetention
  loaded.memory.trash.retentionDays =
    options.trashRetentionDays ?? loaded.memory.trash.retentionDays
  const clock = createManualClock(options.now ?? '2026-11-05T00:00:00.000Z')

  t.after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  return {
    root,
    loaded,
    clock,
    open(): KanobotStorage {
      return KanobotStorage.openFromConfig(loaded, root, clock)
    },
  }
}

export function testEvent<Type extends StateEvent['type']>(
  id: string,
  type: Type,
  payload: Extract<StateEvent, { type: Type }>['payload'],
  occurredAt = '2026-11-05T00:00:00.000Z',
  source: EventSource = sourceFor(type),
): Extract<StateEvent, { type: Type }> {
  return {
    eventId: id,
    schemaVersion: 1,
    occurredAt,
    source,
    type,
    payload,
    evidenceRefs: [],
    confidence: 1,
  } as Extract<StateEvent, { type: Type }>
}

export function tickEvent(
  id: string,
  occurredAt = '2026-11-05T00:00:00.000Z',
  elapsedMinutes = 60,
): StateEvent {
  return testEvent(
    id,
    'tick',
    { elapsedMinutes, awake: true },
    occurredAt,
  )
}

export function memoryFor(
  id: string,
  descriptionRef: string,
): MemoryRecord {
  return {
    schemaVersion: 2,
    id,
    kind: 'preference',
    contentRef: descriptionRef,
    quoteRef: null,
    source: 'user_stated',
    createdAt: '2026-11-05T00:00:00.000Z',
    confidence: 1,
    sensitivity: 'normal',
    importance: 'important',
    explicitlyRequested: false,
    lastRecalledAt: null,
    status: 'active',
    replacedBy: null,
    deletedAt: null,
    purgeAfter: null,
  }
}

export function outboxFor(id: string, payloadRef: string) {
  return {
    id,
    target: 'web:owner',
    payloadRef,
    kind: 'system' as const,
    status: 'pending' as const,
    dueAt: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    attempts: 0,
    maxAttempts: 5,
    lastErrorCode: null,
    deliveredMessageId: null,
  }
}

function sourceFor(type: StateEvent['type']): EventSource {
  switch (type) {
    case 'tick':
      return 'tick'
    case 'activity.changed':
    case 'appraisal.recorded':
      return 'rinko'
    case 'relationship.adjusted':
      return 'owner'
    default:
      return 'user'
  }
}
