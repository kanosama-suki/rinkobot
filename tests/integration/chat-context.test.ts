/**
 * M3.6 上下文预算与时间感知的聊天服务测试。
 *
 * mock 模型只记录收到的请求并返回固定信封；测试不联网，也不接触真实
 * DSH Profile。固定时钟让“当前时间”和“距上次发言”可重复验证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CHAT_CONTEXT_BUDGET,
  KanobotChatService,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('chat injects current time and elapsed silence without duplicating the current message', async () => {
  const ws = createWorkspace(test, {
    now: '2026-11-05T00:30:00.000Z',
  })
  const store = ws.open()
  try {
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '更早的虚构消息一',
      createdAt: '2026-11-04T21:00:00.000Z',
    })
    store.appendChatMessage({
      conversationId: 'main',
      role: 'assistant',
      text: '更早的虚构回复一',
      createdAt: '2026-11-04T21:01:00.000Z',
    })
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '更早的虚构消息二',
      createdAt: '2026-11-04T22:30:00.000Z',
    })
    store.appendChatMessage({
      conversationId: 'main',
      role: 'assistant',
      text: '更早的虚构回复二',
      createdAt: '2026-11-04T22:31:00.000Z',
    })

    const model = new CapturingModel()
    const chat = new KanobotChatService(store, model, {
      clock: ws.clock,
      timezone: 'Asia/Shanghai',
      context: {
        ...DEFAULT_CHAT_CONTEXT_BUDGET,
        maxHistoryMessages: 2,
      },
    })
    const current = '现在几点？我刚醒。'
    const events = await collect(chat, current)
    const ready = events.find(event => event.type === 'ready')
    assert.ok(ready?.type === 'ready')

    const request = model.lastRequest
    assert.ok(request)
    assert.match(request.systemPrompt, /2026-11-05 星期四 08:30/)
    assert.match(request.systemPrompt, /UTC 2026-11-05T00:30:00\.000Z/)
    assert.match(request.systemPrompt, /约 2 小时前/)
    assert.deepEqual(
      request.messages.map(message => message.role),
      ['user', 'assistant', 'user'],
    )
    assert.equal(
      request.messages.filter(message => message.text === current).length,
      1,
    )
    assert.equal(request.messages.at(-1)?.text, current)
  } finally {
    store.close()
  }
})

test('a message over the configured context limit is rejected before storage', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new CapturingModel(), {
      context: {
        ...DEFAULT_CHAT_CONTEXT_BUDGET,
        maxMessageChars: 10,
      },
    })
    await assert.rejects(
      collect(chat, '这条消息超过上下文单条上限'),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'context_budget_exceeded',
    )
    assert.equal(store.chatMessageCount(), 0)
  } finally {
    store.close()
  }
})

test('only memories that actually enter the prompt are marked recalled', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const first = memory.remember({
      text: 'kano 喜欢雨天听爵士乐。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    })
    const second = memory.remember({
      text: 'kano 曾经在雨天的咖啡馆听爵士乐。',
      kind: 'experience',
      source: 'user_stated',
    })
    const model = new CapturingModel()
    const chat = new KanobotChatService(store, model, {
      memory,
      clock: ws.clock,
      context: {
        ...DEFAULT_CHAT_CONTEXT_BUDGET,
        // recall 只取一条；服务仍必须在组装完成后才标记 lastRecalledAt，
        // 不能把未进入提示词的第二条也算作“刚想起”。
        maxMemoryItems: 1,
      },
    })

    const events = await collect(chat, '雨天和爵士乐让我想起一些事。')
    const ready = events.find(event => event.type === 'ready')
    assert.ok(ready?.type === 'ready')
    assert.equal(ready.recalledMemoryCount, 1)
    assert.match(model.lastRequest?.systemPrompt ?? '', /爵士乐/)

    const recalled = [first, second].filter(
      record => store.getMemory(record.id)?.lastRecalledAt !== null,
    )
    assert.equal(recalled.length, 1)
  } finally {
    store.close()
  }
})

async function collect(
  chat: KanobotChatService,
  text: string,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const event of chat.streamMessage(
    text,
    new AbortController().signal,
  )) {
    events.push(event)
  }
  return events
}

class CapturingModel implements ChatModel {
  readonly id = 'context-capture-model'
  readonly mode = 'test'
  readonly provider = 'test'
  lastRequest: ChatModelRequest | null = null

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.lastRequest = request
    yield { type: 'text', text: chatEnvelopeText('这是虚构的上下文回复。') }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: null,
      },
    }
  }
}
