/**
 * schema v11 → v12 会话名称迁移测试。
 *
 * 用真实 v11 表形状确认旧会话保留、display_name 默认 NULL，并验证
 * 改名在重启后仍然存在。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createWorkspace } from '../helpers/storage-fixture.ts'

test('v11 migrates to v12 and conversation names persist across reopen', () => {
  const ws = createWorkspace(test, { now: '2026-11-08T04:00:00.000Z' })
  let store = ws.open()
  try {
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '迁移前保留的主会话虚构消息。',
      createdAt: '2026-11-08T03:00:00.000Z',
    })
    store.appendChatMessage({
      conversationId: 'qq-private-40004',
      role: 'user',
      text: '迁移前保留的私聊虚构消息。',
      createdAt: '2026-11-08T03:01:00.000Z',
    })
  } finally {
    store.close()
  }

  const databasePath = join(ws.root, 'kanobot.sqlite')
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('ALTER TABLE conversations DROP COLUMN display_name')
    db.exec('DELETE FROM schema_migrations')
    const insert = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (let version = 1; version <= 11; version += 1) {
      insert.run(version, '2026-11-08T03:00:00.000Z')
    }
    db.exec('PRAGMA user_version = 11')
  } finally {
    db.close()
  }

  store = ws.open()
  try {
    assert.equal(store.chatMessageCount('main'), 1)
    assert.equal(
      store.listChatMessages('main', 10)[0]?.text,
      '迁移前保留的主会话虚构消息。',
    )
    assert.equal(store.getConversation('qq-private-40004')?.displayName, null)
    store.renameConversation('qq-private-40004', '  夜间私聊  ')
    assert.equal(
      store.getConversation('qq-private-40004')?.displayName,
      '夜间私聊',
    )
    store.appendChatMessage({
      conversationId: 'qq-private-40004',
      role: 'assistant',
      text: '迁移后的虚构回复。',
      createdAt: '2026-11-08T04:01:00.000Z',
    })
  } finally {
    store.close()
  }

  store = ws.open()
  try {
    assert.equal(
      store.getConversation('qq-private-40004')?.displayName,
      '夜间私聊',
    )
    assert.equal(store.chatMessageCount('qq-private-40004'), 2)
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
    const columns = check.prepare(
      'PRAGMA table_info("conversations")',
    ).all() as Array<Record<string, unknown>>
    assert.ok(columns.some(column => column.name === 'display_name'))
  } finally {
    check.close()
  }
})
