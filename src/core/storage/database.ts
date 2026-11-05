/**
 * SQLite 打开、完整性检查和 M2 schema。
 *
 * 关键边界：
 * - 已存在的文件只允许被验证后打开；验证失败绝不删除、覆盖或自动建空库；
 * - 新库只在目标路径原本不存在时创建；
 * - 迁移版本或必需表/列不匹配时 fail-closed；
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

export const STORAGE_SCHEMA_VERSION = 1
export const TOMBSTONE_STORE_SCHEMA_VERSION = 1

type DatabaseKind = 'main' | 'tombstones'

const REQUIRED_COLUMNS: Record<DatabaseKind, Record<string, readonly string[]>> = {
  main: {
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
  },
  tombstones: {
    schema_migrations: ['version', 'applied_at'],
    tombstones: ['target_type', 'target_id', 'purged_at'],
  },
}

const MAIN_SCHEMA = `
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
  const schema = kind === 'main' ? MAIN_SCHEMA : TOMBSTONE_SCHEMA
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(schema)
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
  const expectedVersion =
    kind === 'main' ? STORAGE_SCHEMA_VERSION : TOMBSTONE_STORE_SCHEMA_VERSION
  let versions: number[]
  try {
    const rows = db.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<Record<string, unknown>>
    versions = rows.map(row => Number(row.version))
  } catch (error) {
    throw new SchemaCompatibilityError(
      'schema_migrations is missing or unreadable; refusing to initialize over an existing database',
      path,
      error,
    )
  }
  if (versions.length !== 1 || versions[0] !== expectedVersion) {
    throw new SchemaCompatibilityError(
      `unsupported schema versions ${JSON.stringify(versions)}; expected [${expectedVersion}]`,
      path,
    )
  }

  const required = REQUIRED_COLUMNS[kind]
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
