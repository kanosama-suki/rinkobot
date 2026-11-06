/**
 * M4 主动性服务集成测试。
 *
 * 使用脚本化 brain、手动时钟和临时 SQLite，验证安静时段、提醒、
 * 主动消息、一次关心、防刷屏、软计划、每日摘要、STOP 和过期草稿。
 * 不调用真实模型，也不读取测试 Profile。
 */

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import test from 'node:test'

import type { InitiativeConfig } from '../../src/core/config/index.ts'
import {
  isQuietAt,
  KanobotInitiativeService,
  type DailyPlanDraft,
  type DailyReviewContext,
  type DailyReviewDraft,
  type InitiativeBrain,
  type ProactiveContext,
  type ProactiveDraft,
} from '../../src/core/initiative/index.ts'
import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import { KanobotEmergencyService } from '../../src/core/policy/index.ts'
import type { KanobotStorage } from '../../src/core/storage/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('a replied-to 24 hour simulation stays within the waking rhythm', async () => {
  const runtime = createRuntime(test, {
    now: '2026-11-05T16:00:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
      config.reminders.enabled = false
    },
  })
  runtime.brain.proactive = () => ({
    schemaVersion: 1,
    shouldSend: true,
    message: '这是 24 小时节奏仿真里的虚构主动消息。',
    reasonCode: 'simulation',
    careItemId: null,
  })
  try {
    for (let step = 0; step < 48; step += 1) {
      if (step > 0) runtime.clock.advanceByMs(30 * 60_000)
      const result = await runtime.service.tick(new AbortController().signal)
      if (!result.proactiveSent) continue
      runtime.store.appendChatMessage({
        conversationId: 'main',
        role: 'user',
        text: `这是第 ${step} 步的虚构回复。`,
        createdAt: new Date(
          runtime.clock.now().getTime() + 60_000,
        ).toISOString(),
      })
    }

    const proactiveMessages = runtime.store
      .listChatMessages('main', 100)
      .filter(message => message.role === 'assistant')
    assert.ok(proactiveMessages.length >= 8)
    assert.ok(proactiveMessages.length <= 17)
    for (const message of proactiveMessages) {
      assert.equal(
        isQuietAt(
          new Date(message.createdAt),
          runtime.timezone,
          '00:10',
          '07:00',
        ),
        false,
      )
    }
  } finally {
    runtime.close()
  }
})

test('quiet hours suppress proactive messages but still deliver confirmed reminders', async () => {
  const runtime = createRuntime(test, {
    now: '2026-11-05T18:01:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
    },
  })
  try {
    const source = runtime.store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '这是安静时段的虚构用户消息。',
      createdAt: '2026-11-05T17:50:00.000Z',
    })
    const candidate = runtime.store.putReminderCandidate({
      text: '安静时段也要送达的虚构提醒。',
      dueAt: '2026-11-05T18:00:00.000Z',
      sourceMessageId: source.id,
      createdAt: '2026-11-05T17:50:00.000Z',
    })
    runtime.store.confirmReminderCandidate(
      candidate.id,
      '2026-11-05T17:50:01.000Z',
    )

    const result = await runtime.service.tick(new AbortController().signal)
    assert.equal(result.status, 'completed')
    assert.equal(result.proactiveSent, false)
    assert.equal(result.deliveredOutbox, 1)
    assert.equal(runtime.brain.proactiveCalls, 0)
    const reminder = runtime.store.listReminders('delivered')
    assert.equal(reminder.length, 1)
    const message = runtime.store.listChatMessages('main', 10).at(-1)
    assert.equal(message?.role, 'assistant')
    assert.equal(message?.text, '安静时段也要送达的虚构提醒。')
  } finally {
    runtime.close()
  }
})

test('proactive care item is used once and a one-message circuit stops repetition', async () => {
  const runtime = createRuntime(test, {
    now: '2026-11-05T23:30:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
      config.proactive.circuitMaxMessages = 1
      config.proactive.circuitWindowMinutes = 60
    },
  })
  try {
    const source = runtime.store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '虚构用户说今天有点不舒服。',
      createdAt: '2026-11-05T22:30:00.000Z',
    })
    const care = runtime.store.putCareItem({
      id: 'care-item-service',
      text: 'kano 今天不舒服。',
      sourceMessageId: source.id,
      dueFrom: '2026-11-05T22:00:00.000Z',
      dueUntil: '2026-11-06T12:00:00.000Z',
      createdAt: '2026-11-05T22:30:00.000Z',
    })
    runtime.brain.proactive = context =>
      context.dueCare[0] === undefined
        ? idleDraft()
        : {
            schemaVersion: 1,
            shouldSend: true,
            message: '今天感觉好些了吗？',
            reasonCode: 'care_follow_up',
            careItemId: context.dueCare[0].id,
          }

    const result = await runtime.service.tick(new AbortController().signal)
    assert.equal(result.proactiveSent, true)
    assert.equal(result.deliveredOutbox, 1)
    assert.equal(runtime.brain.proactiveCalls, 1)
    assert.equal(runtime.store.getCareItem(care.id)?.status, 'delivered')
    assert.equal(runtime.store.getInitiativeState().circuitOpenedAt !== null, true)
    assert.equal(runtime.service.view().circuit.open, true)

    runtime.clock.advanceByMs(5 * 60_000)
    const second = await runtime.service.tick(new AbortController().signal)
    assert.equal(second.proactiveSent, false)
    assert.equal(second.deliveredOutbox, 0)
    assert.equal(runtime.brain.proactiveCalls, 1)
    assert.equal(
      runtime.store
        .listChatMessages('main', 10)
        .filter(message => message.text === '今天感觉好些了吗？').length,
      1,
    )
  } finally {
    runtime.close()
  }
})

test('queued proactive messages expire in quiet hours, after new chat, on circuit and after restart', async () => {
  const quiet = createRuntime(test, {
    now: '2026-11-05T16:30:00.000Z',
    startupAt: '2026-11-05T16:00:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
    },
  })
  try {
    const outbox = quiet.store.enqueueOutbox({
      id: 'outbox-quiet-stale',
      target: 'web:owner',
      kind: 'proactive',
      text: '不应在安静时段补发的旧草稿。',
      dueAt: '2026-11-05T15:50:00.000Z',
      maxAttempts: 3,
      createdAt: '2026-11-05T15:50:00.000Z',
    })
    await quiet.service.tick(new AbortController().signal)
    assert.equal(quiet.store.getOutbox(outbox.id)?.status, 'expired')
    assert.equal(
      quiet.store
        .listChatMessages('main', 10)
        .some(message => message.text === '不应在安静时段补发的旧草稿。'),
      false,
    )
  } finally {
    quiet.close()
  }

  const superseded = createRuntime(test, {
    now: '2026-11-06T01:00:00.000Z',
    startupAt: '2026-11-06T00:00:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
    },
  })
  try {
    const outbox = superseded.store.enqueueOutbox({
      id: 'outbox-superseded',
      target: 'web:owner',
      kind: 'proactive',
      text: 'kano 已经回来的旧草稿。',
      maxAttempts: 3,
      createdAt: '2026-11-06T00:30:00.000Z',
    })
    superseded.store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '虚构用户已经回话。',
      createdAt: '2026-11-06T00:40:00.000Z',
    })
    await superseded.service.tick(new AbortController().signal)
    assert.equal(superseded.store.getOutbox(outbox.id)?.status, 'expired')
  } finally {
    superseded.close()
  }

  const circuit = createRuntime(test, {
    now: '2026-11-06T01:00:00.000Z',
    startupAt: '2026-11-06T00:00:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
    },
  })
  try {
    circuit.store.updateInitiativeState({
      circuitOpenedAt: '2026-11-06T00:50:00.000Z',
      updatedAt: '2026-11-06T00:50:00.000Z',
    })
    const outbox = circuit.store.enqueueOutbox({
      id: 'outbox-circuit-stale',
      target: 'web:owner',
      kind: 'proactive',
      text: '熔断期间不应发出的旧草稿。',
      maxAttempts: 3,
      createdAt: '2026-11-06T00:55:00.000Z',
    })
    await circuit.service.tick(new AbortController().signal)
    assert.equal(circuit.store.getOutbox(outbox.id)?.status, 'expired')
  } finally {
    circuit.close()
  }

  const restarted = createRuntime(test, {
    now: '2026-11-06T01:00:00.000Z',
    startupAt: '2026-11-06T00:59:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
    },
  })
  try {
    const outbox = restarted.store.enqueueOutbox({
      id: 'outbox-restart-stale',
      target: 'web:owner',
      kind: 'proactive',
      text: '重启前构思的旧草稿。',
      maxAttempts: 3,
      createdAt: '2026-11-06T00:58:00.000Z',
    })
    await restarted.service.tick(new AbortController().signal)
    assert.equal(restarted.store.getOutbox(outbox.id)?.status, 'expired')
  } finally {
    restarted.close()
  }
})

test('soft daily plan is scheduled after generation time and is not duplicated', async () => {
  const runtime = createRuntime(test, {
    now: '2026-11-06T13:00:00.000Z',
    configure: config => {
      config.proactive.enabled = false
      config.reminders.enabled = false
      config.review.enabled = false
      config.life.dayStartAt = '09:00'
      config.life.dayEndAt = '23:00'
      config.life.itemGapMinutes = 15
    },
  })
  runtime.brain.plan = {
    schemaVersion: 1,
    items: [
      {
        kind: 'reading',
        title: '读一段虚构的短篇。',
        durationMinutes: 45,
      },
    ],
  }
  try {
    const result = await runtime.service.tick(new AbortController().signal)
    assert.equal(result.planGenerated, true)
    const plan = runtime.service.view().plan
    assert.ok(plan)
    assert.equal(plan.localDay, '2026-11-06')
    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0]?.startsAt, '2026-11-06T13:15:00.000Z')
    assert.equal(plan.items[0]?.endsAt, '2026-11-06T14:00:00.000Z')
    assert.equal(plan.items[0]?.title, '读一段虚构的短篇。')

    runtime.clock.advanceByMs(60_000)
    const second = await runtime.service.tick(new AbortController().signal)
    assert.equal(second.planGenerated, false)
    assert.equal(runtime.brain.planCalls, 1)
  } finally {
    runtime.close()
  }
})

test('daily review stores a summary and deduplicates inferred memory candidates', async () => {
  const runtime = createRuntime(test, {
    now: '2026-11-05T16:35:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.proactive.enabled = false
      config.reminders.enabled = false
    },
    withMemory: true,
  })
  try {
    const source = runtime.store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '这是 11 月 5 日的虚构聊天，提到喜欢雨天。',
      createdAt: '2026-11-05T10:00:00.000Z',
    })
    runtime.brain.review = context => ({
      schemaVersion: 1,
      summary: '虚构摘要：这一天聊到雨天，也留出了安静的休息时间。',
      facts: [],
      memories: [
        {
          text: 'kano 在虚构测试里提到喜欢雨天。',
          kind: 'preference',
          importance: 'important',
          sensitivity: 'normal',
          messageIds: [context.messages[0]?.id ?? ''],
        },
        {
          text: 'kano 在虚构测试里提到喜欢雨天。',
          kind: 'preference',
          importance: 'important',
          sensitivity: 'normal',
          messageIds: [source.id],
        },
      ],
    })

    const result = await runtime.service.tick(new AbortController().signal)
    assert.equal(result.reviewCompleted, true)
    assert.equal(runtime.brain.reviewCalls, 1)
    const summary = runtime.store.getDailySummary('2026-11-05')
    assert.ok(summary)
    assert.equal(
      runtime.store.getBody(summary.bodyRef)?.content,
      '虚构摘要：这一天聊到雨天，也留出了安静的休息时间。',
    )
    assert.deepEqual(summary.sourceRefs, [source.id])
    const memories = runtime.memory?.listViews('candidate') ?? []
    assert.equal(memories.length, 1)
    assert.equal(memories[0]?.text, 'kano 在虚构测试里提到喜欢雨天。')

    const promoted = runtime.memory?.promote(memories[0]?.id ?? '')
    assert.ok(promoted)
    const recalled = runtime.memory?.search('雨天', { markRecalled: false }) ?? []
    assert.equal(recalled.length, 1)

    runtime.clock.advanceByMs(60_000)
    const second = await runtime.service.tick(new AbortController().signal)
    assert.equal(second.reviewCompleted, false)
    assert.equal(runtime.brain.reviewCalls, 1)
  } finally {
    runtime.close()
  }
})

test('emergency stop blocks the whole initiative tick and leaves work queued', async () => {
  const runtime = createRuntime(test, {
    now: '2026-11-06T01:00:00.000Z',
    configure: config => {
      config.life.enabled = false
      config.review.enabled = false
    },
  })
  try {
    const outbox = runtime.store.enqueueOutbox({
      id: 'outbox-stopped',
      target: 'web:owner',
      kind: 'system',
      text: '停止期间保持未发送的占位消息。',
      maxAttempts: 3,
      createdAt: '2026-11-06T00:59:00.000Z',
    })
    runtime.emergency.stop()
    const result = await runtime.service.tick(new AbortController().signal)
    assert.equal(result.status, 'stopped')
    assert.equal(result.deliveredOutbox, 0)
    assert.equal(runtime.brain.planCalls, 0)
    assert.equal(runtime.brain.proactiveCalls, 0)
    assert.equal(runtime.brain.reviewCalls, 0)
    assert.equal(runtime.store.getOutbox(outbox.id)?.status, 'pending')
  } finally {
    runtime.close()
  }
})

interface RuntimeOptions {
  now: string
  startupAt?: string
  configure?: (config: InitiativeConfig) => void
  withMemory?: boolean
}

interface Runtime {
  store: KanobotStorage
  clock: ReturnType<typeof createWorkspace>['clock']
  timezone: string
  config: InitiativeConfig
  brain: ScriptedBrain
  emergency: KanobotEmergencyService
  memory?: KanobotMemoryService
  service: KanobotInitiativeService
  close(): void
}

function createRuntime(t: TestContext, options: RuntimeOptions): Runtime {
  const ws = createWorkspace(t, { now: options.now })
  const store = ws.open()
  const config = structuredClone(ws.loaded.initiative)
  options.configure?.(config)
  const brain = new ScriptedBrain()
  const emergency = new KanobotEmergencyService(
    store,
    ws.root,
    ws.loaded.policy.emergency.stopFile,
    ws.clock,
  )
  const memory = options.withMemory === true
    ? new KanobotMemoryService(store, ws.clock)
    : undefined
  const service = new KanobotInitiativeService(store, brain, {
    config,
    timezone: ws.loaded.system.time.timezone,
    quietHoursStart: ws.loaded.system.time.quietHoursStart,
    quietHoursEnd: ws.loaded.system.time.quietHoursEnd,
    emergency,
    memory,
    clock: ws.clock,
    random: () => 0.5,
    startupAt: options.startupAt ?? options.now,
  })
  return {
    store,
    clock: ws.clock,
    timezone: ws.loaded.system.time.timezone,
    config,
    brain,
    emergency,
    memory,
    service,
    close(): void {
      store.close()
    },
  }
}

class ScriptedBrain implements InitiativeBrain {
  plan: DailyPlanDraft = { schemaVersion: 1, items: [] }
  planCalls = 0
  proactiveCalls = 0
  reviewCalls = 0
  proactive: (context: ProactiveContext) => ProactiveDraft = () => idleDraft()
  review: (context: DailyReviewContext) => DailyReviewDraft = context => ({
    schemaVersion: 1,
    summary: `虚构摘要：${context.messages.length} 条消息。`,
    facts: [],
    memories: [],
  })

  async planDay(): Promise<DailyPlanDraft> {
    this.planCalls += 1
    return this.plan
  }

  async composeProactive(context: ProactiveContext): Promise<ProactiveDraft> {
    this.proactiveCalls += 1
    return this.proactive(context)
  }

  async reviewDay(context: DailyReviewContext): Promise<DailyReviewDraft> {
    this.reviewCalls += 1
    return this.review(context)
  }
}

function idleDraft(): ProactiveDraft {
  return {
    schemaVersion: 1,
    shouldSend: false,
    message: '',
    reasonCode: 'nothing_to_say',
    careItemId: null,
  }
}
