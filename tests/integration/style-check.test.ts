/**
 * 聊天完成后的风格检查与持久化测试。
 *
 * 只保存违规代码，不把回复正文复制进检查表；正文仍只在 bodies。
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  KanobotChatService,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('a banned phrase is recorded as a style violation without copying text', async t => {
  const ws = createWorkspace(t)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new BannedReplyModel())
    const events: ChatStreamEvent[] = []
    for await (const event of chat.streamMessage(
      '这条消息只用于测试风格检查。',
      new AbortController().signal,
    )) {
      events.push(event)
    }
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.styleCheck.ok, false)
    assert.deepEqual(
      done.styleCheck.violations.map(violation => violation.code),
      ['banned_phrase'],
    )

    const persisted = store.getReplyStyleCheck(done.message.id)
    assert.ok(persisted)
    assert.equal(persisted.ok, false)
    assert.deepEqual(persisted.violationCodes, ['banned_phrase'])
    assert.equal(persisted.retryCount, 1)
    assert.deepEqual(persisted.initialViolationCodes, ['banned_phrase'])
    assert.equal(done.styleRetry.attempted, true)
    assert.equal(done.styleRetry.reason, 'style_check')
    assert.equal(done.styleRetry.discardedModelCall?.status, 'failed')
    assert.equal(
      done.styleRetry.discardedModelCall?.errorCode,
      'style_retry_requested',
    )
    assert.equal(store.modelCallCountToday(), 2)
    assert.equal(store.chatMessageCount(), 2)

    const db = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const row = db.prepare('SELECT * FROM reply_style_checks').get() as
        | Record<string, unknown>
        | undefined
      assert.ok(row)
      assert.equal(JSON.stringify(row).includes('作为AI'), false)
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
})

test('a failed style check regenerates once and keeps only the revised reply', async t => {
  const ws = createWorkspace(t)
  const store = ws.open()
  try {
    const model = new RetryThenPassModel()
    const chat = new KanobotChatService(store, model)
    const events = await collect(chat, '这条虚构消息会触发一次风格重写。')
    const retryIndex = events.findIndex(event => event.type === 'retry')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.ok(retryIndex > 0)
    assert.equal(model.calls, 2)
    assert.equal(done.message.text, '今天先早点休息，别熬太晚。')
    assert.equal(done.styleCheck.ok, true)
    assert.equal(done.styleRetry.attempted, true)
    assert.equal(done.styleRetry.discardedModelCall?.status, 'failed')
    assert.equal(done.modelCall.status, 'succeeded')
    assert.equal(done.modelUsage.todayCallCount, 2)
    assert.equal(store.chatMessageCount(), 2)

    const calls = store.listModelCalls(10)
    assert.equal(calls.length, 2)
    const discarded = calls.find(
      call => call.status === 'failed' && call.errorCode === 'style_retry_requested',
    )
    assert.ok(discarded)
    assert.equal(discarded.assistantMessageId, null)

    const persisted = store.getReplyStyleCheck(done.message.id)
    assert.ok(persisted)
    assert.equal(persisted.ok, true)
    assert.equal(persisted.retryCount, 1)
    assert.deepEqual(persisted.initialViolationCodes, ['banned_phrase'])
    assert.equal(JSON.stringify(persisted).includes('作为AI'), false)
  } finally {
    store.close()
  }
})

test('a daily limit stops the single style retry without losing the first reply', async t => {
  const ws = createWorkspace(t)
  const store = ws.open()
  try {
    const model = new BannedReplyModel()
    const chat = new KanobotChatService(store, model, {
      dailyModelCallLimit: 1,
    })
    const events = await collect(chat, '额度只够第一版的虚构消息。')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(events.some(event => event.type === 'retry'), false)
    assert.equal(done.styleCheck.ok, false)
    assert.equal(done.styleRetry.attempted, false)
    assert.equal(done.styleRetry.reason, 'daily_model_call_limit')
    assert.equal(store.modelCallCountToday(), 1)
    assert.equal(store.chatMessageCount(), 2)
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

class BannedReplyModel implements ChatModel {
  readonly id = 'style-test-model'
  readonly mode = 'mock'
  readonly provider = 'test'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield {
      type: 'text',
      text: chatEnvelopeText('作为AI，你应该早点休息。'),
    }
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

class RetryThenPassModel implements ChatModel {
  readonly id = 'style-retry-model'
  readonly mode = 'mock'
  readonly provider = 'test'
  calls = 0

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.calls += 1
    const reply = this.calls === 1
      ? '作为AI，你应该早点休息。'
      : '今天先早点休息，别熬太晚。'
    yield { type: 'text', text: chatEnvelopeText(reply) }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: `retry-response-${this.calls}`,
      },
    }
  }
}
