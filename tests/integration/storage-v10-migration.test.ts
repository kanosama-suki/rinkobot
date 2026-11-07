/**
 * schema v9 → v10 记忆边界迁移测试。
 *
 * 使用真实 v9 记忆表形状验证：canonical record 升到 schemaVersion 2、
 * explicitlyRequested 默认 false、旧候选得到 candidate_since 起点，并且
 * 历史 active/permanent 不会被冷却误归档。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import {
  createWorkspace,
  dropCurrentChannelTables,
  downgradeMemoriesToV9,
} from '../helpers/storage-fixture.ts'

test('v9 memories migrate with explicit flag and cooling eligibility', () => {
  const ws = createWorkspace(test, { now: '2026-11-05T00:00:00.000Z' })
  let store = ws.open()
  let candidateId = ''
  let activeId = ''
  let permanentId = ''
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    candidateId = memory.remember({
      text: '旧版本里的普通候选。',
      kind: 'small_talk',
      source: 'user_stated',
    }).id
    activeId = memory.remember({
      text: '旧版本里的重要事实。',
      kind: 'personal_fact',
      source: 'user_stated',
      importance: 'important',
    }).id
    permanentId = memory.remember({
      text: '旧版本里的永久事实。',
      kind: 'personal_fact',
      source: 'user_stated',
      importance: 'permanent',
    }).id
  } finally {
    store.close()
  }

  const databasePath = join(ws.root, 'kanobot.sqlite')
  const db = new DatabaseSync(databasePath)
  try {
    downgradeMemoriesToV9(db)
    dropCurrentChannelTables(db)
    db.exec('DELETE FROM schema_migrations')
    const insert = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (let version = 1; version <= 9; version += 1) {
      insert.run(version, '2026-11-05T00:00:00.000Z')
    }
    db.exec('PRAGMA user_version = 9')
  } finally {
    db.close()
  }

  store = ws.open()
  try {
    const check = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const rows = check.prepare(
        `SELECT id, schema_version, explicitly_requested, candidate_since,
                record_json
         FROM memories ORDER BY id`,
      ).all() as Array<Record<string, unknown>>
      assert.equal(rows.length, 3)
      for (const row of rows) {
        assert.equal(Number(row.schema_version), 2)
        assert.equal(Number(row.explicitly_requested), 0)
        const record = JSON.parse(String(row.record_json)) as Record<
          string,
          unknown
        >
        assert.equal(record.schemaVersion, 2)
        assert.equal(record.explicitlyRequested, false)
      }
      const candidateRow = rows.find(row => row.id === candidateId)
      assert.equal(
        candidateRow?.candidate_since,
        '2026-11-05T00:00:00.000Z',
      )
      const activeRow = rows.find(row => row.id === activeId)
      assert.equal(activeRow?.candidate_since, null)
      const permanentRow = rows.find(row => row.id === permanentId)
      assert.equal(permanentRow?.candidate_since, null)
      assert.ok(tableExists(check, 'memory_decisions'))
    } finally {
      check.close()
    }

    const memory = new KanobotMemoryService(store, ws.clock)
    const archived = memory.archiveExpiredCandidates(
      new Date('2027-01-01T00:00:00.000Z'),
    )
    assert.deepEqual(archived.map(record => record.id), [candidateId])
    assert.equal(store.getMemory(candidateId)?.status, 'archived')
    assert.equal(store.getMemory(activeId)?.status, 'active')
    assert.equal(store.getMemory(permanentId)?.status, 'active')
    assert.equal(store.listMemoryDecisions().length, 1)
  } finally {
    store.close()
  }
})

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as Record<string, unknown> | undefined
  return row?.name === name
}
