/**
 * schema v7 → v8 迁移测试。
 *
 * v8 只扩展风格检查审计：增加重试次数和初次违规代码。旧行必须默认成
 * “没有重写、没有初次违规”，且不丢失原有检查结果。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  createWorkspace,
  dropCurrentInitiativeTables,
  downgradeMemoriesToV9,
} from '../helpers/storage-fixture.ts'

test('a v7 style check table migrates to v8 without copying reply text', () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  let oldAssistantId: string
  let newAssistantId: string
  try {
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: 'v8 迁移前的虚构用户消息',
    })
    const oldAssistant = store.appendChatMessage({
      conversationId: 'main',
      role: 'assistant',
      text: 'v8 迁移前保留的虚构回复',
    })
    oldAssistantId = oldAssistant.id
    store.putReplyStyleCheck({
      assistantMessageId: oldAssistant.id,
      ok: false,
      violationCodes: ['banned_phrase'],
      checkedAt: '2026-11-05T00:00:01.000Z',
    })

    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: 'v8 迁移后的虚构用户消息',
    })
    const newAssistant = store.appendChatMessage({
      conversationId: 'main',
      role: 'assistant',
      text: 'v8 迁移后的虚构回复',
    })
    newAssistantId = newAssistant.id
  } finally {
    store.close()
  }

  downgradeToV7(join(ws.root, 'kanobot.sqlite'))

  store = ws.open()
  try {
    const migrated = store.getReplyStyleCheck(oldAssistantId)
    assert.ok(migrated)
    assert.equal(migrated.retryCount, 0)
    assert.deepEqual(migrated.initialViolationCodes, [])
    assert.deepEqual(migrated.violationCodes, ['banned_phrase'])

    const retried = store.putReplyStyleCheck({
      assistantMessageId: newAssistantId,
      ok: true,
      violationCodes: [],
      retryCount: 1,
      initialViolationCodes: ['banned_phrase'],
      checkedAt: '2026-11-05T00:00:02.000Z',
    })
    assert.equal(retried.retryCount, 1)
    assert.deepEqual(retried.initialViolationCodes, ['banned_phrase'])

    const db = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const versions = db.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        versions.map(row => Number(row.version)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      )
      const inspection = db.prepare(
        `SELECT * FROM reply_style_checks
         ORDER BY checked_at`,
      ).all() as Array<Record<string, unknown>>
      assert.equal(JSON.stringify(inspection).includes('虚构回复'), false)
      assert.equal(JSON.stringify(inspection).includes('迁移前保留'), false)
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
})

function downgradeToV7(databasePath: string): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`
      CREATE TABLE reply_style_checks_v7 (
        id TEXT PRIMARY KEY,
        assistant_message_id TEXT NOT NULL UNIQUE
          REFERENCES messages(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        violation_codes_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO reply_style_checks_v7
        (id, assistant_message_id, schema_version, ok,
         violation_codes_json, checked_at)
      SELECT id, assistant_message_id, schema_version, ok,
             violation_codes_json, checked_at
      FROM reply_style_checks;
      DROP TABLE reply_style_checks;
      ALTER TABLE reply_style_checks_v7 RENAME TO reply_style_checks;
      CREATE INDEX reply_style_checks_checked_at_index
        ON reply_style_checks(checked_at);
    `)
    dropCurrentInitiativeTables(db)
    downgradeMemoriesToV9(db)
    db.exec('DELETE FROM schema_migrations')
    const migration = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (let version = 1; version <= 7; version += 1) {
      migration.run(version, '2026-11-05T00:00:00.000Z')
    }
    db.exec('PRAGMA user_version = 7')
  } finally {
    db.close()
  }
}
