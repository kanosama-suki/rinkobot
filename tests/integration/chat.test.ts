/**
 * M3.0 聊天核心集成测试。
 *
 * 只使用占位人格和虚构正文；验证 mock 流、事件引用、旧 schema 迁移、
 * 重启恢复和正文清除后的消息级联。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  ChatInputError,
  KanobotChatService,
  MockChatModel,
  type ChatModel,
  type ChatModelRequest,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { createWorkspace, tickEvent } from '../helpers/storage-fixture.ts'

test('mock chat streams and survives a clean reopen', async () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  try {
    const chat = new KanobotChatService(store, new MockChatModel())
    const events = await collect(chat, '这是一条虚构的 M3 测试消息')
    const ready = events.find(event => event.type === 'ready')
    const done = events.find(event => event.type === 'done')
    assert.equal(ready?.type, 'ready')
    assert.equal(done?.type, 'done')
    assert.ok(events.filter(event => event.type === 'delta').length > 1)
    assert.ok(
      done?.type === 'done' &&
        done.message.text.includes('这是一条虚构的 M3 测试消息'),
    )
    const view = chat.conversation()
    assert.equal(view.messages.length, 2)
    assert.equal(view.state.lastSequence, 1)
    assert.equal(view.state.eventCount, 1)
    assert.ok(view.messages.every(message => message.bodyId.startsWith('body-')))

    const db = new DatabaseSync(join(ws.root, 'kanobot.sqlite'), {
      readOnly: true,
    })
    try {
      const row = db.prepare(
        `SELECT event_type, payload_json, evidence_refs_json
         FROM events`,
      ).get() as Record<string, unknown> | undefined
      assert.equal(row?.event_type, 'interaction.recorded')
      const stored = JSON.stringify(row)
      assert.equal(stored.includes('这是一条虚构的 M3 测试消息'), false)
      const evidenceRefs = JSON.parse(String(row?.evidence_refs_json)) as string[]
      assert.deepEqual(
        evidenceRefs,
        view.messages.map(message => message.bodyId),
      )
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }

  store = ws.open()
  try {
    const chat = new KanobotChatService(store, new MockChatModel())
    const view = chat.conversation()
    assert.equal(view.messages.length, 2)
    assert.deepEqual(
      view.messages.map(message => message.role),
      ['user', 'assistant'],
    )
    assert.equal(view.state.messageCount, 2)
    assert.equal(view.state.lastSequence, 1)
  } finally {
    store.close()
  }
})

test('a failed model keeps the user message but stores no partial reply or event', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new FailingChatModel())
    await assert.rejects(
      collect(chat, '这条虚构消息会成功保存，但回复会失败'),
      /connection lost/,
    )
    const view = chat.conversation()
    assert.equal(view.messages.length, 1)
    assert.equal(view.messages[0]?.role, 'user')
    assert.equal(view.state.messageCount, 1)
    assert.equal(view.state.eventCount, 0)
    assert.equal(view.state.lastSequence, 0)
  } finally {
    store.close()
  }
})

test('invalid chat input is rejected before any message is stored', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new MockChatModel())
    await assert.rejects(
      collect(chat, '   '),
      (error: unknown) =>
        error instanceof ChatInputError && error.code === 'invalid_message',
    )
    await assert.rejects(
      collect(chat, 'x'.repeat(4_001)),
      (error: unknown) =>
        error instanceof ChatInputError && error.code === 'invalid_message',
    )
    assert.equal(store.chatMessageCount(), 0)
  } finally {
    store.close()
  }
})

test('a purged chat body cascades its message without resurrecting it', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new MockChatModel())
    await collect(chat, '待清除的虚构聊天正文 KB-CHAT-6f21')
    const view = chat.conversation()
    const userMessage = view.messages.find(message => message.role === 'user')
    assert.ok(userMessage)
    const result = store.purgeChatMessage(userMessage.id)
    assert.equal(result.deletedMessages, 1)
    assert.equal(store.getChatMessage(userMessage.id), null)
    assert.equal(store.chatMessageCount(), 1)
  } finally {
    store.close()
  }
})

test('an M2 schema migrates in place and preserves existing records', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    store.putBody({
      id: 'body-v1-preserved',
      kind: 'note',
      content: 'M2 升级前已经存在的虚构正文',
      createdAt: '2026-11-05T00:00:00.000Z',
    })
    store.appendEvent(tickEvent('event-v1-preserved'))
  } finally {
    store.close()
  }

  const db = new DatabaseSync(join(ws.root, 'kanobot.sqlite'))
  try {
    db.exec('DROP TABLE messages')
    db.exec('DROP TABLE conversations')
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(2)
    db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(1, '2026-11-05T00:00:00.000Z')
    db.exec('PRAGMA user_version = 1')
  } finally {
    db.close()
  }

  const reopened = ws.open()
  try {
    assert.equal(reopened.getBody('body-v1-preserved')?.content, 'M2 升级前已经存在的虚构正文')
    assert.equal(reopened.lastSequence, 1)
    reopened.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '迁移后的虚构消息',
    })
    assert.equal(reopened.chatMessageCount(), 1)
    const check = new DatabaseSync(reopened.databasePath, { readOnly: true })
    try {
      const versions = check.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        versions.map(row => Number(row.version)),
        [1, 2],
      )
    } finally {
      check.close()
    }
  } finally {
    reopened.close()
  }
})

async function collect(
  chat: KanobotChatService,
  text: string,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const event of chat.streamMessage(text, new AbortController().signal)) {
    events.push(event)
  }
  return events
}

class FailingChatModel implements ChatModel {
  readonly id = 'failing-test-model'
  readonly mode = 'test'

  async *stream(_request: ChatModelRequest): AsyncIterable<string> {
    yield '不应落库的半截回复'
    throw new Error('connection lost')
  }
}
