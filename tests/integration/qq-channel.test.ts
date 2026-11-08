/**
 * QQ 渠道集成测试。
 *
 * 使用内存 OneBot 网关、假模型和临时 SQLite，验证白名单、群 @、连发
 * 聚合、多图、失败闭环、去重、STOP、审计脱敏和主动消息同步。测试不连接
 * 真实 NapCat，也不读取真实 QQ 凭据。
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { TestContext } from 'node:test'

import {
  OneBotActionError,
  QqChannel,
  type OneBotActionResponse,
  type QqGateway,
  type QqGatewayHandlers,
  type QqGatewayState,
  type QqTarget,
} from '../../src/channels/index.ts'
import {
  KanobotChatService,
  type ChatInitiativeOptions,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
} from '../../src/core/chat/index.ts'
import {
  KanobotInitiativeService,
  MockInitiativeBrain,
} from '../../src/core/initiative/index.ts'
import { KanobotEmergencyService } from '../../src/core/policy/index.ts'
import type { KanobotStorage } from '../../src/core/storage/index.ts'
import type {
  VisionDescribeRequest,
  VisionDescription,
  VisionModel,
} from '../../src/core/vision/index.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'
import { createWorkspace, type Workspace } from '../helpers/storage-fixture.ts'
import {
  TEST_IMAGES,
  TEST_PNG_BASE64,
} from '../helpers/vision-fixtures.ts'

const SELF_ID = '99999'
const OWNER_ID = '10001'
const OTHER_ID = '40004'
const GROUP_ID = '20002'
const GROUP_MEMBER_ID = '30003'
const FIXED_TIME = 1_791_000_000

test('accepts only whitelisted QQ messages and merges a mentioned group burst', async () => {
  const harness = createHarness(test)
  try {
    harness.gateway.emit(
      privateEvent({
        messageId: 1,
        userId: 88888,
        text: '白名单外的私聊不应处理',
      }),
    )
    harness.gateway.emit(
      groupEvent({
        messageId: 2,
        text: '未 @ 机器人的群消息不应处理',
      }),
    )
    await delay(80)
    assert.equal(harness.chatModel.requests.length, 0)
    assert.equal(harness.gateway.sent.length, 0)

    harness.gateway.emit(
      groupEvent({
        messageId: 3,
        text: '第一段',
        mentioned: true,
      }),
    )
    harness.gateway.emit(
      groupEvent({
        messageId: 4,
        text: '第二段',
        mentioned: false,
      }),
    )
    harness.ws.clock.advanceByMs(30)

    await waitUntil(
      () =>
        harness.chatModel.requests.length === 1 &&
        harness.gateway.sent.length > 0,
    )
    assert.equal(harness.chatModel.requests.length, 1)
    const current = harness.chatModel.requests[0]?.messages.at(-1)?.text ?? ''
    assert.match(current, /\[QQ 群成员 30003\]/)
    assert.match(current, /第一段/)
    assert.match(current, /第二段/)
    assert.deepEqual(harness.gateway.sent[0]?.target, {
      kind: 'group',
      id: GROUP_ID,
    })

    const unsupported = await harness.channel.deliver({
      target: 'qq:private:88888',
      text: '白名单外目标不能发送',
      signal: new AbortController().signal,
    })
    assert.equal(unsupported.status, 'not_delivered')
    assert.equal(unsupported.errorCode, 'unsupported_target')
    assert.equal(harness.gateway.sent.length, 1)
  } finally {
    await harness.close()
  }
})

test('owner QQ shares main while other private chats stay isolated', async () => {
  const harness = createHarness(test, {
    ownerQqId: OWNER_ID,
    privateAllow: [OWNER_ID, OTHER_ID],
  })
  try {
    harness.gateway.emit(
      privateEvent({
        messageId: 20,
        userId: Number(OTHER_ID),
        text: '第三人私聊的虚构标记',
      }),
    )
    harness.ws.clock.advanceByMs(30)
    await waitUntil(
      () => harness.store.chatMessageCount('qq-private-40004') === 2,
    )

    harness.gateway.emit(
      privateEvent({
        messageId: 21,
        userId: Number(OWNER_ID),
        text: '所有者私聊的虚构标记',
      }),
    )
    harness.ws.clock.advanceByMs(30)
    await waitUntil(() => harness.store.chatMessageCount('main') === 2)

    const ownerRequest = harness.chatModel.requests.at(-1)
    assert.equal(
      JSON.stringify(ownerRequest?.messages ?? []).includes('第三人私聊'),
      false,
    )

    harness.gateway.emit(
      privateEvent({
        messageId: 22,
        userId: Number(OWNER_ID),
        text: '所有者第二轮的虚构标记',
      }),
    )
    harness.ws.clock.advanceByMs(30)
    await waitUntil(() => harness.store.chatMessageCount('main') === 4)

    const mainMessages = harness.store.listChatMessages('main', 10)
    assert.deepEqual(
      mainMessages.map(message => message.text),
      [
        '所有者私聊的虚构标记',
        '这是 QQ 渠道的虚构测试回复。',
        '所有者第二轮的虚构标记',
        '这是 QQ 渠道的虚构测试回复。',
      ],
    )
    assert.equal(harness.store.chatMessageCount('qq-private-40004'), 2)
    assert.equal(
      harness.store
        .listChatMessages('qq-private-40004', 10)
        .some(message => message.text.includes('所有者私聊')),
      false,
    )
    const secondOwnerRequest = harness.chatModel.requests.at(-1)
    const secondOwnerContext = JSON.stringify(
      secondOwnerRequest?.messages ?? [],
    )
    assert.equal(
      secondOwnerContext.includes('所有者私聊的虚构标记'),
      true,
    )
    assert.equal(
      secondOwnerContext.includes('这是 QQ 渠道的虚构测试回复。'),
      true,
    )
    assert.equal(secondOwnerContext.includes('第三人私聊'), false)

    harness.gateway.emit(
      groupEvent({
        messageId: 23,
        text: '群聊的虚构标记',
        mentioned: true,
      }),
    )
    harness.ws.clock.advanceByMs(30)
    await waitUntil(() => harness.store.chatMessageCount('qq-group-20002') === 2)
    assert.equal(harness.store.chatMessageCount('main'), 4)
    assert.equal(
      harness.store
        .listChatMessages('main', 10)
        .some(message => message.text.includes('群聊的虚构标记')),
      false,
    )
    assert.deepEqual(
      [...harness.createdChatIds].sort(),
      ['main', 'qq-group-20002', 'qq-private-40004'],
    )
  } finally {
    await harness.close()
  }
})

test('coalesces three texts and two images into one core turn', async () => {
  const harness = createHarness(test, { withVision: true })
  try {
    const firstImage = writeImage(harness.ws.root, 'first.png')
    const secondImage = writeImage(harness.ws.root, 'second.png')
    harness.gateway.imagePaths.set('first.png', firstImage)
    harness.gateway.imagePaths.set('second.png', secondImage)

    harness.gateway.emit(
      privateEvent({ messageId: 10, text: '第一条文字' }),
    )
    harness.gateway.emit(
      privateEvent({
        messageId: 11,
        images: ['first.png'],
      }),
    )
    harness.gateway.emit(
      privateEvent({ messageId: 12, text: '第二条文字' }),
    )
    harness.gateway.emit(
      privateEvent({
        messageId: 13,
        images: ['second.png'],
      }),
    )
    harness.gateway.emit(
      privateEvent({ messageId: 14, text: '第三条文字' }),
    )
    harness.ws.clock.advanceByMs(30)

    await waitUntil(
      () =>
        harness.chatModel.requests.length === 1 &&
        harness.gateway.sent.length > 0,
    )
    assert.equal(harness.chatModel.requests.length, 1)
    assert.equal(harness.visionModel.calls.length, 2)
    const current = harness.chatModel.requests[0]?.messages.at(-1)?.text ?? ''
    assert.match(current, /第一条文字/)
    assert.match(current, /第二条文字/)
    assert.match(current, /第三条文字/)

    const messages = harness.store.listChatMessages(
      'qq-private-10001',
      100,
    )
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, 'user')
    assert.match(messages[0]?.text ?? '', /第一条文字/)
    assert.match(messages[0]?.text ?? '', /第三条文字/)

    const auditJson = readChannelAuditJson(harness.store)
    assert.equal(auditJson.includes('第一条文字'), false)
    assert.equal(auditJson.includes('第三条文字'), false)
    assert.equal(auditJson.includes(TEST_PNG_BASE64), false)
    assert.equal(auditJson.includes(firstImage), false)
  } finally {
    await harness.close()
  }
})

test('image resolution failure never calls the chat or vision model', async () => {
  const harness = createHarness(test, { withVision: true })
  try {
    harness.gateway.failImages = true
    harness.gateway.emit(
      privateEvent({
        messageId: 20,
        text: '这张图片会失败',
        images: ['missing.png'],
      }),
    )
    harness.ws.clock.advanceByMs(30)

    await waitUntil(() =>
      harness.store
        .listChannelAudit(100)
        .some(
          item =>
            item.kind === 'turn.rejected' &&
            item.detailCode !== null,
        ),
    )
    assert.equal(harness.chatModel.requests.length, 0)
    assert.equal(harness.visionModel.calls.length, 0)
    assert.equal(harness.gateway.sent.length, 0)
    assert.equal(
      harness.store.chatMessageCount('qq-private-10001'),
      0,
    )
  } finally {
    await harness.close()
  }
})

test('a duplicate message id survives closing and recreating the channel', async () => {
  const harness = createHarness(test)
  try {
    const event = privateEvent({
      messageId: 30,
      text: '只应处理一次的虚构消息',
    })
    harness.gateway.emit(event)
    harness.ws.clock.advanceByMs(30)
    await waitUntil(
      () =>
        harness.chatModel.requests.length === 1 &&
        harness.gateway.sent.length === 1,
    )

    const first = harness.channels[0]
    assert.ok(first)
    await first.close()
    const gateway = new FakeQqGateway()
    const second = harness.newChannel(gateway)
    second.start()
    gateway.emit(event)

    await delay(120)
    assert.equal(harness.chatModel.requests.length, 1)
    assert.equal(gateway.sent.length, 0)
    assert.ok(
      harness.store
        .listChannelAudit(100)
        .some(item => item.kind === 'message.duplicate'),
    )
  } finally {
    await harness.close()
  }
})

test('STOP prevents a reply that was already being generated from being sent', async () => {
  const model = new GatedChatModel()
  const harness = createHarness(test, { chatModel: model })
  try {
    harness.gateway.emit(
      privateEvent({ messageId: 40, text: '生成过程中触发的停止测试' }),
    )
    harness.ws.clock.advanceByMs(30)
    await waitUntil(() => model.entered)
    harness.emergency.stop()
    model.release()

    await waitUntil(() =>
      harness.store
        .listChannelAudit(100)
        .some(item => item.kind === 'send.blocked'),
    )
    assert.equal(harness.gateway.sent.length, 0)
    assert.equal(model.requests.length, 1)
  } finally {
    await harness.close()
  }
})

test('a delivered QQ proactive outbox also appears in the web conversation', async () => {
  const harness = createHarness(test, {
    autonomousTarget: { kind: 'private', id: OWNER_ID },
  })
  try {
    const config = structuredClone(harness.ws.loaded.initiative)
    config.life.enabled = false
    config.proactive.enabled = false
    config.reminders.enabled = false
    config.review.enabled = false
    const now = harness.ws.clock.now().toISOString()
    const initiative = new KanobotInitiativeService(
      harness.store,
      new MockInitiativeBrain(),
      {
        config,
        timezone: harness.ws.loaded.system.time.timezone,
        quietHoursStart: harness.ws.loaded.system.time.quietHoursStart,
        quietHoursEnd: harness.ws.loaded.system.time.quietHoursEnd,
        emergency: harness.emergency,
        outboxTarget: harness.channel.outboxTarget ?? '',
        externalOutbox: harness.channel,
        clock: harness.ws.clock,
        startupAt: now,
      },
    )
    const outbox = harness.store.enqueueOutbox({
      target: harness.channel.outboxTarget ?? '',
      kind: 'proactive',
      text: '通过 QQ 主动发送、同时同步到网页的虚构消息。',
      dueAt: now,
      maxAttempts: 3,
      createdAt: now,
    })

    const result = await initiative.tick(new AbortController().signal)
    assert.equal(result.deliveredOutbox, 1)
    assert.deepEqual(harness.gateway.sent[0]?.target, {
      kind: 'private',
      id: OWNER_ID,
    })
    assert.equal(
      harness.store.getOutbox(outbox.id)?.status,
      'delivered',
    )
    assert.deepEqual(
      harness.store
        .listChatMessages('main', 10)
        .map(message => message.text),
      ['通过 QQ 主动发送、同时同步到网页的虚构消息。'],
    )
  } finally {
    await harness.close()
  }
})

test('an unknown QQ send result is never retried as a new message', async () => {
  const harness = createHarness(test, {
    autonomousTarget: { kind: 'private', id: OWNER_ID },
  })
  try {
    harness.gateway.sendError = new OneBotActionError(
      'missing_message_id',
      'NapCat accepted the action but returned no message id',
      true,
    )
    const config = structuredClone(harness.ws.loaded.initiative)
    config.life.enabled = false
    config.proactive.enabled = false
    config.reminders.enabled = false
    config.review.enabled = false
    const now = harness.ws.clock.now().toISOString()
    const initiative = new KanobotInitiativeService(
      harness.store,
      new MockInitiativeBrain(),
      {
        config,
        timezone: harness.ws.loaded.system.time.timezone,
        quietHoursStart: harness.ws.loaded.system.time.quietHoursStart,
        quietHoursEnd: harness.ws.loaded.system.time.quietHoursEnd,
        emergency: harness.emergency,
        outboxTarget: harness.channel.outboxTarget ?? '',
        externalOutbox: harness.channel,
        clock: harness.ws.clock,
        startupAt: now,
      },
    )
    const outbox = harness.store.enqueueOutbox({
      target: harness.channel.outboxTarget ?? '',
      kind: 'proactive',
      text: '结果未知时不能自动补发的虚构消息。',
      dueAt: now,
      maxAttempts: 3,
      createdAt: now,
    })

    const first = await initiative.tick(new AbortController().signal)
    assert.equal(first.deliveredOutbox, 0)
    assert.equal(harness.gateway.sendAttempts, 1)
    assert.equal(harness.store.getOutbox(outbox.id)?.status, 'unknown')

    harness.ws.clock.advanceByMs(60_000)
    const second = await initiative.tick(new AbortController().signal)
    assert.equal(second.deliveredOutbox, 0)
    assert.equal(harness.gateway.sendAttempts, 1)
    assert.equal(harness.store.getOutbox(outbox.id)?.status, 'unknown')
  } finally {
    await harness.close()
  }
})

test('a reconnected QQ channel deduplicates, confirms, and delivers a reminder', async () => {
  const dueAt = '2026-11-07T02:05:00.000Z'
  const model = new QueueEnvelopeChatModel([
    chatEnvelopeText('你想几点洗澡？', {
      reminderCandidates: [{
        text: '提醒 kano 洗澡。',
        dueAt,
      }],
    }),
    chatEnvelopeText('好，到时间我提醒你。'),
  ])
  const harness = createHarness(test, {
    chatModel: model,
    withInitiative: true,
    autonomousTarget: { kind: 'private', id: OWNER_ID },
  })
  try {
    const original = privateEvent({
      messageId: 200,
      text: '晚点提醒我洗澡喵。',
    })
    harness.gateway.emit(original)
    harness.ws.clock.advanceByMs(30)
    await waitUntil(
      () =>
        model.requests.length === 1 &&
        harness.gateway.sent.length === 1,
    )
    assert.equal(harness.store.listReminderCandidates('pending').length, 1)
    assert.equal(harness.store.listReminders('all').length, 0)

    const first = harness.channels[0]
    assert.ok(first)
    await first.close()
    const secondGateway = new FakeQqGateway()
    const second = harness.newChannel(secondGateway)
    second.start()

    secondGateway.emit(original)
    await delay(120)
    assert.equal(model.requests.length, 1)
    assert.equal(secondGateway.sent.length, 0)
    assert.ok(
      harness.store
        .listChannelAudit(100)
        .some(item => item.kind === 'message.duplicate'),
    )

    secondGateway.emit(privateEvent({
      messageId: 201,
      text: '可以喵',
    }))
    harness.ws.clock.advanceByMs(30)
    await waitUntil(
      () =>
        model.requests.length === 2 &&
        secondGateway.sent.length === 1,
    )
    assert.equal(harness.store.listReminderCandidates('pending').length, 0)
    assert.equal(harness.store.listReminders('all').length, 1)

    const config = structuredClone(harness.ws.loaded.initiative)
    config.life.enabled = false
    config.proactive.enabled = false
    config.reminders.enabled = true
    config.review.enabled = false
    const initiative = new KanobotInitiativeService(
      harness.store,
      new MockInitiativeBrain(),
      {
        config,
        timezone: harness.ws.loaded.system.time.timezone,
        quietHoursStart: harness.ws.loaded.system.time.quietHoursStart,
        quietHoursEnd: harness.ws.loaded.system.time.quietHoursEnd,
        emergency: harness.emergency,
        outboxTarget: second.outboxTarget ?? '',
        externalOutbox: second,
        clock: harness.ws.clock,
        startupAt: harness.ws.clock.now().toISOString(),
      },
    )
    harness.ws.clock.advanceByMs(5 * 60_000 + 1_000)
    const tick = await initiative.tick(new AbortController().signal)
    assert.equal(tick.deliveredOutbox, 1)
    assert.equal(secondGateway.sent.length, 2)
    assert.equal(secondGateway.sent[1]?.text, '提醒 kano 洗澡。')
    assert.deepEqual(secondGateway.sent[1]?.target, {
      kind: 'private',
      id: OWNER_ID,
    })
    assert.equal(harness.store.listReminders('all')[0]?.status, 'delivered')
  } finally {
    await harness.close()
  }
})

interface HarnessOptions {
  withVision?: boolean
  withInitiative?: boolean
  chatModel?: ChatModel
  autonomousTarget?: { kind: 'private' | 'group'; id: string }
  ownerQqId?: string | null
  privateAllow?: string[]
}

interface Harness {
  ws: Workspace
  store: KanobotStorage
  chatModel: CapturingChatModel
  visionModel: CapturingVisionModel
  gateway: FakeQqGateway
  channels: QqChannel[]
  channel: QqChannel
  createdChatIds: string[]
  emergency: KanobotEmergencyService
  newChannel(gateway: FakeQqGateway): QqChannel
  close(): Promise<void>
}

function createHarness(
  t: TestContext,
  options: HarnessOptions = {},
): Harness {
  const ws = createWorkspace(t, { now: '2026-11-07T02:00:00.000Z' })
  const store = ws.open()
  const qq = structuredClone(ws.loaded.channels.qq)
  qq.enabled = true
  qq.ownerQqId = options.ownerQqId ?? null
  qq.privateAllow = options.privateAllow ?? [OWNER_ID]
  qq.groupAllow = [GROUP_ID]
  qq.groupRequireMention = true
  qq.coalesce.quietMs = 25
  qq.coalesce.maxWaitMs = 500
  qq.outbound.minIntervalMs = 0
  qq.limits.maxInboundTurnsPerMinute = 60
  qq.limits.maxOutboundPartsPerMinute = 120
  qq.autonomousTarget = options.autonomousTarget ?? null

  const chatModel = (options.chatModel ?? new CapturingChatModel()) as
    CapturingChatModel
  const visionModel = new CapturingVisionModel()
  const emergency = new KanobotEmergencyService(
    store,
    ws.root,
    ws.loaded.policy.emergency.stopFile,
    ws.clock,
  )
  const channels: QqChannel[] = []
  const createdChatIds: string[] = []
  const createChat = (conversationId: string): KanobotChatService => {
    createdChatIds.push(conversationId)
    return new KanobotChatService(store, chatModel, {
      conversationId,
      initiative: options.withInitiative === true
        ? chatInitiativeOptions(emergency, ws.loaded)
        : undefined,
      vision: options.withVision === true
        ? {
            model: visionModel,
            maxImageBytes: ws.loaded.system.vision.maxImageBytes,
            maxDescriptionChars: ws.loaded.system.vision.maxDescriptionChars,
            maxImages: qq.coalesce.maxImages,
          }
        : undefined,
    })
  }

  const newChannel = (gateway: FakeQqGateway): QqChannel => {
    const channel = new QqChannel({
      config: qq,
      storage: store,
      emergency,
      gateway,
      createChat,
      maxImageBytes: ws.loaded.system.vision.maxImageBytes,
      logger: { info(): void {}, error(): void {} },
      clock: ws.clock,
    })
    channels.push(channel)
    if (!gateway.connected()) gateway.start()
    return channel
  }

  const gateway = new FakeQqGateway()
  const channel = newChannel(gateway)
  channel.start()
  return {
    ws,
    store,
    chatModel,
    visionModel,
    gateway,
    channels,
    channel,
    createdChatIds,
    emergency,
    newChannel(gateway: FakeQqGateway): QqChannel {
      const created = newChannel(gateway)
      created.start()
      return created
    },
    async close(): Promise<void> {
      for (const item of channels.slice().reverse()) {
        await item.close()
      }
      store.close()
    },
  }
}

function chatInitiativeOptions(
  emergency: KanobotEmergencyService,
  loaded: Workspace['loaded'],
): ChatInitiativeOptions {
  return {
    remindersEnabled: loaded.initiative.reminders.enabled,
    maxReminderDaysAhead: loaded.initiative.reminders.maxDaysAhead,
    followUpsEnabled: loaded.initiative.proactive.followUpsEnabled,
    followUpWindowHours:
      loaded.initiative.proactive.followUpWindowHours,
    followUpMaxDaysAhead:
      loaded.initiative.proactive.followUpMaxDaysAhead,
    isAutonomousAllowed: () => !emergency.status().stopped,
  }
}

class FakeQqGateway implements QqGateway {
  readonly sent: Array<{ target: QqTarget; text: string }> = []
  readonly imagePaths = new Map<string, string>()
  failImages = false
  sendError: OneBotActionError | null = null
  sendAttempts = 0
  private handlers: QqGatewayHandlers | null = null
  private connectedFlag = false
  private nextMessageId = 90_000

  start(): void {
    if (this.connectedFlag) return
    this.connectedFlag = true
    this.handlers?.onState({
      connected: true,
      selfId: SELF_ID,
      event: 'opened',
    })
  }

  async close(): Promise<void> {
    if (!this.connectedFlag) return
    this.connectedFlag = false
    this.handlers?.onState({
      connected: false,
      selfId: SELF_ID,
      event: 'closed',
      detailCode: 'channel_closed',
    })
  }

  connected(): boolean {
    return this.connectedFlag
  }

  currentSelfId(): string | null {
    return SELF_ID
  }

  setHandlers(handlers: QqGatewayHandlers): void {
    this.handlers = handlers
  }

  emit(event: unknown): void {
    this.handlers?.onEvent(event)
  }

  async sendText(
    target: QqTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      throw new OneBotActionError('aborted', 'test send aborted', false)
    }
    this.sendAttempts += 1
    if (!this.connectedFlag) {
      throw new OneBotActionError(
        'not_connected',
        'test gateway is not connected',
        false,
      )
    }
    if (this.sendError !== null) throw this.sendError
    this.sent.push({ target, text })
    const messageId = String(this.nextMessageId)
    this.nextMessageId += 1
    return messageId
  }

  async getImage(file: string): Promise<OneBotActionResponse> {
    if (this.failImages) {
      throw new OneBotActionError('image_failed', 'test image failed', false)
    }
    const path = this.imagePaths.get(file)
    if (path === undefined) {
      throw new OneBotActionError(
        'image_missing',
        'test image is missing',
        false,
      )
    }
    return { status: 'ok', retcode: 0, data: { file: path } }
  }

  async getFile(fileId: string): Promise<OneBotActionResponse> {
    if (this.failImages) {
      throw new OneBotActionError('image_failed', 'test image failed', false)
    }
    const path = this.imagePaths.get(fileId)
    return path === undefined
      ? { status: 'failed', retcode: 1, data: {} }
      : { status: 'ok', retcode: 0, data: { file: path } }
  }

  async getMsg(): Promise<OneBotActionResponse> {
    throw new OneBotActionError(
      'image_missing',
      'test message has no fresh image URL',
      false,
    )
  }
}

class CapturingChatModel implements ChatModel {
  readonly id = 'test/chat-model'
  readonly mode = 'test'
  readonly provider = 'test'
  readonly requests: ChatModelRequest[] = []

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.requests.push(request)
    yield {
      type: 'text',
      text: chatEnvelopeText('这是 QQ 渠道的虚构测试回复。'),
    }
    yield resultEvent()
  }
}

class QueueEnvelopeChatModel implements ChatModel {
  readonly id = 'test/queued-envelope-model'
  readonly mode = 'test'
  readonly provider = 'test'
  readonly requests: ChatModelRequest[] = []
  private readonly envelopes: string[]

  constructor(envelopes: string[]) {
    this.envelopes = [...envelopes]
  }

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.requests.push(request)
    const envelope = this.envelopes.shift()
    if (envelope === undefined) {
      throw new Error('unexpected QQ chat turn in test model')
    }
    yield { type: 'text', text: envelope }
    yield resultEvent()
  }
}

class CapturingVisionModel implements VisionModel {
  readonly id = 'test/vision-model'
  readonly mode = 'test'
  readonly provider = 'test'
  readonly calls: VisionDescribeRequest[] = []

  async describeImage(
    request: VisionDescribeRequest,
  ): Promise<VisionDescription> {
    this.calls.push(request)
    return {
      text: `这是第 ${this.calls.length} 张虚构图片的转述。`,
      attempts: 1,
      usage: null,
      estimatedCost: null,
      pricing: null,
      responseId: `vision-${this.calls.length}`,
    }
  }
}

class GatedChatModel extends CapturingChatModel {
  entered = false
  private releaseGate: (() => void) | null = null

  override async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.requests.push(request)
    this.entered = true
    yield {
      type: 'text',
      text: chatEnvelopeText('这条回复在发送前会先遇到 STOP。'),
    }
    await new Promise<void>(resolve => {
      this.releaseGate = resolve
    })
    yield resultEvent()
  }

  release(): void {
    const release = this.releaseGate
    this.releaseGate = null
    release?.()
  }
}

function resultEvent(): ChatModelStreamEvent {
  return {
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

function privateEvent(options: {
  messageId: number
  userId?: number
  text?: string
  images?: string[]
}): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: Number(SELF_ID),
    user_id: options.userId ?? Number(OWNER_ID),
    message_id: options.messageId,
    time: FIXED_TIME,
    message: messageSegments(options.text, options.images),
  }
}

function groupEvent(options: {
  messageId: number
  text?: string
  mentioned: boolean
}): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: Number(SELF_ID),
    group_id: Number(GROUP_ID),
    user_id: Number(GROUP_MEMBER_ID),
    message_id: options.messageId,
    time: FIXED_TIME,
    message: [
      ...(options.mentioned
        ? [{ type: 'at', data: { qq: Number(SELF_ID) } }]
        : []),
      ...messageSegments(options.text, undefined),
    ],
  }
}

function messageSegments(
  text: string | undefined,
  images: string[] | undefined,
): unknown[] {
  return [
    ...(text === undefined ? [] : [{ type: 'text', data: { text } }]),
    ...(images ?? []).map(file => ({
      type: 'image',
      data: {
        file,
        file_id: file,
        file_size: TEST_IMAGES['image/png'].byteLength,
      },
    })),
  ]
}

function writeImage(root: string, name: string): string {
  const path = join(root, name)
  writeFileSync(path, TEST_IMAGES['image/png'])
  return path
}

function readChannelAuditJson(store: KanobotStorage): string {
  const db = new DatabaseSync(store.databasePath, { readOnly: true })
  try {
    return JSON.stringify(
      db.prepare('SELECT * FROM channel_audit').all(),
    )
  } finally {
    db.close()
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('timed out waiting for QQ channel condition')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
