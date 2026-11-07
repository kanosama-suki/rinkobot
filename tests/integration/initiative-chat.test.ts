/**
 * M4 聊天链路与主动性候选门控测试。
 *
 * 只使用本地 JSON 信封和临时数据库，验证模型只能提交候选项：
 * 明确提醒直接生效，模糊提醒仍等待确认，关心项只产生一次。
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

test('chat activates an explicit reminder and stages care candidates', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const model = new EnvelopeChatModel(chatEnvelopeText(
      '我记下了，到时间再提醒你。',
      {
        reminderCandidates: [
          {
            text: '明早提醒 kano 带伞。',
            dueAt: '2026-11-06T01:00:00.000Z',
          },
          {
            text: '明早提醒 kano 带伞。',
            dueAt: '2026-11-06T01:00:00.000Z',
          },
        ],
        careCandidates: [
          {
            text: 'kano 说过今天有点不舒服。',
            dueFrom: '2026-11-05T23:30:00.000Z',
            dueUntil: '2026-11-06T12:00:00.000Z',
          },
          {
            text: 'kano 说过今天有点不舒服。',
            dueFrom: '2026-11-05T23:30:00.000Z',
            dueUntil: '2026-11-06T12:00:00.000Z',
          },
        ],
      },
    ))
    const chat = createChat(store, model)
    const done = await collectDone(chat, '明天早上提醒我带伞，我今天不太舒服。')

    assert.equal(done.envelope.remindersActivated, 1)
    assert.equal(done.envelope.reminderCandidatesCreated, 0)
    assert.equal(done.envelope.reminderCandidatesSkipped, 1)
    assert.equal(done.envelope.careItemsCreated, 1)
    assert.equal(done.envelope.careItemsSkipped, 1)
    const reminders = store.listReminders('all', 20)
    assert.equal(reminders.length, 1)
    assert.equal(reminders[0]?.status, 'confirmed')

    const candidates = store.listReminderCandidates('pending', 20)
    assert.equal(candidates.length, 0)

    const careItems = store.listCareItems('pending', 20)
    const source = store.latestUserChatMessage('main')
    assert.equal(careItems.length, 1)
    assert.equal(careItems[0]?.sourceMessageId, source?.id)
  } finally {
    store.close()
  }
})

test('disabled initiative candidate types are counted as skipped', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const chat = createChat(store, new EnvelopeChatModel(chatEnvelopeText(
      '这次不建立提醒和关心项。',
      {
        reminderCandidates: [{
          text: '虚构提醒不会写入。',
          dueAt: '2026-11-06T01:00:00.000Z',
        }],
        careCandidates: [{
          text: '虚构关心不会写入。',
          dueFrom: '2026-11-05T23:30:00.000Z',
          dueUntil: '2026-11-06T01:00:00.000Z',
        }],
      },
    )), {
      remindersEnabled: false,
      followUpsEnabled: false,
    })
    const done = await collectDone(chat, '这是一条虚构消息。')

    assert.equal(done.envelope.reminderCandidatesCreated, 0)
    assert.equal(done.envelope.reminderCandidatesSkipped, 1)
    assert.equal(done.envelope.careItemsCreated, 0)
    assert.equal(done.envelope.careItemsSkipped, 1)
    assert.ok(done.envelope.issueCodes.includes('reminder_candidates_disabled'))
    assert.ok(done.envelope.issueCodes.includes('care_candidates_disabled'))
    assert.equal(store.listReminderCandidates('all', 20).length, 0)
    assert.equal(store.listCareItems('all', 20).length, 0)
  } finally {
    store.close()
  }
})

test('out-of-window initiative candidates are rejected before storage', async () => {
  const ws = createWorkspace(test, { now: NOW })
  const store = ws.open()
  try {
    const chat = createChat(store, new EnvelopeChatModel(chatEnvelopeText(
      '这两个候选时间不合适，我不会保留。',
      {
        reminderCandidates: [{
          text: '已经过期的虚构提醒。',
          dueAt: '2026-11-05T22:59:00.000Z',
        }],
        careCandidates: [{
          text: '窗口过长的虚构关心。',
          dueFrom: '2026-11-05T23:30:00.000Z',
          dueUntil: '2026-11-06T23:31:00.000Z',
        }],
      },
    )))
    const done = await collectDone(chat, '提醒我明早带伞。')

    assert.equal(done.envelope.reminderCandidatesCreated, 0)
    assert.equal(done.envelope.reminderCandidatesSkipped, 1)
    assert.equal(done.envelope.careItemsCreated, 0)
    assert.equal(done.envelope.careItemsSkipped, 1)
    assert.ok(done.envelope.issueCodes.includes('reminder_candidates_rejected'))
    assert.ok(done.envelope.issueCodes.includes('care_candidates_rejected'))
    assert.equal(store.listReminderCandidates('all', 20).length, 0)
    assert.equal(store.listCareItems('all', 20).length, 0)
  } finally {
    store.close()
  }
})

type TestStore = ReturnType<ReturnType<typeof createWorkspace>['open']>

function createChat(
  store: TestStore,
  model: ChatModel,
  overrides: {
    remindersEnabled?: boolean
    followUpsEnabled?: boolean
  } = {},
): KanobotChatService {
  return new KanobotChatService(store, model, {
    clock: {
      now: () => new Date(NOW),
    },
    initiative: {
      remindersEnabled: overrides.remindersEnabled ?? true,
      maxReminderDaysAhead: 30,
      followUpsEnabled: overrides.followUpsEnabled ?? true,
      followUpWindowHours: 24,
      followUpMaxDaysAhead: 7,
    },
  })
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

class EnvelopeChatModel implements ChatModel {
  readonly id = 'initiative-test-model'
  readonly mode = 'test'
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
        responseId: 'initiative-test-response',
      },
    }
  }
}
