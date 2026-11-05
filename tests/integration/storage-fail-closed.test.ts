/**
 * 数据库损坏和不兼容 schema 的 fail-closed 验收。
 *
 * 任何已有文件都必须被原样保留：启动可以失败，但不能自动创建空库、
 * 删除旧文件或忽略损坏的快照/事件。
 */

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  SchemaCompatibilityError,
  StorageIntegrityError,
} from '../../src/core/storage/index.ts'
import {
  createWorkspace,
  testEvent,
  tickEvent,
} from '../helpers/storage-fixture.ts'

test('a corrupt existing database is rejected and left untouched', () => {
  const ws = createWorkspace(test)
  const corrupt = Buffer.alloc(2048, 0x42)
  const path = join(ws.root, 'kanobot.sqlite')
  writeFileSync(path, corrupt)

  assert.throws(
    () => ws.open(),
    (error: unknown) =>
      error instanceof StorageIntegrityError &&
      error.code === 'DATABASE_CORRUPT',
  )
  assert.deepEqual(readFileSync(path), corrupt)
})

test('a database with an incompatible schema version is rejected', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const path = store.databasePath
  store.close()

  const db = new DatabaseSync(path)
  try {
    db.prepare('UPDATE schema_migrations SET version = 9').run()
  } finally {
    db.close()
  }

  assert.throws(
    () => ws.open(),
    (error: unknown) =>
      error instanceof SchemaCompatibilityError &&
      error.code === 'SCHEMA_INCOMPATIBLE',
  )
})

test('an unrelated SQLite file is not initialized over', () => {
  const ws = createWorkspace(test)
  const path = join(ws.root, 'kanobot.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE unrelated (value TEXT) STRICT')
    db.prepare('INSERT INTO unrelated VALUES (?)').run('keep-me')
  } finally {
    db.close()
  }

  assert.throws(
    () => ws.open(),
    (error: unknown) =>
      error instanceof SchemaCompatibilityError &&
      error.message.includes('schema_migrations'),
  )

  const check = new DatabaseSync(path, { readOnly: true })
  try {
    const row = check.prepare('SELECT value FROM unrelated').get() as
      | Record<string, unknown>
      | undefined
    assert.equal(row?.value, 'keep-me')
  } finally {
    check.close()
  }
})

test('a semantically corrupted snapshot is rejected instead of skipped', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const path = store.databasePath
  try {
    store.appendEvent(tickEvent('event-corrupt-snapshot'))
    store.createSnapshot()
  } finally {
    store.close()
  }

  const db = new DatabaseSync(path)
  try {
    db.prepare(
      `UPDATE snapshots
       SET snapshot_json = '{"schemaVersion":1}'
       WHERE last_sequence = 1`,
    ).run()
  } finally {
    db.close()
  }

  assert.throws(
    () => ws.open(),
    (error: unknown) =>
      error instanceof StorageIntegrityError &&
      error.message.includes('snapshot'),
  )
})

test('a corrupted event after the snapshot is rejected during replay', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const path = store.databasePath
  try {
    store.appendEvent(tickEvent('event-before-corruption'))
    store.createSnapshot()
    store.appendEvent(
      testEvent(
        'event-after-snapshot',
        'interaction.recorded',
        { kind: 'conversation', intensity: 0.5 },
        '2026-11-05T00:01:00.000Z',
      ),
    )
  } finally {
    store.close()
  }

  const db = new DatabaseSync(path)
  try {
    db.prepare(
      "UPDATE events SET payload_json = '{}' WHERE event_id = 'event-after-snapshot'",
    ).run()
  } finally {
    db.close()
  }

  assert.throws(
    () => ws.open(),
    (error: unknown) =>
      error instanceof StorageIntegrityError &&
      error.message.includes('event row 2'),
  )
})

test('a half-missing database pair is not recreated automatically', () => {
  const missingTombstone = createWorkspace(test)
  const first = missingTombstone.open()
  first.close()
  unlinkSync(first.tombstonePath)
  assert.throws(
    () => missingTombstone.open(),
    /tombstone database is missing/,
  )

  const missingMain = createWorkspace(test)
  const second = missingMain.open()
  second.close()
  unlinkSync(second.databasePath)
  assert.throws(
    () => missingMain.open(),
    /main database is missing/,
  )
})
