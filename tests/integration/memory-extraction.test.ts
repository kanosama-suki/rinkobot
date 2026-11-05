/**
 * M3.3 记忆抽取与聊天检索注入测试。
 *
 * 只使用虚构正文和内存模型；覆盖主动陈述、推断降级、敏感门槛、
 * 无效 JSON 的降级路径，以及检索结果进入系统提示词而不是伪装成用户消息。
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
import {
  KanobotMemoryService,
  MemoryExtractionService,
} from '../../src/core/memory/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('a user-stated preference becomes searchable and keeps exact evidence', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const model = new ScriptedModel({
      reply: '好，我记住了。',
      extraction: JSON.stringify({
        memories: [{
          text: 'kano 喜欢早上喝手冲咖啡。',
          quote: '我喜欢早上喝手冲咖啡',
          kind: 'preference',
          source: 'user_stated',
          sensitivity: 'normal',
          importance: 'important',
          confidence: 0.95,
        }],
      }),
    })
    const extraction = new MemoryExtractionService(store, memory, model, {
      clock: ws.clock,
    })
    const chat = new KanobotChatService(store, model, {
      memory,
      memoryExtraction: extraction,
    })

    const events = await collect(chat, '我喜欢早上喝手冲咖啡，记住这个。')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.status, 'succeeded')
    assert.equal(done.memory?.createdCount, 1)
    assert.equal(done.memory?.candidateCount, 0)

    const found = memory.search('咖啡', { markRecalled: false })
    assert.equal(found.length, 1)
    assert.equal(found[0]?.memory.status, 'active')
    assert.equal(found[0]?.memory.quoteRef !== null, true)
    assert.equal(
      store.getBody(found[0]!.memory.quoteRef!)?.content,
      '我喜欢早上喝手冲咖啡',
    )
    assert.equal(store.latestModelCall('main', 'chat')?.status, 'succeeded')
    assert.equal(
      store.latestModelCall('main', 'memory_extraction')?.status,
      'succeeded',
    )
    assert.equal(store.modelCallCountToday(), 2)
  } finally {
    store.close()
  }
})

test('a claim quoting the assistant reply is downgraded to a candidate', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const model = new ScriptedModel({
      reply: '我其实喜欢安静的书店。',
      extraction: JSON.stringify({
        memories: [{
          text: '燐子喜欢安静的书店。',
          quote: '我其实喜欢安静的书店。',
          kind: 'preference',
          source: 'user_stated',
          sensitivity: 'normal',
          importance: 'normal',
          confidence: 0.9,
        }],
      }),
    })
    const chat = new KanobotChatService(store, model, {
      memory,
      memoryExtraction: new MemoryExtractionService(store, memory, model, {
        clock: ws.clock,
      }),
    })

    const events = await collect(chat, '你喜欢什么样的书店？')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.candidateCount, 1)
    const candidates = memory.listCandidates()
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.source, 'rinko_inferred')
    assert.equal(
      memory.search('书店', { markRecalled: false }).length,
      0,
    )
  } finally {
    store.close()
  }
})

test('a sensitive statement cannot bypass the candidate gate', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const model = new ScriptedModel({
      reply: '这个先放在候选里。',
      extraction: JSON.stringify({
        memories: [{
          text: 'kano 的身份证号码需要保密。',
          quote: '我的身份证号是测试占位值',
          kind: 'personal_fact',
          source: 'user_stated',
          sensitivity: 'normal',
          importance: 'permanent',
          confidence: 1,
        }],
      }),
    })
    const chat = new KanobotChatService(store, model, {
      memory,
      memoryExtraction: new MemoryExtractionService(store, memory, model, {
        clock: ws.clock,
      }),
    })

    const events = await collect(chat, '我的身份证号是测试占位值，记住。')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.candidateCount, 1)
    const candidate = memory.listCandidates()[0]
    assert.equal(candidate?.sensitivity, 'sensitive')
    assert.equal(
      memory.search('身份证', { markRecalled: false }).length,
      0,
    )
  } finally {
    store.close()
  }
})

test('invalid extraction JSON does not fail the saved chat turn', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const model = new ScriptedModel({
      reply: '回复已经保存。',
      extraction: '这不是 JSON',
    })
    const chat = new KanobotChatService(store, model, {
      memory,
      memoryExtraction: new MemoryExtractionService(store, memory, model, {
        clock: ws.clock,
      }),
    })

    const events = await collect(chat, '这条聊天不能被抽取失败拖垮。')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.status, 'failed')
    assert.equal(done.memory?.errorCode, 'memory_extraction_invalid_json')
    assert.equal(chat.conversation().messages.length, 2)
    assert.equal(
      store.latestModelCall('main', 'memory_extraction')?.status,
      'failed',
    )
    assert.equal(store.latestModelCall('main', 'chat')?.status, 'succeeded')
  } finally {
    store.close()
  }
})

test('relevant memories are recalled into the system prompt, not fake messages', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const record = memory.remember({
      text: 'kano 喜欢早上喝咖啡，不加糖。',
      kind: 'preference',
      source: 'user_stated',
    })
    const model = new CapturingModel()
    const chat = new KanobotChatService(store, model, { memory })

    const events = await collect(chat, '今天有点困，想喝点什么。')
    const ready = events.find(event => event.type === 'ready')
    assert.ok(ready?.type === 'ready')
    assert.ok(ready.recalledMemoryCount >= 1)
    assert.match(model.lastRequest?.systemPrompt ?? '', /长期记忆/)
    assert.match(model.lastRequest?.systemPrompt ?? '', /咖啡/)
    // 聊天历史只有本轮用户消息，没有把记忆伪装成一条用户消息。
    assert.deepEqual(
      model.lastRequest?.messages.map(message => message.role),
      ['user'],
    )
    assert.equal(
      model.lastRequest?.messages.some(message => message.text.includes('咖啡')),
      false,
    )
    assert.equal(
      store.getMemory(record.id)?.lastRecalledAt,
      '2026-11-05T00:00:00.000Z',
    )
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

class ScriptedModel implements ChatModel {
  readonly id = 'scripted-test-model'
  readonly mode = 'test'
  readonly provider = 'test'
  private readonly reply: string
  private readonly extraction: string

  constructor(input: { reply: string; extraction: string }) {
    this.reply = input.reply
    this.extraction = input.extraction
  }

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    const isExtraction = request.systemPrompt.includes('记忆抽取器')
    yield {
      type: 'text',
      text: isExtraction ? this.extraction : this.reply,
    }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 15,
        },
        estimatedCost: 0.000001,
        pricing: {
          prompt: 0.0000001,
          completion: 0.0000002,
          cacheRead: null,
          cacheWrite: null,
        },
        responseId: isExtraction ? 'resp-extract' : 'resp-chat',
      },
    }
  }
}

class CapturingModel implements ChatModel {
  readonly id = 'capturing-test-model'
  readonly mode = 'test'
  readonly provider = 'test'
  lastRequest: ChatModelRequest | null = null

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.lastRequest = request
    yield { type: 'text', text: '好。' }
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
