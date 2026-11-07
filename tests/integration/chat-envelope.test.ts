/**
 * M3.5 单一 JSON 信封测试。
 *
 * 覆盖记忆候选、appraisal、commitments、流式正文提取和信封损坏时的
 * 正文降级。全部使用虚构正文，不访问真实模型或测试 Profile。
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
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('a user-stated preference is saved in the same model turn', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const model = new EnvelopeModel(chatEnvelopeText('好，我记住了。', {
      memoryCandidates: [{
        text: 'kano 喜欢早上喝手冲咖啡。',
        quote: '我喜欢早上喝手冲咖啡',
        kind: 'preference',
        source: 'user_stated',
        sensitivity: 'normal',
        importance: 'important',
        confidence: 0.95,
      }],
    }))
    const chat = new KanobotChatService(store, model, { memory })

    const events = await collect(chat, '我喜欢早上喝手冲咖啡，记住这个。')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(model.requestCount, 1)
    assert.equal(done.memory?.status, 'succeeded')
    assert.equal(done.memory?.createdCount, 1)
    assert.equal(done.memory?.candidateCount, 0)
    assert.equal(done.envelope.ok, true)
    assert.equal(done.envelope.errorCode, null)

    const found = memory.search('咖啡', { markRecalled: false })
    assert.equal(found.length, 1)
    assert.equal(found[0]?.memory.status, 'active')
    assert.equal(
      store.getBody(found[0]!.memory.quoteRef!)?.content,
      '我喜欢早上喝手冲咖啡',
    )
    assert.equal(store.latestModelCall('main', 'chat')?.status, 'succeeded')
    assert.equal(store.latestModelCall('main', 'memory_extraction'), null)
    assert.equal(store.modelCallCountToday(), 1)
  } finally {
    store.close()
  }
})

test('ordinary small talk is retained as a candidate instead of silently becoming permanent', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const chat = new KanobotChatService(
      store,
      new EnvelopeModel(chatEnvelopeText('嗯，路上慢一点。', {
        memoryCandidates: [{
          text: 'kano 今天路过一家书店。',
          quote: '今天路过一家书店',
          kind: 'small_talk',
          source: 'user_stated',
          sensitivity: 'normal',
          importance: 'normal',
          confidence: 0.8,
        }],
      })),
      { memory },
    )

    const done = (await collect(chat, '今天路过一家书店。'))
      .find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.createdCount, 1)
    assert.equal(done.memory?.candidateCount, 1)
    assert.equal(memory.listCandidates().length, 1)
    assert.equal(memory.search('书店', { markRecalled: false }).length, 0)
  } finally {
    store.close()
  }
})

test('an explicit remember request has a deterministic fallback when the model omits candidates', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const chat = new KanobotChatService(
      store,
      new EnvelopeModel(chatEnvelopeText('记住了。')),
      { memory },
    )

    const done = (await collect(chat, '记住这个：我对花生过敏。'))
      .find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.status, 'succeeded')
    assert.equal(done.memory?.createdCount, 1)

    const found = memory.search('花生', { markRecalled: false })
    assert.equal(found.length, 1)
    assert.equal(found[0]?.memory.status, 'active')
    assert.equal(found[0]?.memory.kind, 'owner_request')
    assert.equal(found[0]?.memory.importance, 'important')
  } finally {
    store.close()
  }
})

test('a claim quoting the assistant reply is downgraded to a candidate', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const reply = '我其实喜欢安静的书店。'
    const chat = new KanobotChatService(
      store,
      new EnvelopeModel(chatEnvelopeText(reply, {
        memoryCandidates: [{
          text: '燐子喜欢安静的书店。',
          quote: reply,
          kind: 'preference',
          source: 'user_stated',
          sensitivity: 'normal',
          importance: 'normal',
          confidence: 0.9,
        }],
      })),
      { memory },
    )

    const done = (await collect(chat, '你喜欢什么样的书店？'))
      .find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.candidateCount, 1)
    const candidates = memory.listCandidates()
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.source, 'rinko_inferred')
    assert.equal(memory.search('书店', { markRecalled: false }).length, 0)
  } finally {
    store.close()
  }
})

test('sensitive memory stays behind the candidate gate', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const chat = new KanobotChatService(
      store,
      new EnvelopeModel(chatEnvelopeText('这个先放在候选里。', {
        memoryCandidates: [{
          text: 'kano 的身份证号码需要保密。',
          quote: '我的身份证号是测试占位值',
          kind: 'personal_fact',
          source: 'user_stated',
          sensitivity: 'normal',
          importance: 'permanent',
          confidence: 1,
        }],
      })),
      { memory },
    )

    const done = (await collect(chat, '我的身份证号是测试占位值，记住。'))
      .find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.memory?.candidateCount, 1)
    const candidate = memory.listCandidates()[0]
    assert.equal(candidate?.sensitivity, 'sensitive')
    assert.equal(memory.search('身份证', { markRecalled: false }).length, 0)
  } finally {
    store.close()
  }
})

test('a damaged envelope keeps the complete reply but drops metadata', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const raw =
      '{"schemaVersion":1,"reply":"回复已经保存。","memoryCandidates":['
    const chat = new KanobotChatService(store, new EnvelopeModel(raw), {
      memory,
    })

    const events = await collect(chat, '这条聊天不能因尾部 JSON 损坏而消失。')
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.message.text, '回复已经保存。')
    assert.equal(done.envelope.ok, false)
    assert.equal(done.envelope.errorCode, 'chat_envelope_invalid_json')
    assert.equal(done.memory?.status, 'failed')
    assert.equal(chat.conversation().messages.length, 2)
    assert.equal(store.latestModelCall('main', 'chat')?.status, 'succeeded')
    assert.equal(store.latestModelCall('main', 'memory_extraction'), null)
  } finally {
    store.close()
  }
})

test('a degraded field is reported without discarding the reply', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const raw = JSON.stringify({
      schemaVersion: 1,
      reply: '正文仍然完整。',
      memoryCandidates: [],
      appraisal: {
        valence: 2,
        arousal: 0.2,
        confidence: 0.8,
      },
      commitments: [],
    })
    const chat = new KanobotChatService(store, new EnvelopeModel(raw))
    const initialValence = store.currentState().affect.valence

    const done = (await collect(chat, '验证部分字段降级。'))
      .find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.message.text, '正文仍然完整。')
    assert.equal(done.envelope.ok, false)
    assert.equal(done.envelope.errorCode, null)
    assert.ok(done.envelope.issueCodes.includes('appraisal_invalid'))
    assert.equal(done.state.affect.valence, initialValence)
    assert.equal(done.state.lastSequence, 1)
    assert.deepEqual(
      store.currentState().commitments,
      [],
    )
  } finally {
    store.close()
  }
})

test('appraisal updates affect and commitments become versioned state events', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(
      store,
      new EnvelopeModel(chatEnvelopeText('好，我会提醒你。', {
        appraisal: {
          valence: 0.8,
          arousal: 0.5,
          confidence: 1,
        },
        commitments: [{
          text: '明早提醒 kano 带伞。',
          dueAt: '2026-11-06T23:00:00+08:00',
        }],
      })),
    )

    const done = (await collect(chat, '明早提醒我带伞。'))
      .find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.envelope.ok, true)
    assert.equal(done.envelope.commitmentsCreated, 1)
    assert.equal(done.state.affect.valence, 0.8)
    assert.equal(done.state.affect.arousal, 0.5)
    assert.equal(done.state.commitments.total, 1)
    assert.equal(done.state.commitments.open, 1)
    assert.equal(done.state.lastSequence, 3)

    const state = store.currentState()
    assert.equal(state.commitments.length, 1)
    assert.equal(state.commitments[0]?.dueAt, '2026-11-06T15:00:00.000Z')
    const body = store.getBody(state.commitments[0]!.descriptionRef)
    assert.equal(body?.content, '明早提醒 kano 带伞。')
    assert.equal(body?.kind, 'commitment')
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
      importance: 'important',
    })
    const model = new EnvelopeModel(chatEnvelopeText('好。'))
    const chat = new KanobotChatService(store, model, { memory })

    const events = await collect(chat, '今天有点困，想喝点什么。')
    const ready = events.find(event => event.type === 'ready')
    assert.ok(ready?.type === 'ready')
    assert.ok(ready.recalledMemoryCount >= 1)
    assert.match(model.lastRequest?.systemPrompt ?? '', /长期记忆/)
    assert.match(model.lastRequest?.systemPrompt ?? '', /咖啡/)
    assert.equal(model.lastRequest?.jsonMode, true)
    assert.equal(
      model.lastRequest?.responsePrefill,
      '{"schemaVersion":1,"reply":"',
    )
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

class EnvelopeModel implements ChatModel {
  readonly id = 'envelope-test-model'
  readonly mode = 'test'
  readonly provider = 'test'
  readonly output: string
  requestCount = 0
  lastRequest: ChatModelRequest | null = null

  constructor(output: string) {
    this.output = output
  }

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.requestCount += 1
    this.lastRequest = request
    const characters = Array.from(this.output)
    for (let offset = 0; offset < characters.length; offset += 7) {
      yield {
        type: 'text',
        text: characters.slice(offset, offset + 7).join(''),
      }
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
