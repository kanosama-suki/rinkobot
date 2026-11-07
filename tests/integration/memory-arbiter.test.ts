/**
 * M4.6 提醒边界、记忆冷却与敏感门禁回归。
 *
 * 用虚构事实和固定时钟验证确定性仲裁，不调用第二次模型，也不读取
 * 正式人格、聊天正文或任何凭据。
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
  arbitrateExplicitMemoryText,
  arbitrateMemoryCandidates,
  KanobotMemoryService,
  type ParsedMemoryCandidate,
} from '../../src/core/memory/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

const NOW = '2026-11-05T00:00:00.000Z'
const SOON = '2026-11-05T01:00:00.000Z'

test('reminder-only candidate is suppressed by the deterministic arbiter', () => {
  const candidate = parsedCandidate({
    text: 'kano 明早需要吃药',
    quote: '明早提醒我吃药',
  })
  const result = arbitrateMemoryCandidates({
    candidates: [candidate],
    reminders: [{ text: '提醒 kano 明早吃药', dueAt: SOON }],
    userText: '明早提醒我吃药',
    explicitlyRequested: false,
  })

  assert.equal(result.items[0]?.action, 'suppressed')
  assert.equal(result.suppressedCount, 1)
})

test('a mixed reminder keeps only the stable fact', () => {
  const candidate = parsedCandidate({
    text: 'kano 对花生过敏，明早提醒 kano 吃药',
    quote: '我对花生过敏，明早提醒我吃药',
  })
  const result = arbitrateMemoryCandidates({
    candidates: [candidate],
    reminders: [{ text: '提醒 kano 明早吃药', dueAt: SOON }],
    userText: '我对花生过敏，明早提醒我吃药',
    explicitlyRequested: false,
  })

  assert.equal(result.items[0]?.action, 'extracted')
  assert.equal(result.items[0]?.candidate.text, 'kano 对花生过敏')
})

test('explicit remember cannot turn a pure reminder into long-term memory', () => {
  const result = arbitrateExplicitMemoryText({
    text: '明早提醒我吃药',
    reminders: [{ text: '提醒 kano 明早吃药', dueAt: SOON }],
    userText: '记住，明早提醒我吃药',
  })

  assert.equal(result.text, null)
  assert.equal(result.action, 'suppressed')
  assert.equal(result.reasonCode, 'memory_explicit_reminder_suppressed')
})

test('a mixed reminder persists only its allergy fact and keeps the reminder', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const chat = new KanobotChatService(
      store,
      new EnvelopeChatModel(
        chatEnvelopeText('好，我记得你对花生过敏。明早我会提醒你吃药。', {
          memoryCandidates: [{
            text: 'kano 对花生过敏，明早提醒 kano 吃药',
            quote: '我对花生过敏，明早提醒我吃药',
            kind: 'personal_fact',
            source: 'user_stated',
            sensitivity: 'normal',
            importance: 'normal',
            confidence: 0.9,
          }],
          reminderCandidates: [{
            text: '提醒 kano 明早吃药',
            dueAt: SOON,
          }],
        }),
      ),
      {
        memory,
        clock: ws.clock,
        initiative: {
          remindersEnabled: true,
          maxReminderDaysAhead: 3,
          followUpsEnabled: false,
          followUpWindowHours: 12,
          followUpMaxDaysAhead: 3,
        },
      },
    )

    await collect(chat, '我对花生过敏，明早提醒我吃药')

    const candidates = memory.listViews('candidate')
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.text, 'kano 对花生过敏')
    const reminders = store.listReminders('all')
    assert.equal(reminders.length, 1)
    assert.equal(reminders[0]?.status, 'confirmed')
    assert.equal(store.listReminderCandidates('all').length, 0)
    assert.ok(
      store.listMemoryDecisions().some(decision =>
        decision.action === 'extracted' &&
        decision.reasonCode === 'memory_fact_extracted_from_reminder',
      ),
    )
  } finally {
    store.close()
  }
})

test('explicit stable fact persists while explicit reminder fallback is rejected', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const chat = new KanobotChatService(
      store,
      new EnvelopeChatModel(
        chatEnvelopeText('好，我记住了。', {
          reminderCandidates: [{
            text: '提醒 kano 明早吃药',
            dueAt: SOON,
          }],
        }),
      ),
      {
        memory,
        clock: ws.clock,
        initiative: {
          remindersEnabled: true,
          maxReminderDaysAhead: 3,
          followUpsEnabled: false,
          followUpWindowHours: 12,
          followUpMaxDaysAhead: 3,
        },
      },
    )

    await collect(chat, '记住，明早提醒我吃药')
    assert.equal(memory.listViews('all').length, 0)
    const reminders = store.listReminders('all')
    assert.equal(reminders.length, 1)
    assert.equal(reminders[0]?.status, 'confirmed')
    assert.equal(store.listReminderCandidates('all').length, 0)
    assert.ok(
      store.listMemoryDecisions().some(decision =>
        decision.action === 'suppressed' &&
        decision.reasonCode === 'memory_explicit_reminder_suppressed',
      ),
    )

    await collect(chat, '记住，我对花生过敏')
    const durable = memory.listViews('active')
    assert.equal(durable.length, 1)
    assert.equal(durable[0]?.text, '我对花生过敏')
    assert.equal(durable[0]?.explicitlyRequested, true)
  } finally {
    store.close()
  }
})

test('sensitive explicit fallback still stays candidate and unsearchable', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const chat = new KanobotChatService(
      store,
      new EnvelopeChatModel(chatEnvelopeText('好，我记住了。')),
      { memory, clock: ws.clock },
    )

    await collect(chat, '记住，我的病历上写着对花生过敏')
    const candidates = memory.listViews('candidate')
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.sensitivity, 'sensitive')
    assert.equal(candidates[0]?.status, 'candidate')
    assert.equal(
      memory.search('花生', { markRecalled: false }).length,
      0,
    )
  } finally {
    store.close()
  }
})

test('reminder delivery leaves the linked memory unchanged', () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const record = memory.remember({
      text: 'kano 对花生过敏。',
      kind: 'personal_fact',
      source: 'user_stated',
      importance: 'important',
    })
    const source = store.appendChatMessage({
      id: 'message-reminder-delivery-source',
      conversationId: 'main',
      role: 'user',
      text: '提醒来源',
      createdAt: NOW,
    })
    const candidate = store.putReminderCandidate({
      id: 'reminder-candidate-delivery-test',
      text: '提醒 kano 明早吃药。',
      dueAt: SOON,
      sourceMessageId: source.id,
      createdAt: NOW,
    })
    const confirmed = store.confirmReminderCandidate(candidate.id, NOW)
    const outbox = store.queueReminderOutbox(confirmed.reminder.id, SOON, 3)
    store.claimOutbox(outbox.id, SOON)
    store.deliverOutbox(outbox.id, SOON)

    assert.equal(store.getReminder(confirmed.reminder.id)?.status, 'delivered')
    assert.deepEqual(store.getMemory(record.id), record)
    assert.equal(store.listMemoryDecisions().length, 0)
  } finally {
    store.close()
  }
})

test('expired candidates archive without recall and can be restored', () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const ordinary = memory.remember({
      text: 'kano 提到过一本旧书。',
      kind: 'small_talk',
      source: 'user_stated',
    })
    const important = memory.remember({
      text: 'kano 对花生过敏。',
      kind: 'personal_fact',
      source: 'user_stated',
      importance: 'important',
    })
    const permanent = memory.remember({
      text: 'kano 的生日是三月十四日。',
      kind: 'personal_fact',
      source: 'user_stated',
      importance: 'permanent',
    })
    const explicit = memory.remember({
      text: '记住，kano 喜欢窗边的座位。',
      kind: 'preference',
      source: 'user_stated',
      explicitlyRequested: true,
    })

    ws.clock.advanceByMs(31 * 86_400_000)
    const archived = memory.archiveExpiredCandidates(ws.clock.now())
    assert.deepEqual(archived.map(record => record.id), [ordinary.id])
    assert.equal(memory.search('旧书', { markRecalled: false }).length, 0)
    assert.equal(memory.listViews('archived').length, 1)
    assert.equal(store.getMemory(important.id)?.status, 'active')
    assert.equal(store.getMemory(permanent.id)?.status, 'active')
    assert.equal(store.getMemory(explicit.id)?.status, 'active')

    const restored = memory.restore(ordinary.id)
    assert.equal(restored.status, 'candidate')
    assert.equal(memory.listViews('archived').length, 0)
    assert.equal(memory.listViews('candidate')[0]?.id, ordinary.id)
    assert.ok(
      store.listMemoryDecisions().some(decision =>
        decision.action === 'restored' &&
        decision.reasonCode === 'owner_restored_archived',
      ),
    )

    ws.clock.advanceByMs(86_400_000)
    assert.deepEqual(memory.archiveExpiredCandidates(ws.clock.now()), [])
  } finally {
    store.close()
  }
})

function parsedCandidate(
  overrides: Partial<ParsedMemoryCandidate> = {},
): ParsedMemoryCandidate {
  return {
    text: 'kano 对花生过敏',
    quote: '我对花生过敏',
    kind: 'personal_fact',
    source: 'user_stated',
    sensitivity: 'normal',
    importance: 'normal',
    confidence: 0.9,
    ...overrides,
  }
}

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

class EnvelopeChatModel implements ChatModel {
  readonly id = 'memory-arbiter-test-model'
  readonly mode = 'mock'
  readonly provider = 'test'
  private readonly envelope: string

  constructor(envelope: string) {
    this.envelope = envelope
  }

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield { type: 'text', text: this.envelope }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: 'memory-arbiter-response',
      },
    }
  }
}
