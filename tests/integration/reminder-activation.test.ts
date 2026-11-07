/**
 * M5.1 低摩擦提醒闭环测试。
 *
 * 只使用脚本化 JSON 信封和临时数据库，覆盖明确委托自动生效、模糊候选
 * 聊天确认、TTL、多候选歧义、去重、模型推断拒绝和 STOP。
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
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

const NOW = '2026-11-05T23:00:00.000Z'

test('explicit delegation activates a reminder directly and deduplicates it', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const dueAt = future(2)
    const candidate = {
      text: '提醒 kano 明早九点半洗澡。',
      dueAt,
    }
    const model = new QueueChatModel([
      chatEnvelopeText('好，我明早九点半提醒你洗澡。', {
        reminderCandidates: [candidate, candidate],
      }),
    ])
    const chat = createChat(store, model, ws.clock)
    const done = await collectDone(chat, '明早九点半提醒我洗澡。')

    assert.equal(done.envelope.remindersActivated, 1)
    assert.equal(done.envelope.reminderCandidatesCreated, 0)
    assert.equal(done.envelope.reminderCandidatesSkipped, 1)
    assert.ok(
      done.envelope.issueCodes.includes('reminder_candidate_duplicate'),
    )
    const reminders = store.listReminders('all', 20)
    assert.equal(reminders.length, 1)
    assert.equal(reminders[0]?.status, 'confirmed')
    assert.equal(store.listReminderCandidates('all', 20).length, 0)

    model.push(chatEnvelopeText('这条也记下了。', {
      reminderCandidates: [candidate],
    }))
    const repeated = await collectDone(chat, '明早九点半提醒我洗澡。')
    assert.equal(repeated.envelope.remindersActivated, 0)
    assert.equal(repeated.envelope.reminderCandidatesCreated, 0)
    assert.equal(store.listReminders('all', 20).length, 1)
  } finally {
    store.close()
  }
})

test('an ambiguous candidate is confirmed by the next chat turn without duplication', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const dueAt = future(2)
    const model = new QueueChatModel([
      chatEnvelopeText('你想几点洗澡？', {
        reminderCandidates: [{
          text: '提醒 kano 洗澡。',
          dueAt,
        }],
      }),
      chatEnvelopeText('好，到时间我提醒你。', {
        reminderCandidates: [{
          text: '提醒 kano 洗澡。',
          dueAt,
        }],
      }),
    ])
    const chat = createChat(store, model, ws.clock)

    const first = await collectDone(chat, '提醒我晚点洗澡。')
    assert.equal(first.envelope.remindersActivated, 0)
    assert.equal(first.envelope.reminderCandidatesCreated, 1)
    assert.equal(store.listReminders('all', 20).length, 0)

    const second = await collectDone(chat, '可以喵')
    assert.equal(second.envelope.remindersActivated, 0)
    assert.equal(second.envelope.reminderCandidatesCreated, 0)
    assert.equal(second.envelope.reminderCandidatesSkipped, 1)
    assert.ok(
      second.envelope.issueCodes.includes(
        'reminder_confirmation_turn_ignored',
      ),
    )
    assert.equal(store.listReminderCandidates('pending', 20).length, 0)
    assert.equal(store.listReminders('all', 20).length, 1)
  } finally {
    store.close()
  }
})

test('a pending candidate older than the chat confirmation TTL is not confirmed', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const model = new QueueChatModel([
      chatEnvelopeText('你想几点洗澡？', {
        reminderCandidates: [{
          text: '提醒 kano 洗澡。',
          dueAt: future(3),
        }],
      }),
      chatEnvelopeText('这条需要你在提醒面板里处理。'),
    ])
    const chat = createChat(store, model, ws.clock)
    await collectDone(chat, '提醒我晚点洗澡。')

    ws.clock.advanceByMs(31 * 60_000)
    const second = await collectDone(chat, '可以')
    assert.equal(second.envelope.remindersActivated, 0)
    assert.equal(store.listReminderCandidates('pending', 20).length, 1)
    assert.equal(store.listReminders('all', 20).length, 0)
  } finally {
    store.close()
  }
})

test('multiple pending candidates are never confirmed as a batch', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const model = new QueueChatModel([
      chatEnvelopeText('这两件事都需要再确认时间。', {
        reminderCandidates: [
          {
            text: '提醒 kano 洗澡。',
            dueAt: future(2),
          },
          {
            text: '提醒 kano 喝水。',
            dueAt: future(2),
          },
        ],
      }),
      chatEnvelopeText('你想确认哪一条？'),
    ])
    const chat = createChat(store, model, ws.clock)
    await collectDone(chat, '提醒我晚点洗澡，也提醒我喝水。')
    assert.equal(store.listReminderCandidates('pending', 20).length, 2)

    const second = await collectDone(chat, '可以')
    assert.ok(
      second.envelope.issueCodes.includes(
        'reminder_confirmation_ambiguous',
      ),
    )
    assert.equal(store.listReminderCandidates('pending', 20).length, 2)
    assert.equal(store.listReminders('all', 20).length, 0)
  } finally {
    store.close()
  }
})

test('model-inferred reminders are rejected when the user made no delegation', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const chat = createChat(store, new QueueChatModel([
      chatEnvelopeText('明早的会要记得去。', {
        reminderCandidates: [{
          text: '提醒 kano 明早开会。',
          dueAt: future(10),
        }],
      }),
    ]), ws.clock)
    const done = await collectDone(chat, '明早有个会。')

    assert.equal(done.envelope.remindersActivated, 0)
    assert.equal(done.envelope.reminderCandidatesCreated, 0)
    assert.equal(done.envelope.reminderCandidatesSkipped, 1)
    assert.ok(
      done.envelope.issueCodes.includes('reminder_intent_not_explicit'),
    )
    assert.equal(store.listReminders('all', 20).length, 0)
    assert.equal(store.listReminderCandidates('all', 20).length, 0)
  } finally {
    store.close()
  }
})

test('different actions at the same time are kept as separate reminders', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const dueAt = future(2)
    const chat = createChat(store, new QueueChatModel([
      chatEnvelopeText('好，两件事都记下了。', {
        reminderCandidates: [
          { text: '提醒 kano 洗澡。', dueAt },
          { text: '提醒 kano 喝水。', dueAt },
        ],
      }),
    ]), ws.clock)
    const done = await collectDone(
      chat,
      '明早九点提醒我洗澡，也提醒我喝水。',
    )

    assert.equal(done.envelope.remindersActivated, 2)
    assert.equal(store.listReminders('all', 20).length, 2)
  } finally {
    store.close()
  }
})

test('the same action and time in different conversations stays separate', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const dueAt = future(2)
    const envelope = chatEnvelopeText('好，到时间我提醒你。', {
      reminderCandidates: [{
        text: '提醒 kano 明早九点半洗澡。',
        dueAt,
      }],
    })
    const first = createChat(
      store,
      new QueueChatModel([envelope]),
      ws.clock,
      undefined,
      'conversation-web',
    )
    const second = createChat(
      store,
      new QueueChatModel([envelope]),
      ws.clock,
      undefined,
      'conversation-qq-10001',
    )

    const web = await collectDone(first, '明早九点半提醒我洗澡。')
    const qq = await collectDone(second, '明早九点半提醒我洗澡。')

    assert.equal(web.envelope.remindersActivated, 1)
    assert.equal(qq.envelope.remindersActivated, 1)
    assert.equal(store.listReminders('all', 20).length, 2)
  } finally {
    store.close()
  }
})

test('STOP blocks automatic activation and chat confirmation but keeps the candidate', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const model = new QueueChatModel([
      chatEnvelopeText('现在不能自动设提醒。', {
        reminderCandidates: [{
          text: '提醒 kano 明早九点半洗澡。',
          dueAt: future(10),
        }],
      }),
      chatEnvelopeText('紧急停止期间不能确认提醒。'),
    ])
    const chat = createChat(store, model, ws.clock, () => false)
    const first = await collectDone(chat, '明早九点半提醒我洗澡。')

    assert.equal(first.envelope.remindersActivated, 0)
    assert.equal(first.envelope.reminderCandidatesCreated, 1)
    assert.ok(
      first.envelope.issueCodes.includes('reminder_activation_stopped'),
    )

    ws.clock.advanceByMs(60_000)
    const second = await collectDone(chat, '可以')
    assert.equal(second.envelope.remindersActivated, 0)
    assert.ok(
      second.envelope.issueCodes.includes('reminder_activation_stopped'),
    )
    assert.equal(store.listReminders('all', 20).length, 0)
    assert.equal(store.listReminderCandidates('pending', 20).length, 1)
  } finally {
    store.close()
  }
})

test('rejecting the next ambiguous reminder uses the same deterministic chat path', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const model = new QueueChatModel([
      chatEnvelopeText('你想几点洗澡？', {
        reminderCandidates: [{
          text: '提醒 kano 洗澡。',
          dueAt: future(2),
        }],
      }),
      chatEnvelopeText('好，那就不设了。'),
    ])
    const chat = createChat(store, model, ws.clock)
    await collectDone(chat, '提醒我晚点洗澡。')
    await collectDone(chat, '不用了')

    assert.equal(store.listReminders('all', 20).length, 0)
    const candidates = store.listReminderCandidates('all', 20)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.status, 'rejected')
  } finally {
    store.close()
  }
})

type TestStore = ReturnType<ReturnType<typeof createWorkspace>['open']>
type TestClock = ReturnType<typeof createWorkspace>['clock']

function createChat(
  store: TestStore,
  model: ChatModel,
  clock: TestClock,
  isAutonomousAllowed?: () => boolean,
  conversationId?: string,
): KanobotChatService {
  return new KanobotChatService(store, model, {
    clock,
    ...(conversationId === undefined ? {} : { conversationId }),
    initiative: {
      remindersEnabled: true,
      maxReminderDaysAhead: 30,
      followUpsEnabled: true,
      followUpWindowHours: 24,
      followUpMaxDaysAhead: 7,
      ...(isAutonomousAllowed === undefined
        ? {}
        : { isAutonomousAllowed }),
    },
  })
}

function future(hours: number): string {
  return new Date(Date.parse(NOW) + hours * 3_600_000).toISOString()
}

async function collectDone(
  chat: KanobotChatService,
  text: string,
): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  let done: Extract<ChatStreamEvent, { type: 'done' }> | null = null
  for await (
    const event of chat.streamMessage(text, new AbortController().signal)
  ) {
    if (event.type === 'done') done = event
  }
  assert.ok(done)
  return done
}

class QueueChatModel implements ChatModel {
  readonly id = 'reminder-activation-test-model'
  readonly mode = 'test'
  readonly provider = 'test'
  private readonly envelopes: string[]

  constructor(envelopes: string[]) {
    this.envelopes = [...envelopes]
  }

  push(envelope: string): void {
    this.envelopes.push(envelope)
  }

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    const envelope = this.envelopes.shift()
    if (envelope === undefined) {
      throw new Error('test model received an unexpected chat turn')
    }
    yield { type: 'text', text: envelope }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: 'reminder-activation-test-response',
      },
    }
  }
}
