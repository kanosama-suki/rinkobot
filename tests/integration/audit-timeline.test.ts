/**
 * 统一审计时间线测试。
 *
 * 混合所有者操作、记忆、模型调用、风格检查和聊天回合元数据；验证排序、
 * 来源过滤和 limit，并直接扫描序列化结果确认没有正文或提示词泄漏。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KanobotChatService,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import {
  AuditTimelineService,
  OwnerAuditService,
} from '../../src/core/observability/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('the unified audit merges sources without leaking prompt or reply text', async t => {
  const ws = createWorkspace(t)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const memorySecret = '虚构记忆正文-KB-AUDIT-MEMORY'
    const record = memory.addByOwner({
      text: memorySecret,
      kind: 'preference',
      importance: 'normal',
      sensitivity: 'normal',
    })
    new OwnerAuditService(store, ws.clock).record({
      action: 'memory.create',
      targetType: 'memory',
      targetId: record.id,
      occurredAt: '2026-11-05T00:00:02.000Z',
    })

    const chat = new KanobotChatService(store, new AuditChatModel())
    const events = await collect(
      chat,
      '虚构用户正文-KB-AUDIT-USER',
    )
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')

    const timeline = new AuditTimelineService(store)
    const all = timeline.list(100)
    const sources = new Set(all.map(entry => entry.source))
    for (const source of ['owner', 'memory', 'model', 'style', 'chat']) {
      assert.ok(sources.has(source as typeof all[number]['source']), source)
    }
    assert.deepEqual(
      all.map(entry => entry.occurredAt),
      [...all.map(entry => entry.occurredAt)].sort().reverse(),
    )

    const serialized = JSON.stringify(all)
    assert.equal(serialized.includes(memorySecret), false)
    assert.equal(serialized.includes('虚构用户正文-KB-AUDIT-USER'), false)
    assert.equal(serialized.includes('虚构回复正文-KB-AUDIT-REPLY'), false)
    assert.equal(serialized.includes('reply must be'), false)

    const modelOnly = timeline.list(100, 'model')
    assert.ok(modelOnly.length >= 1)
    assert.ok(modelOnly.every(entry => entry.source === 'model'))
    assert.equal(timeline.list(2).length, 2)

    const style = all.find(entry => entry.source === 'style')
    assert.ok(style?.style)
    assert.equal(style.style.ok, true)

    const chatEntry = all.find(entry => entry.source === 'chat')
    assert.ok(chatEntry?.chat)
    assert.equal(chatEntry.targetId, done.message.id)
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

class AuditChatModel implements ChatModel {
  readonly id = 'audit-test-model'
  readonly mode = 'mock'
  readonly provider = 'test'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield {
      type: 'text',
      text: chatEnvelopeText('虚构回复正文-KB-AUDIT-REPLY。'),
    }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: 'audit-response',
      },
    }
  }
}
