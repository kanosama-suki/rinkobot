/**
 * schema v10 → v11 渠道表迁移测试。
 *
 * 用真实 v10 表形状验证迁移不丢聊天记录，并检查入站去重、渠道审计
 * 和过期清理。渠道审计不得保存消息正文或图片数据。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  createWorkspace,
  dropCurrentChannelTables,
} from '../helpers/storage-fixture.ts'

test('v10 migrates to v11 and channel state survives a clean reopen', () => {
  const ws = createWorkspace(test, { now: '2026-11-07T02:00:00.000Z' })
  let store = ws.open()
  try {
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '升级前保留的虚构消息。',
      createdAt: '2026-11-07T01:00:00.000Z',
    })
  } finally {
    store.close()
  }

  const databasePath = join(ws.root, 'kanobot.sqlite')
  const db = new DatabaseSync(databasePath)
  try {
    dropCurrentChannelTables(db)
    db.exec('ALTER TABLE conversations DROP COLUMN display_name')
    db.exec('DELETE FROM schema_migrations')
    const insert = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (let version = 1; version <= 10; version += 1) {
      insert.run(version, '2026-11-07T01:00:00.000Z')
    }
    db.exec('PRAGMA user_version = 10')
  } finally {
    db.close()
  }

  store = ws.open()
  try {
    assert.equal(store.chatMessageCount('main'), 1)
    assert.equal(
      store.listChatMessages('main', 10)[0]?.text,
      '升级前保留的虚构消息。',
    )
    assert.equal(
      store.claimChannelInbound({
        channel: 'qq',
        messageKey: 'qq:private:10001:1',
        conversationKey: 'qq-private-10001',
        receivedAt: '2026-11-07T02:00:00.000Z',
        expiresAt: '2026-11-08T02:00:00.000Z',
      }),
      true,
    )
    assert.equal(
      store.claimChannelInbound({
        channel: 'qq',
        messageKey: 'qq:private:10001:1',
        conversationKey: 'qq-private-10001',
        receivedAt: '2026-11-07T02:00:00.000Z',
        expiresAt: '2026-11-08T02:00:00.000Z',
      }),
      false,
    )
    assert.equal(
      store.purgeExpiredChannelInbound('2026-11-08T02:00:00.000Z'),
      1,
    )
    store.recordChannelAudit({
      channel: 'qq',
      direction: 'inbound',
      kind: 'message.received',
      outcome: 'succeeded',
      targetId: 'private:10001',
      detailCode: null,
      occurredAt: '2026-11-07T02:00:00.000Z',
    })
    assert.equal(store.listChannelAudit(10)[0]?.kind, 'message.received')
  } finally {
    store.close()
  }

  const check = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const versions = check.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<Record<string, unknown>>
    assert.deepEqual(
      versions.map(row => Number(row.version)),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    )
    assert.ok(tableExists(check, 'channel_inbound'))
    assert.ok(tableExists(check, 'channel_audit'))
    const audit = JSON.stringify(
      check.prepare('SELECT * FROM channel_audit').all(),
    )
    assert.equal(audit.includes('升级前保留的虚构消息。'), false)
    assert.equal(audit.includes('图片'), false)
  } finally {
    check.close()
  }
})

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as Record<string, unknown> | undefined
  return row?.name === name
}
