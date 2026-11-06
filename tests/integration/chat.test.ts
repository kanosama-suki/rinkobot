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
  ChatModelError,
  KanobotChatService,
  MockChatModel,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import {
  createWorkspace,
  dropCurrentInitiativeTables,
  tickEvent,
} from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

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
    assert.equal(view.state.lastSequence, 2)
    assert.equal(view.state.eventCount, 2)
    assert.ok(Math.abs(view.state.affect.valence - 0.1275) < 1e-9)
    assert.equal(view.state.commitments.total, 0)
    assert.ok(view.messages.every(message => message.bodyId.startsWith('body-')))

    const db = new DatabaseSync(join(ws.root, 'kanobot.sqlite'), {
      readOnly: true,
    })
    try {
      const rows = db.prepare(
        `SELECT event_type, payload_json, evidence_refs_json
         FROM events ORDER BY seq`,
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        rows.map(row => row.event_type),
        ['interaction.recorded', 'appraisal.recorded'],
      )
      const stored = JSON.stringify(rows)
      assert.equal(stored.includes('这是一条虚构的 M3 测试消息'), false)
      const evidenceRefs = JSON.parse(
        String(rows[0]?.evidence_refs_json),
      ) as string[]
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
    assert.equal(view.state.lastSequence, 2)
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
      (error: unknown) =>
        error instanceof ChatInputError && error.code === 'model_unavailable',
    )
    const view = chat.conversation()
    assert.equal(view.messages.length, 1)
    assert.equal(view.messages[0]?.role, 'user')
    assert.equal(view.state.messageCount, 1)
    assert.equal(view.state.eventCount, 0)
    assert.equal(view.state.lastSequence, 0)
    const call = store.latestModelCall()
    assert.equal(call?.status, 'failed')
    assert.equal(call?.attempts, 2)
    assert.equal(call?.errorCode, 'model_unavailable')
    assert.equal(call?.assistantMessageId, null)
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
    db.exec('DROP TABLE reply_style_checks')
    db.exec('DROP TABLE owner_audit')
    db.exec('DROP TABLE emergency_state')
    db.exec('DROP TABLE memory_search')
    db.exec('DROP TABLE model_calls')
    db.exec('DROP TABLE messages')
    db.exec('DROP TABLE conversations')
    dropCurrentInitiativeTables(db)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(9)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(8)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(7)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(6)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(5)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(4)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(3)
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
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      )
      const modelCalls = check.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_calls'",
      ).all()
      assert.equal(modelCalls.length, 1)
    } finally {
      check.close()
    }
  } finally {
    reopened.close()
  }
})

test('an M3.0 schema v2 migrates to the current schema without losing chat records', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: 'v2 升级前保留的虚构消息',
    })
  } finally {
    store.close()
  }

  const db = new DatabaseSync(join(ws.root, 'kanobot.sqlite'))
  try {
    db.exec('DROP TABLE reply_style_checks')
    db.exec('DROP TABLE owner_audit')
    db.exec('DROP TABLE emergency_state')
    db.exec('DROP TABLE memory_search')
    db.exec('DROP TABLE model_calls')
    dropCurrentInitiativeTables(db)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(9)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(8)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(7)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(6)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(5)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(4)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(3)
    db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(2, '2026-11-05T00:00:00.000Z')
    db.exec('PRAGMA user_version = 2')
  } finally {
    db.close()
  }

  const reopened = ws.open()
  try {
    assert.equal(reopened.chatMessageCount(), 1)
    const check = new DatabaseSync(reopened.databasePath, { readOnly: true })
    try {
      const versions = check.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        versions.map(row => Number(row.version)),
        [2, 3, 4, 5, 6, 7, 8, 9],
      )
    } finally {
      check.close()
    }
  } finally {
    reopened.close()
  }
})

test('successful model usage is audited and survives reopen', async () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  try {
    const chat = new KanobotChatService(store, new UsageChatModel())
    const events = await collect(chat, '记录虚构 token 用量')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.modelCall.status, 'succeeded')
    assert.equal(done.modelCall.attempts, 2)
    assert.equal(done.modelCall.usage?.inputTokens, 42)
    assert.equal(done.modelCall.estimatedCost, 0.00000738)
    assert.equal(done.modelUsage.todayCallCount, 1)
    assert.equal(done.envelope.ok, true)

    const call = store.latestModelCall()
    assert.equal(call?.status, 'succeeded')
    assert.equal(call?.assistantMessageId, done.message.id)
    assert.equal(call?.provider, 'magpie')
    assert.equal(call?.model, 'deepseek/deepseek-flash')
    assert.equal(call?.cacheReadTokens, 10)
    assert.equal(call?.reasoningTokens, 9)
    assert.equal(call?.responseId, 'resp-test-1')
  } finally {
    store.close()
  }

  store = ws.open()
  try {
    const call = store.latestModelCall()
    assert.equal(call?.status, 'succeeded')
    assert.equal(call?.totalTokens, 53)
    assert.equal(store.modelCallCountToday(), 1)
  } finally {
    store.close()
  }
})

test('purging either side of a chat turn cascades its model call audit', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new UsageChatModel())
    await collect(chat, '待清除模型调用审计的虚构消息')
    const view = chat.conversation()
    const assistant = view.messages.find(message => message.role === 'assistant')
    assert.ok(assistant)
    assert.ok(store.latestModelCall())

    store.purgeChatMessage(assistant.id)
    assert.equal(store.latestModelCall(), null)
  } finally {
    store.close()
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
  readonly provider = 'test'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield { type: 'text', text: '不应落库的半截回复' }
    throw new ChatModelError(
      'model_unavailable',
      'connection lost',
      2,
    )
  }
}

class UsageChatModel implements ChatModel {
  readonly id = 'deepseek/deepseek-flash'
  readonly mode = 'magpie'
  readonly provider = 'magpie'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield {
      type: 'text',
      text: chatEnvelopeText('这是带用量的虚构回复。'),
    }
    yield {
      type: 'result',
      result: {
        attempts: 2,
        usage: {
          inputTokens: 42,
          outputTokens: 11,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          reasoningTokens: 9,
          totalTokens: 53,
        },
        estimatedCost: 0.00000738,
        pricing: {
          prompt: 0.00000015,
          completion: 0.0000006,
          cacheRead: 0.000000003,
          cacheWrite: null,
        },
        responseId: 'resp-test-1',
      },
    }
  }
}
