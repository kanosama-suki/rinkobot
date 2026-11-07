/**
 * 聊天服务的资源熔断测试。
 *
 * 每日额度按模型调用审计行计数；并发额度按当前实例内尚未结束的流计数。
 * 两者都在写入用户正文之前拒绝，避免额度耗尽时继续堆积消息。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ChatModelBudget,
  ChatInputError,
  KanobotChatService,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('the daily model call limit rejects before storing another user message', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new ImmediateChatModel(), {
      dailyModelCallLimit: 1,
      maxConcurrentModelCalls: 2,
    })
    await collect(chat, '第一条虚构消息')
    assert.equal(store.chatMessageCount(), 2)
    assert.equal(store.modelCallCountToday(), 1)

    await assert.rejects(
      collect(chat, '超过每日额度的虚构消息'),
      (error: unknown) =>
        error instanceof ChatInputError &&
        error.code === 'daily_model_call_limit_reached',
    )
    assert.equal(store.chatMessageCount(), 2)
    assert.equal(store.modelCallCountToday(), 1)
  } finally {
    store.close()
  }
})

test('the concurrency limit rejects a second in-flight call and audits the aborted one', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const controller = new AbortController()
  try {
    const model = new BlockingChatModel()
    const chat = new KanobotChatService(store, model, {
      dailyModelCallLimit: 10,
      maxConcurrentModelCalls: 1,
    })
    const iterator = chat
      .streamMessage('第一条并发虚构消息', controller.signal)
      [Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.type, 'ready')
    assert.equal((await iterator.next()).value?.type, 'delta')

    await assert.rejects(
      collect(chat, '第二条并发虚构消息'),
      (error: unknown) =>
        error instanceof ChatInputError &&
        error.code === 'model_capacity_reached',
    )
    assert.equal(store.chatMessageCount(), 1)

    controller.abort()
    await assert.rejects(iterator.next(), /aborted/)
    assert.equal(store.chatMessageCount(), 1)
    assert.equal(store.latestModelCall()?.status, 'aborted')
  } finally {
    store.close()
  }
})

test('separate web and QQ chat services share one concurrency budget', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const controller = new AbortController()
  try {
    const budget = new ChatModelBudget({
      dailyModelCallLimit: 10,
      maxConcurrentModelCalls: 1,
    })
    const web = new KanobotChatService(store, new BlockingChatModel(), {
      modelBudget: budget,
    })
    const qq = new KanobotChatService(
      store,
      new ImmediateChatModel(),
      {
        conversationId: 'qq-private-10001',
        modelBudget: budget,
      },
    )

    const iterator = web
      .streamMessage('网页正在处理的虚构消息', controller.signal)
      [Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.type, 'ready')
    assert.equal((await iterator.next()).value?.type, 'delta')

    await assert.rejects(
      collect(qq, 'QQ 不应该获得第二个并发槽'),
      (error: unknown) =>
        error instanceof ChatInputError &&
        error.code === 'model_capacity_reached',
    )

    controller.abort()
    await assert.rejects(iterator.next(), /aborted/)
    assert.equal(budget.snapshot().activeModelCalls, 0)
    assert.equal(budget.snapshot().reservedModelCalls, 0)
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

class ImmediateChatModel implements ChatModel {
  readonly id = 'immediate-limit-test'
  readonly mode = 'test'
  readonly provider = 'test'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield { type: 'text', text: chatEnvelopeText('立即返回的虚构回复。') }
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

class BlockingChatModel implements ChatModel {
  readonly id = 'blocking-limit-test'
  readonly mode = 'test'
  readonly provider = 'test'

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield {
      type: 'text',
      text: '{"schemaVersion":1,"reply":"已开始但尚未结束的虚构回复。',
    }
    await new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => {
        const error = new Error('aborted by test')
        error.name = 'AbortError'
        reject(error)
      }
      if (request.signal.aborted) {
        onAbort()
        return
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
