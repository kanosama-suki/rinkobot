/**
 * M3.2 长期记忆集成测试。
 *
 * 只使用占位正文；覆盖写入门槛、候选转正、中文双列检索、纠正、
 * 回收站、重启恢复、v3 → v4 迁移和彻底清除后的索引删除。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  KanobotMemoryService,
  MemoryInputError,
} from '../../src/core/memory/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('explicit remember is durable while ordinary small talk stays a candidate', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const stated = memory.remember({
      text: 'kano 喜欢早上喝咖啡。',
      kind: 'preference',
      source: 'user_stated',
      explicitlyRequested: true,
    })
    assert.equal(stated.status, 'active')
    assert.equal(stated.importance, 'important')
    assert.deepEqual(
      memory.search('咖啡', { markRecalled: false })
        .map(result => result.memory.id),
      [stated.id],
    )

    const ordinary = memory.remember({
      text: 'kano 今天提到外面在下雨。',
      kind: 'small_talk',
      source: 'user_stated',
    })
    assert.equal(ordinary.status, 'candidate')
    assert.equal(
      memory.search('下雨', { markRecalled: false }).length,
      0,
    )

    const candidates = [
      memory.remember({
        text: 'kano 可能更喜欢安静的书店。',
        kind: 'preference',
        source: 'rinko_inferred',
        confidence: 0.55,
      }),
      memory.remember({
        text: '网上看到一家新开的茶店。',
        kind: 'externally_seen',
        source: 'external',
      }),
      memory.remember({
        text: 'kano 提到过一件敏感的家庭安排。',
        kind: 'life_event',
        source: 'user_stated',
        sensitivity: 'sensitive',
      }),
      memory.remember({
        text: 'kano 的朋友最近换了工作。',
        kind: 'third_party',
        source: 'user_stated',
        sensitivity: 'third_party',
      }),
    ]
    assert.ok(candidates.every(candidate => candidate.status === 'candidate'))
    assert.equal(memory.search('书店', { markRecalled: false }).length, 0)
    assert.equal(memory.listCandidates().length, 5)

    const promoted = memory.promote(candidates[0].id)
    assert.equal(promoted.status, 'active')
    assert.equal(
      memory.search('书店', { markRecalled: false })[0]?.memory.id,
      promoted.id,
    )
  } finally {
    store.close()
  }
})

test('Chinese word and single-character columns retrieve the expected memories', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const records = [
      memory.remember({
        text: 'kano 喜欢早上喝咖啡，不加糖。',
        kind: 'preference',
        source: 'user_stated',
        importance: 'important',
      }),
      memory.remember({
        text: '晚上泡茶要淡一点，不喝浓茶。',
        kind: 'preference',
        source: 'user_stated',
        importance: 'important',
      }),
      memory.remember({
        text: '她最近在做空气动力和网格的仿真。',
        kind: 'shared_experience',
        source: 'user_stated',
        importance: 'important',
      }),
      memory.remember({
        text: '周末想一起看一部老电影。',
        kind: 'plan',
        source: 'user_stated',
        importance: 'important',
      }),
      memory.remember({
        text: 'kano 的生日是三月十四日。',
        kind: 'personal_fact',
        source: 'user_stated',
        importance: 'important',
      }),
    ]
    const expectations: Array<[string, string]> = [
      ['咖啡', records[0].id],
      ['茶', records[1].id],
      ['仿真', records[2].id],
      ['网格', records[2].id],
      ['空气动力', records[2].id],
      ['电影', records[3].id],
      ['生日', records[4].id],
    ]
    for (const [query, expectedId] of expectations) {
      const results = memory.search(query, {
        limit: 10,
        markRecalled: false,
      })
      assert.ok(
        results.some(result => result.memory.id === expectedId),
        `query "${query}" should retrieve ${expectedId}`,
      )
    }
    assert.deepEqual(
      memory.search('完全不存在的词', { markRecalled: false }),
      [],
    )

    const recalled = memory.search('咖啡')
    assert.equal(recalled[0]?.memory.id, records[0].id)
    assert.equal(
      store.getMemory(records[0].id)?.lastRecalledAt,
      '2026-11-05T00:00:00.000Z',
    )
  } finally {
    store.close()
  }
})

test('a correction replaces the old searchable memory atomically', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const old = memory.remember({
      text: 'kano 喜欢用蓝色杯子。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    })
    const replacement = memory.correct(old.id, {
      text: 'kano 现在喜欢用绿色杯子。',
      kind: 'preference',
      importance: 'important',
    })

    assert.equal(replacement.status, 'active')
    const superseded = store.getMemory(old.id)
    assert.equal(superseded?.status, 'replaced')
    assert.equal(superseded?.replacedBy, replacement.id)
    assert.equal(
      memory.search('蓝色', { markRecalled: false }).length,
      0,
    )
    assert.equal(
      memory.search('绿色', { markRecalled: false })[0]?.memory.id,
      replacement.id,
    )
  } finally {
    store.close()
  }
})

test('trash hides a memory from search and restore brings the index back', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const record = memory.remember({
      text: 'kano 喜欢在雨天听爵士乐。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    })
    store.trashMemory(record.id, '2026-11-05T10:00:00.000Z')
    assert.equal(
      memory.search('爵士乐', { markRecalled: false }).length,
      0,
    )
    assert.equal(memory.listTrash().length, 1)

    const restored = store.restoreMemory(
      record.id,
      '2026-11-06T10:00:00.000Z',
    )
    assert.equal(restored.status, 'active')
    assert.equal(
      memory.search('爵士乐', { markRecalled: false })[0]?.memory.id,
      record.id,
    )
  } finally {
    store.close()
  }
})

test('active memory search survives restart and a v3 to v6 migration', () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  let memoryId: string
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    memoryId = memory.remember({
      text: 'kano 喜欢窗边的座位。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    }).id
  } finally {
    store.close()
  }

  const db = new DatabaseSync(join(ws.root, 'kanobot.sqlite'))
  try {
    db.exec('DROP TABLE reply_style_checks')
    db.exec('DROP TABLE owner_audit')
    db.exec('DROP TABLE emergency_state')
    db.exec('DROP TABLE memory_search')
    db.exec('DROP INDEX model_calls_purpose_index')
    db.exec('ALTER TABLE model_calls DROP COLUMN purpose')
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(8)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(7)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(6)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(5)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(4)
    db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(3, '2026-11-05T00:00:00.000Z')
    db.exec('PRAGMA user_version = 3')
  } finally {
    db.close()
  }

  store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    assert.equal(
      memory.search('窗边', { markRecalled: false })[0]?.memory.id,
      memoryId,
    )
    const check = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const versions = check.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        versions.map(row => Number(row.version)),
        [3, 4, 5, 6, 7, 8],
      )
    } finally {
      check.close()
    }
  } finally {
    store.close()
  }
})

test('purging a memory removes its FTS row as well as its body', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const record = memory.remember({
      text: '待清除的唯一记忆 KB-MEMORY-PURGE-42',
      kind: 'note',
      source: 'user_stated',
      importance: 'important',
    })
    assert.equal(
      memory.search('KB-MEMORY-PURGE-42', { markRecalled: false })[0]
        ?.memory.id,
      record.id,
    )

    store.purgeMemory(record.id)
    assert.equal(store.getMemory(record.id), null)
    assert.equal(
      memory.search('KB-MEMORY-PURGE-42', { markRecalled: false }).length,
      0,
    )
  } finally {
    store.close()
  }
})

test('invalid memory text is rejected before writing any body', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    assert.throws(
      () => memory.remember({
        text: '   ',
        kind: 'preference',
        source: 'user_stated',
      }),
      (error: unknown) =>
        error instanceof MemoryInputError && error.code === 'invalid_text',
    )
    assert.deepEqual(store.listMemories(), [])
  } finally {
    store.close()
  }
})
