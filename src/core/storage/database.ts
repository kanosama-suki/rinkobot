/**
 * SQLite 打开、完整性检查和 M2/M3 schema。
 *
 * 关键边界：
 * - 已存在的文件只允许被验证后打开；验证失败绝不删除、覆盖或自动建空库；
 * - 新库只在目标路径原本不存在时创建；
 * - 已支持的旧 schema 在事务内迁移；未知版本或必需表/列不匹配时 fail-closed；
 * - 主库与墓碑库使用独立连接和 schema，墓碑库不进入主库备份。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import {
  SchemaCompatibilityError,
  StorageError,
  StorageIntegrityError,
} from './errors.ts'

export const STORAGE_SCHEMA_VERSION = 7
export const TOMBSTONE_STORE_SCHEMA_VERSION = 1

type DatabaseKind = 'main' | 'tombstones'

const MAIN_REQUIRED_COLUMNS_V1: Record<string, readonly string[]> = {
  schema_migrations: ['version', 'applied_at'],
  events: [
    'seq',
    'event_id',
    'schema_version',
    'occurred_at',
    'source',
    'event_type',
    'payload_json',
    'evidence_refs_json',
    'confidence',
  ],
  snapshots: [
    'id',
    'schema_version',
    'last_sequence',
    'last_event_id',
    'generated_at',
    'state_hash',
    'snapshot_json',
  ],
  bodies: ['id', 'kind', 'content', 'created_at'],
  memories: [
    'id',
    'schema_version',
    'kind',
    'content_ref',
    'quote_ref',
    'source',
    'created_at',
    'confidence',
    'sensitivity',
    'importance',
    'last_recalled_at',
    'status',
    'previous_status',
    'replaced_by',
    'deleted_at',
    'purge_after',
    'record_json',
  ],
  tombstones: ['target_type', 'target_id', 'purged_at'],
  outbox: [
    'id',
    'target',
    'payload_ref',
    'status',
    'due_at',
    'created_at',
    'attempts',
    'last_error_code',
  ],
}

const MAIN_REQUIRED_COLUMNS_V2: Record<string, readonly string[]> = {
  ...MAIN_REQUIRED_COLUMNS_V1,
  conversations: ['id', 'created_at', 'updated_at'],
  messages: ['seq', 'id', 'conversation_id', 'role', 'body_id', 'created_at'],
}

const MAIN_REQUIRED_COLUMNS_V3: Record<string, readonly string[]> = {
  ...MAIN_REQUIRED_COLUMNS_V2,
  model_calls: [
    'id',
    'conversation_id',
    'user_message_id',
    'assistant_message_id',
    'provider',
    'model',
    'started_at',
    'completed_at',
    'local_day',
    'status',
    'attempts',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'total_tokens',
    'estimated_cost',
    'pricing_json',
    'response_id',
    'error_code',
  ],
}

const MAIN_REQUIRED_COLUMNS_V4: Record<string, readonly string[]> = {
  ...MAIN_REQUIRED_COLUMNS_V3,
  memory_search: ['memory_id', 'word_text', 'char_text'],
}

const MAIN_REQUIRED_COLUMNS_V5: Record<string, readonly string[]> = {
  ...MAIN_REQUIRED_COLUMNS_V4,
  model_calls: [...MAIN_REQUIRED_COLUMNS_V4.model_calls, 'purpose'],
}

const MAIN_REQUIRED_COLUMNS_V6: Record<string, readonly string[]> = {
  ...MAIN_REQUIRED_COLUMNS_V5,
  reply_style_checks: [
    'id',
    'assistant_message_id',
    'schema_version',
    'ok',
    'violation_codes_json',
    'checked_at',
  ],
  owner_audit: [
    'id',
    'occurred_at',
    'action',
    'target_type',
    'target_id',
    'outcome',
    'detail_code',
  ],
  emergency_state: ['id', 'stopped', 'updated_at', 'reason_code'],
}

const TOMBSTONE_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  schema_migrations: ['version', 'applied_at'],
  tombstones: ['target_type', 'target_id', 'purged_at'],
}

const MAIN_SCHEMA_V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1)
) STRICT;
CREATE INDEX events_occurred_at_index ON events(occurred_at);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  last_sequence INTEGER NOT NULL UNIQUE CHECK (last_sequence >= 0),
  last_event_id TEXT,
  generated_at TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
) STRICT;

CREATE TABLE bodies (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE memories (
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
CREATE INDEX memories_content_ref_index ON memories(content_ref);
CREATE INDEX memories_quote_ref_index ON memories(quote_ref);
CREATE INDEX memories_status_index ON memories(status);

CREATE TABLE tombstones (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
) STRICT;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
) STRICT;
CREATE INDEX outbox_payload_ref_index ON outbox(payload_ref);
CREATE INDEX outbox_status_index ON outbox(status);
`

const CHAT_SCHEMA_V2 = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  body_id TEXT NOT NULL REFERENCES bodies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX messages_conversation_seq_index ON messages(conversation_id, seq);
CREATE INDEX messages_body_id_index ON messages(body_id);
`

const MODEL_CALLS_SCHEMA_V3 = `
CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  local_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  pricing_json TEXT,
  response_id TEXT,
  error_code TEXT
) STRICT;
CREATE INDEX model_calls_conversation_started_index
  ON model_calls(conversation_id, started_at);
CREATE INDEX model_calls_local_day_index ON model_calls(local_day);
CREATE INDEX model_calls_user_message_index ON model_calls(user_message_id);
CREATE INDEX model_calls_assistant_message_index ON model_calls(assistant_message_id);
`

const MEMORY_SEARCH_SCHEMA_V4 = `
CREATE VIRTUAL TABLE memory_search USING fts5(
  memory_id UNINDEXED,
  word_text,
  char_text,
  tokenize = 'unicode61 remove_diacritics 0'
);
INSERT INTO memory_search(memory_search, rank) VALUES('secure-delete', 1);
`

/**
 * M3.3 曾用 memory_extraction 记录独立抽取调用；M3.5 已把它合并到
 * 单次 chat 调用。保留枚举是为了解释旧数据，新的聊天流程不得再写这个
 * purpose。旧行一律视为聊天调用，保持 v4 数据可解释。
 */
const MODEL_CALL_PURPOSE_SCHEMA_V5 = `
ALTER TABLE model_calls
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'chat'
  CHECK (purpose IN ('chat', 'memory_extraction'));
CREATE INDEX model_calls_purpose_index ON model_calls(purpose);
`

/**
 * M3.4 的所有者控制与可观测性表。
 *
 * 风格检查只保存违规代码，不复制回复正文；审计只保存动作和对象 ID。
 * emergency_state 是持久化的停止开关，STOP 文件只是外部触发方式。
 */
const CONTROL_SCHEMA_V6 = `
CREATE TABLE reply_style_checks (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL UNIQUE
    REFERENCES messages(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  violation_codes_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
) STRICT;
CREATE INDEX reply_style_checks_checked_at_index
  ON reply_style_checks(checked_at);

CREATE TABLE owner_audit (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'memory.create',
    'memory.correct',
    'memory.promote',
    'memory.trash',
    'memory.restore',
    'memory.purge',
    'emergency.stop',
    'emergency.resume'
  )),
  target_type TEXT NOT NULL CHECK (target_type IN ('memory', 'system')),
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  detail_code TEXT
) STRICT;
CREATE INDEX owner_audit_occurred_at_index ON owner_audit(occurred_at);

CREATE TABLE emergency_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
  updated_at TEXT NOT NULL,
  reason_code TEXT NOT NULL
) STRICT;
`

/**
 * M3.7 增加独立视觉调用。SQLite 不能原地修改列上的 CHECK，因此重建
 * model_calls，保留全部历史行和索引；视觉调用没有 assistant message。
 */
const MODEL_CALL_PURPOSE_SCHEMA_V7 = `
CREATE TABLE model_calls_v7 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'chat'
    CHECK (purpose IN ('chat', 'memory_extraction', 'vision')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  local_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  pricing_json TEXT,
  response_id TEXT,
  error_code TEXT
) STRICT;
INSERT INTO model_calls_v7
  (id, conversation_id, user_message_id, assistant_message_id, purpose,
   provider, model, started_at, completed_at, local_day, status, attempts,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
   reasoning_tokens, total_tokens, estimated_cost, pricing_json, response_id,
   error_code)
SELECT
  id, conversation_id, user_message_id, assistant_message_id, purpose,
  provider, model, started_at, completed_at, local_day, status, attempts,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens, estimated_cost, pricing_json, response_id,
  error_code
FROM model_calls;
DROP TABLE model_calls;
ALTER TABLE model_calls_v7 RENAME TO model_calls;
CREATE INDEX model_calls_conversation_started_index
  ON model_calls(conversation_id, started_at);
CREATE INDEX model_calls_local_day_index ON model_calls(local_day);
CREATE INDEX model_calls_user_message_index ON model_calls(user_message_id);
CREATE INDEX model_calls_assistant_message_index ON model_calls(assistant_message_id);
CREATE INDEX model_calls_purpose_index ON model_calls(purpose);
`

const TOMBSTONE_SCHEMA = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE tombstones (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
) STRICT;
`

export function openMainDatabase(path: string, nowIso: string): DatabaseSync {
  return openDatabase(path, 'main', nowIso)
}

export function openTombstoneDatabase(path: string, nowIso: string): DatabaseSync {
  return openDatabase(path, 'tombstones', nowIso)
}

export function inspectDatabaseFile(
  path: string,
  kind: DatabaseKind = 'main',
): void {
  if (!existsSync(path)) {
    throw new StorageError('IO', `database file does not exist`, { path })
  }
  assertSqliteHeader(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    assertQuickCheck(db, path)
    assertSchemaCompatible(db, path, kind)
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageIntegrityError(
      `database integrity check failed: ${errorMessage(error)}`,
      path,
      error,
    )
  } finally {
    db?.close()
  }
}

export function quickCheckDatabase(db: DatabaseSync, path: string): void {
  try {
    assertQuickCheck(db, path)
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageIntegrityError(
      `database quick_check failed: ${errorMessage(error)}`,
      path,
      error,
    )
  }
}

function openDatabase(
  path: string,
  kind: DatabaseKind,
  nowIso: string,
): DatabaseSync {
  const existed = existsSync(path)
  if (existed) {
    // 先只读验证，确保损坏或不兼容的旧库不会被写打开或“初始化”覆盖。
    inspectDatabaseFile(path, kind)
  }

  let db: DatabaseSync
  try {
    if (!existed) {
      mkdirSync(dirname(path), { recursive: true })
    }
    db = new DatabaseSync(path)
  } catch (error) {
    throw new StorageIntegrityError(
      `cannot open database: ${errorMessage(error)}`,
      path,
      error,
    )
  }

  try {
    applyRuntimePragmas(db)
    if (existed) {
      // 只读预检和写打开之间存在极短窗口；写打开后再做一次语义检查。
      assertSchemaCompatible(db, path, kind)
      migrateDatabaseIfNeeded(db, path, kind, nowIso)
      assertSchemaCompatible(db, path, kind)
    } else {
      initializeDatabase(db, path, kind, nowIso)
    }
    applyRuntimePragmas(db)
    assertRuntimePragmas(db, path)
    return db
  } catch (error) {
    db.close()
    if (!existed) {
      removeNewDatabaseFiles(path)
    }
    if (error instanceof StorageError) throw error
    throw new StorageIntegrityError(
      `database initialization failed: ${errorMessage(error)}`,
      path,
      error,
    )
  }
}

function initializeDatabase(
  db: DatabaseSync,
  path: string,
  kind: DatabaseKind,
  nowIso: string,
): void {
  const version =
    kind === 'main' ? STORAGE_SCHEMA_VERSION : TOMBSTONE_STORE_SCHEMA_VERSION
  const schema =
    kind === 'main'
      ? `${MAIN_SCHEMA_V1}\n${CHAT_SCHEMA_V2}\n${MODEL_CALLS_SCHEMA_V3}\n${MEMORY_SEARCH_SCHEMA_V4}\n${MODEL_CALL_PURPOSE_SCHEMA_V5}\n${CONTROL_SCHEMA_V6}\n${MODEL_CALL_PURPOSE_SCHEMA_V7}`
      : TOMBSTONE_SCHEMA
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(schema)
    if (kind === 'main') {
      db.prepare(
        `INSERT INTO emergency_state (id, stopped, updated_at, reason_code)
         VALUES (1, 0, ?, 'running')`,
      ).run(nowIso)
    }
    db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(version, nowIso)
    db.exec(`PRAGMA user_version = ${version}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw new StorageIntegrityError(
      `cannot create ${kind} database schema: ${errorMessage(error)}`,
      path,
      error,
    )
  }
}

function applyRuntimePragmas(db: DatabaseSync): void {
  const journal = db.prepare('PRAGMA journal_mode = WAL').get() as
    | Record<string, unknown>
    | undefined
  if (String(journal?.journal_mode).toLowerCase() !== 'wal') {
    throw new StorageError('IO', 'SQLite refused to enable WAL journal mode')
  }
  db.exec('PRAGMA secure_delete = ON')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
}

function assertRuntimePragmas(db: DatabaseSync, path: string): void {
  const journal = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
  const secureDelete = db.prepare('PRAGMA secure_delete').get() as Record<string, unknown>
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>
  const synchronous = db.prepare('PRAGMA synchronous').get() as Record<string, unknown>
  if (String(journal.journal_mode).toLowerCase() !== 'wal') {
    throw new StorageIntegrityError('journal_mode is not WAL', path)
  }
  if (Number(secureDelete.secure_delete) !== 1) {
    throw new StorageIntegrityError('secure_delete is not enabled', path)
  }
  if (Number(foreignKeys.foreign_keys) !== 1) {
    throw new StorageIntegrityError('foreign_keys is not enabled', path)
  }
  if (Number(synchronous.synchronous) !== 2) {
    throw new StorageIntegrityError('synchronous is not FULL', path)
  }
}

function assertSqliteHeader(path: string): void {
  let size: number
  try {
    const info = statSync(path)
    if (!info.isFile()) {
      throw new StorageIntegrityError('database path is not a regular file', path)
    }
    size = info.size
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageIntegrityError(
      `cannot stat database: ${errorMessage(error)}`,
      path,
      error,
    )
  }
  if (size < 512) {
    throw new StorageIntegrityError(
      `file is too small to be a SQLite database (${size} bytes)`,
      path,
    )
  }

  const buffer = Buffer.alloc(16)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const bytes = readSync(fd, buffer, 0, 16, 0)
    if (bytes !== 16 || buffer.toString('utf8') !== 'SQLite format 3\u0000') {
      throw new StorageIntegrityError('invalid SQLite file header', path)
    }
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageIntegrityError(
      `cannot read database header: ${errorMessage(error)}`,
      path,
      error,
    )
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function assertQuickCheck(db: DatabaseSync, path: string): void {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
  if (rows.length !== 1 || rows[0].quick_check !== 'ok') {
    const details = rows.map(row => String(row.quick_check)).join('; ')
    throw new StorageIntegrityError(
      `quick_check failed${details ? `: ${details}` : ''}`,
      path,
    )
  }
}

function assertSchemaCompatible(
  db: DatabaseSync,
  path: string,
  kind: DatabaseKind,
): void {
  const versions = readSchemaVersions(db, path, kind)
  const latest = versions.at(-1)
  const supported =
    kind === 'main' ? [1, 2, 3, 4, 5, 6, 7] : [TOMBSTONE_STORE_SCHEMA_VERSION]
  if (
    latest === undefined ||
    !supported.includes(latest) ||
    versions.some(version => !supported.includes(version))
  ) {
    throw new SchemaCompatibilityError(
      `unsupported schema versions ${JSON.stringify(versions)}; supported ${JSON.stringify(supported)}`,
      path,
    )
  }

  const required =
    kind === 'tombstones'
      ? TOMBSTONE_REQUIRED_COLUMNS
      : latest === 1
        ? MAIN_REQUIRED_COLUMNS_V1
        : latest === 2
          ? MAIN_REQUIRED_COLUMNS_V2
          : latest === 3
            ? MAIN_REQUIRED_COLUMNS_V3
            : latest === 4
              ? MAIN_REQUIRED_COLUMNS_V4
              : latest === 5
                ? MAIN_REQUIRED_COLUMNS_V5
                : MAIN_REQUIRED_COLUMNS_V6
  for (const [table, columns] of Object.entries(required)) {
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).all(table) as Array<Record<string, unknown>>
    if (tableRows.length !== 1) {
      throw new SchemaCompatibilityError(`required table "${table}" is missing`, path)
    }
    const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<
      Record<string, unknown>
    >
    const actual = new Set(info.map(row => String(row.name)))
    for (const column of columns) {
      if (!actual.has(column)) {
        throw new SchemaCompatibilityError(
          `required column "${table}.${column}" is missing`,
          path,
        )
      }
    }
  }
}

function readSchemaVersions(
  db: DatabaseSync,
  path: string,
  kind: DatabaseKind,
): number[] {
  try {
    const rows = db.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<Record<string, unknown>>
    return rows.map(row => Number(row.version))
  } catch (error) {
    throw new SchemaCompatibilityError(
      'schema_migrations is missing or unreadable; refusing to initialize over an existing database',
      path,
      error,
    )
  }
}

function migrateDatabaseIfNeeded(
  db: DatabaseSync,
  path: string,
  kind: DatabaseKind,
  nowIso: string,
): void {
  if (kind !== 'main') return
  const versions = readSchemaVersions(db, path, kind)
  const latest = versions.at(-1)
  if (latest === STORAGE_SCHEMA_VERSION) return

  db.exec('BEGIN IMMEDIATE')
  try {
    if (latest === 1) {
      db.exec(CHAT_SCHEMA_V2)
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(2, nowIso)
    }
    if (latest === 1 || latest === 2) {
      db.exec(MODEL_CALLS_SCHEMA_V3)
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(3, nowIso)
    }
    if (latest === 1 || latest === 2 || latest === 3) {
      db.exec(MEMORY_SEARCH_SCHEMA_V4)
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(4, nowIso)
    }
    if (latest === 1 || latest === 2 || latest === 3 || latest === 4) {
      db.exec(MODEL_CALL_PURPOSE_SCHEMA_V5)
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(5, nowIso)
    }
    if (
      latest === 1 ||
      latest === 2 ||
      latest === 3 ||
      latest === 4 ||
      latest === 5
    ) {
      db.exec(CONTROL_SCHEMA_V6)
      db.prepare(
        `INSERT INTO emergency_state (id, stopped, updated_at, reason_code)
         VALUES (1, 0, ?, 'running')`,
      ).run(nowIso)
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(6, nowIso)
    }
    if (
      latest === 1 ||
      latest === 2 ||
      latest === 3 ||
      latest === 4 ||
      latest === 5 ||
      latest === 6
    ) {
      db.exec(MODEL_CALL_PURPOSE_SCHEMA_V7)
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(7, nowIso)
    }
    db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 原始迁移错误优先；SQLite 可能已经自动回滚。
    }
    throw new StorageIntegrityError(
      `schema migration ${String(latest)} -> ${STORAGE_SCHEMA_VERSION} failed: ${errorMessage(error)}`,
      path,
      error,
    )
  }
}

function removeNewDatabaseFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${path}${suffix}`, { force: true })
    } catch {
      // 清理失败不覆盖原始初始化错误；下一次启动会按损坏库拒绝，而不是重建。
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
