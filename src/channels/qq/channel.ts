/**
 * QQ 渠道编排。
 *
 * 入站：白名单 -> 平台去重 -> 连发聚合 -> 图片读取 -> 每会话一次核心
 * 回合 -> 拆条发送。出站：只接受配置声明的 outbox 目标，经 STOP 和
 * 限频检查后投递，结果未知时绝不自动重试。
 */

import {
  CHAT_CONVERSATION_ID,
  type KanobotChatService,
} from '../../core/chat/index.ts'
import type { QqChannelConfig } from '../../core/config/index.ts'
import type { ExternalOutboxDeliveryResult } from '../../core/initiative/index.ts'
import type { KanobotEmergencyService } from '../../core/policy/index.ts'
import type { Clock } from '../../core/state/index.ts'
import type { KanobotStorage } from '../../core/storage/index.ts'
import {
  InboundCoalescer,
  fragmentKey,
} from '../coalescer.ts'
import type {
  ChannelLogger,
  ChannelSendResult,
  CoalescerResult,
  InboundTurn,
} from '../types.ts'
import {
  parseQqMessageEvent,
  shouldAcceptGroupMessage,
  type ParsedQqMessage,
} from './events.ts'
import {
  outboxTarget as formatOutboxTarget,
  parseOutboxTarget,
  parseQqTargetKey,
  splitQqText,
  targetAllowed,
  targetKey,
  QqFormatError,
  type QqTarget,
} from './format.ts'
import {
  OneBotActionError,
  type QqGateway,
  type QqGatewayState,
} from './gateway.ts'
import {
  QqMediaError,
  resolveQqImages,
  type ResolvedQqImage,
} from './media.ts'

const MAX_QUEUED_TURNS = 32
const RATE_WINDOW_MS = 60_000

export interface QqChannelOptions {
  config: QqChannelConfig
  storage: KanobotStorage
  emergency: KanobotEmergencyService
  gateway: QqGateway
  createChat(conversationId: string): KanobotChatService
  /** 所有者的 QQ 私聊映射到哪个网页会话；默认 main。 */
  ownerConversationId?: string
  maxImageBytes: number
  logger: ChannelLogger
  clock?: Clock
}

export class QqChannel {
  readonly outboxTarget: string | null

  private readonly config: QqChannelConfig
  private readonly storage: KanobotStorage
  private readonly emergency: KanobotEmergencyService
  private readonly gateway: QqGateway
  private readonly createChat: (conversationId: string) => KanobotChatService
  private readonly ownerConversationId: string
  private readonly maxImageBytes: number
  private readonly logger: ChannelLogger
  private readonly clock: Clock | undefined
  private readonly chats = new Map<string, KanobotChatService>()
  private readonly coalescer: InboundCoalescer
  private readonly activeControllers = new Set<AbortController>()
  private readonly inboundTurnTimes = new Map<string, number[]>()
  private readonly outboundPartTimes: number[] = []
  private selfId: string | null = null
  private started = false
  private closed = false
  private turnTail: Promise<void> = Promise.resolve()
  private queuedTurns = 0
  private claimedSincePurge = 0
  private connectionState: QqGatewayState = {
    connected: false,
    selfId: null,
    event: 'closed',
  }

  constructor(options: QqChannelOptions) {
    validateOptions(options)
    this.config = options.config
    this.storage = options.storage
    this.emergency = options.emergency
    this.gateway = options.gateway
    this.createChat = options.createChat
    this.ownerConversationId =
      options.ownerConversationId ?? CHAT_CONVERSATION_ID
    this.maxImageBytes = options.maxImageBytes
    this.logger = options.logger
    this.clock = options.clock
    this.outboxTarget = this.config.enabled &&
        this.config.autonomousTarget !== null
      ? formatOutboxTarget(this.config.autonomousTarget)
      : null
    this.coalescer = new InboundCoalescer({
      quietMs: this.config.coalesce.quietMs,
      maxWaitMs: this.config.coalesce.maxWaitMs,
      maxImages: this.config.coalesce.maxImages,
      maxTotalImageBytes: this.config.coalesce.maxTotalImageBytes,
      // 群聊会在正文前加发送者标签；预留余量，避免刚好 4000 字被核心拒绝。
      maxTextChars: 3_900,
      onResult: result => this.enqueueResult(result),
      onError: error => {
        this.logger.error?.(
          `[rinkobot-qq] coalescer callback failed: ${errorMessage(error)}`,
        )
      },
      now: () => this.now().getTime(),
    })
    this.gateway.setHandlers({
      onEvent: event => this.handleEventSafely(event),
      onState: state => this.handleState(state),
    })
  }

  start(): void {
    if (this.closed || this.started || !this.config.enabled) return
    this.started = true
    this.gateway.start()
  }

  supports(target: string): boolean {
    return !this.closed &&
      this.config.enabled &&
      this.outboxTarget !== null &&
      target === this.outboxTarget
  }

  async deliver(input: {
    target: string
    text: string
    signal: AbortSignal
  }): Promise<ExternalOutboxDeliveryResult> {
    if (!this.supports(input.target)) {
      return {
        status: 'not_delivered',
        errorCode: 'unsupported_target',
        retryable: false,
      }
    }
    const target = parseOutboxTarget(input.target)
    if (target === null) {
      return {
        status: 'not_delivered',
        errorCode: 'invalid_target',
        retryable: false,
      }
    }
    if (this.emergencyStopped()) {
      this.audit('outbound', 'send.blocked', 'failed', 'qq:stop', 'emergency_stopped')
      return {
        status: 'not_delivered',
        errorCode: 'emergency_stopped',
        retryable: false,
      }
    }
    let parts: string[]
    try {
      parts = splitQqText(
        input.text,
        this.config.outbound.splitChars,
        this.config.outbound.maxParts,
      )
    } catch (error) {
      const code = error instanceof QqFormatError
        ? error.code
        : 'reply_format_failed'
      return {
        status: 'not_delivered',
        errorCode: code,
        retryable: false,
      }
    }
    const result = await this.sendParts(target, parts, input.signal)
    return result
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.coalescer.dispose()
    for (const controller of this.activeControllers) {
      controller.abort()
    }
    this.activeControllers.clear()
    await this.gateway.close().catch(error => {
      this.logger.error?.(
        `[rinkobot-qq] gateway close failed: ${errorMessage(error)}`,
      )
    })
    await Promise.race([
      this.turnTail.catch(() => {}),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3_000)
        unrefTimer(timer)
      }),
    ])
  }

  pendingTurns(): number {
    return this.coalescer.pendingCount()
  }

  connection(): QqGatewayState {
    return { ...this.connectionState }
  }

  private handleState(state: QqGatewayState): void {
    this.connectionState = { ...state }
    if (state.selfId !== null) this.selfId = state.selfId
    if (state.event === 'opened') {
      this.audit(
        'inbound',
        'connection.opened',
        state.detailCode === undefined ? 'succeeded' : 'info',
        null,
        state.detailCode ?? null,
      )
      this.storage.purgeExpiredChannelInbound(this.now().toISOString())
    } else if (state.event === 'closed') {
      this.audit(
        'inbound',
        'connection.closed',
        'info',
        null,
        state.detailCode ?? null,
      )
    } else {
      this.audit(
        'inbound',
        'connection.reconnecting',
        'failed',
        null,
        state.detailCode ?? 'reconnecting',
      )
    }
  }

  /**
   * OneBot 事件来自不可信网络。解析、时钟或数据库异常都不能冒泡到
   * WebSocket 事件循环；记录脱敏错误后丢弃这一条事件，连接继续可用。
   */
  private handleEventSafely(raw: unknown): void {
    try {
      this.handleEvent(raw)
    } catch (error) {
      this.logger.error?.(
        `[rinkobot-qq] event handling failed: ${errorMessage(error)}`,
      )
      try {
        this.audit(
          'inbound',
          'event.failed',
          'failed',
          null,
          'event_processing_failed',
        )
      } catch {
        // 审计失败也不能反过来击穿 WebSocket 事件循环。
      }
    }
  }

  private handleEvent(raw: unknown): void {
    if (this.closed || !this.config.enabled) return
    const parsed = parseQqMessageEvent(raw, {
      selfId: this.selfId ?? this.gateway.currentSelfId(),
      privateAllow: this.config.privateAllow,
      groupAllow: this.config.groupAllow,
      groupRequireMention: this.config.groupRequireMention,
      now: () => this.now(),
    })
    if (parsed.kind === 'ignore') return
    const message = parsed.message
    const fragment = {
      channel: 'qq' as const,
      conversationKey: message.conversationKey,
      senderKey: message.senderKey,
      targetKey: message.targetKey,
      text: message.text,
      images: message.images,
      messageIds: [message.messageId],
      receivedAt: message.receivedAt,
    }
    const hasPending = this.coalescer.hasPending(fragmentKey(fragment))
    if (
      !shouldAcceptGroupMessage(
        message,
        this.config.groupRequireMention,
        hasPending,
      )
    ) {
      return
    }
    if (!this.claimInbound(message)) return
    const pushed = this.coalescer.push(fragment)
    if (!pushed.accepted) {
      this.audit(
        'inbound',
        'message.rejected',
        'failed',
        message.targetKey,
        pushed.reason ?? 'message_rejected',
      )
    }
  }

  private claimInbound(message: ParsedQqMessage): boolean {
    const now = this.now()
    const expires = new Date(
      now.getTime() + this.config.dedupeRetentionHours * 60 * 60 * 1_000,
    )
    const claimed = this.storage.claimChannelInbound({
      channel: 'qq',
      messageKey: message.messageKey,
      conversationKey: message.conversationKey,
      receivedAt: message.receivedAt,
      expiresAt: expires.toISOString(),
    })
    if (!claimed) {
      this.audit(
        'inbound',
        'message.duplicate',
        'info',
        message.targetKey,
        'duplicate_message_id',
      )
      return false
    }
    this.claimedSincePurge += 1
    if (this.claimedSincePurge >= 100) {
      this.claimedSincePurge = 0
      this.storage.purgeExpiredChannelInbound(now.toISOString())
    }
    return true
  }

  private enqueueResult(result: CoalescerResult): void {
    if (this.closed) return
    if (!result.ok) {
      this.audit(
        'inbound',
        'turn.rejected',
        'failed',
        result.targetKey || null,
        result.reason,
      )
      return
    }
    if (this.queuedTurns >= MAX_QUEUED_TURNS) {
      this.audit(
        'inbound',
        'turn.rejected',
        'failed',
        result.turn.targetKey,
        'turn_queue_full',
      )
      return
    }
    this.queuedTurns += 1
    const run = this.turnTail.then(() => this.processTurn(result.turn))
    this.turnTail = run
      .catch(error => {
        this.logger.error?.(
          `[rinkobot-qq] turn processing failed: ${errorMessage(error)}`,
        )
      })
      .finally(() => {
        this.queuedTurns -= 1
      })
  }

  private async processTurn(turn: InboundTurn): Promise<void> {
    if (this.closed) return
    if (this.emergencyStopped()) {
      this.audit(
        'inbound',
        'turn.rejected',
        'failed',
        turn.targetKey,
        'emergency_stopped',
      )
      return
    }
    if (!this.inboundRateAllowed(turn.conversationKey)) {
      this.audit(
        'inbound',
        'turn.rejected',
        'failed',
        turn.targetKey,
        'inbound_rate_limited',
      )
      return
    }
    const chat = this.chatFor(this.coreConversationId(turn))
    if (turn.images.length > 0 && !chat.visionView().enabled) {
      this.audit(
        'inbound',
        'turn.rejected',
        'failed',
        turn.targetKey,
        'vision_not_configured',
      )
      return
    }

    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.config.turnTimeoutMs)
    unrefTimer(timeout)
    try {
      let images: ResolvedQqImage[]
      try {
        images = await resolveQqImages(
          this.gateway,
          turn.images,
          {
            maxBytesPerImage: this.maxImageBytes,
            maxTotalBytes: this.config.coalesce.maxTotalImageBytes,
            downloadTimeoutMs: this.config.images.downloadTimeoutMs,
          },
          controller.signal,
        )
      } catch (error) {
        const code = error instanceof QqMediaError
          ? error.code
          : error instanceof OneBotActionError
            ? error.code
            : controller.signal.aborted
              ? 'turn_timeout'
              : 'image_failed'
        this.audit('inbound', 'turn.rejected', 'failed', turn.targetKey, code)
        return
      }
      const text = this.coreText(turn)
      const input = images.length === 0
        ? text
        : {
            ...(text === '' ? {} : { text }),
            images: images.map(image => ({
              mimeType: image.mimeType,
              data: image.base64,
            })),
          }
      let reply: string | null = null
      try {
        for await (const event of chat.streamMessage(
          input,
          controller.signal,
        )) {
          if (event.type === 'done') reply = event.message.text
        }
      } catch (error) {
        const code = chatErrorCode(error, controller.signal)
        this.audit('inbound', 'turn.failed', 'failed', turn.targetKey, code)
        return
      }
      if (reply === null) {
        this.audit(
          'inbound',
          'turn.failed',
          'failed',
          turn.targetKey,
          controller.signal.aborted ? 'turn_aborted' : 'reply_missing',
        )
        return
      }
      if (this.closed) return
      let parts: string[]
      try {
        parts = splitQqText(
          reply,
          this.config.outbound.splitChars,
          this.config.outbound.maxParts,
        )
      } catch (error) {
        const code = error instanceof QqFormatError
          ? error.code
          : 'reply_format_failed'
        this.audit('outbound', 'reply.failed', 'failed', turn.targetKey, code)
        return
      }
      const target = parseQqTargetKey(turn.targetKey)
      const sent = await this.sendParts(target, parts, controller.signal)
      this.audit(
        'outbound',
        'reply.completed',
        sent.status === 'delivered'
          ? 'succeeded'
          : sent.status === 'unknown'
            ? 'unknown'
            : 'failed',
        turn.targetKey,
        sent.status === 'delivered' ? null : sent.errorCode,
      )
    } finally {
      clearTimeout(timeout)
      this.activeControllers.delete(controller)
    }
  }

  private async sendParts(
    target: QqTarget,
    parts: readonly string[],
    signal: AbortSignal,
  ): Promise<ChannelSendResult> {
    if (!targetAllowed(target, this.config.privateAllow, this.config.groupAllow)) {
      return {
        status: 'failed',
        errorCode: 'target_not_allowed',
        retryable: false,
      }
    }
    if (!this.gateway.connected()) {
      return {
        status: 'failed',
        errorCode: 'channel_disconnected',
        retryable: true,
      }
    }
    let lastMessageId = ''
    let partsSent = 0
    for (let index = 0; index < parts.length; index += 1) {
      if (signal.aborted) {
        if (partsSent > 0) {
          return { status: 'unknown', errorCode: 'partial_delivery' }
        }
        return {
          status: 'failed',
          errorCode: 'aborted',
          retryable: true,
        }
      }
      if (this.emergencyStopped()) {
        this.audit(
          'outbound',
          'send.blocked',
          'failed',
          targetKey(target),
          'emergency_stopped',
        )
        return partsSent > 0
          ? { status: 'unknown', errorCode: 'partial_delivery' }
          : {
          status: 'failed',
          errorCode: 'emergency_stopped',
          retryable: false,
          }
      }
      try {
        await this.waitForOutboundCapacity(signal)
        lastMessageId = await this.gateway.sendText(
          target,
          parts[index] ?? '',
          signal,
        )
        partsSent += 1
        this.outboundPartTimes.push(this.now().getTime())
        this.audit(
          'outbound',
          'send.part',
          'succeeded',
          targetKey(target),
          null,
        )
      } catch (error) {
        if (error instanceof OneBotActionError) {
          if (error.mayHaveSent) {
            this.audit(
              'outbound',
              'send.part',
              'unknown',
              targetKey(target),
              error.code,
            )
            return { status: 'unknown', errorCode: error.code }
          }
          if (partsSent > 0) {
            this.audit(
              'outbound',
              'send.part',
              'unknown',
              targetKey(target),
              'partial_delivery',
            )
            return { status: 'unknown', errorCode: 'partial_delivery' }
          }
          this.audit(
            'outbound',
            'send.part',
            'failed',
            targetKey(target),
            error.code,
          )
          return {
            status: 'failed',
            errorCode: error.code,
            retryable:
              error.code === 'not_connected' ||
              error.code === 'channel_closed',
          }
        }
        this.audit(
          'outbound',
          'send.part',
          'unknown',
          targetKey(target),
          'send_failed_unknown',
        )
        return partsSent > 0
          ? { status: 'unknown', errorCode: 'partial_delivery' }
          : { status: 'unknown', errorCode: 'send_failed_unknown' }
      }
      if (index < parts.length - 1 && this.config.outbound.minIntervalMs > 0) {
        try {
          await delay(this.config.outbound.minIntervalMs, signal)
        } catch {
          if (partsSent > 0) {
            return { status: 'unknown', errorCode: 'partial_delivery' }
          }
          return {
            status: 'failed',
            errorCode: 'aborted',
            retryable: true,
          }
        }
      }
    }
    return { status: 'delivered', messageId: lastMessageId }
  }

  private async waitForOutboundCapacity(signal: AbortSignal): Promise<void> {
    const now = this.now().getTime()
    pruneBefore(this.outboundPartTimes, now - RATE_WINDOW_MS)
    if (this.outboundPartTimes.length < this.config.limits.maxOutboundPartsPerMinute) {
      return
    }
    const oldest = this.outboundPartTimes[0] ?? now
    const waitMs = Math.max(1, oldest + RATE_WINDOW_MS - now)
    await delay(waitMs, signal)
    pruneBefore(
      this.outboundPartTimes,
      this.now().getTime() - RATE_WINDOW_MS,
    )
  }

  private inboundRateAllowed(conversationKey: string): boolean {
    const now = this.now().getTime()
    const times = this.inboundTurnTimes.get(conversationKey) ?? []
    pruneBefore(times, now - RATE_WINDOW_MS)
    if (times.length >= this.config.limits.maxInboundTurnsPerMinute) {
      this.inboundTurnTimes.set(conversationKey, times)
      return false
    }
    times.push(now)
    this.inboundTurnTimes.set(conversationKey, times)
    return true
  }

  private chatFor(conversationId: string): KanobotChatService {
    const existing = this.chats.get(conversationId)
    if (existing !== undefined) return existing
    const created = this.createChat(conversationId)
    this.chats.set(conversationId, created)
    return created
  }

  /**
   * 只有显式匹配 owner_qq 的私聊进入网页主会话。其他私聊和群聊永远
   * 使用自己的 conversationKey，避免把第三人的上下文混进所有者对话。
   */
  private coreConversationId(turn: InboundTurn): string {
    const target = parseQqTargetKey(turn.targetKey)
    return target.kind === 'private' &&
        this.config.ownerQqId !== null &&
        target.id === this.config.ownerQqId
      ? this.ownerConversationId
      : turn.conversationKey
  }

  private coreText(turn: InboundTurn): string {
    if (turn.text === '') return ''
    if (turn.targetKey.startsWith('private:')) return turn.text
    const senderId = turn.senderKey.split(':').at(-1) ?? 'unknown'
    return `[QQ 群成员 ${senderId}]\n${turn.text}`
  }

  private audit(
    direction: 'inbound' | 'outbound',
    kind: string,
    outcome: 'succeeded' | 'failed' | 'unknown' | 'info',
    targetId: string | null,
    detailCode: string | null,
  ): void {
    try {
      this.storage.recordChannelAudit({
        channel: 'qq',
        direction,
        kind,
        outcome,
        targetId,
        detailCode,
        occurredAt: this.now().toISOString(),
      })
    } catch (error) {
      this.logger.error?.(
        `[rinkobot-qq] channel audit failed: ${errorMessage(error)}`,
      )
    }
  }

  private emergencyStopped(): boolean {
    try {
      return this.emergency.status().stopped
    } catch {
      return true
    }
  }

  private now(): Date {
    const value = this.clock?.now() ?? new Date()
    if (Number.isNaN(value.getTime())) {
      throw new RangeError('QQ channel clock returned an invalid date')
    }
    return value
  }
}

function validateOptions(options: QqChannelOptions): void {
  if (
    !Number.isSafeInteger(options.maxImageBytes) ||
    options.maxImageBytes < 1 ||
    options.maxImageBytes > 5 * 1024 * 1024
  ) {
    throw new RangeError('maxImageBytes must be between 1 and 5242880')
  }
}

function chatErrorCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'turn_aborted'
  const candidate = error as { code?: unknown; name?: unknown }
  if (
    typeof candidate.code === 'string' &&
    /^[a-z][a-z0-9_.-]{0,63}$/.test(candidate.code)
  ) {
    return candidate.code
  }
  return 'chat_failed'
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError())
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    unrefTimer(timer)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function pruneBefore(values: number[], cutoff: number): void {
  let remove = 0
  while (remove < values.length && (values[remove] ?? 0) < cutoff) {
    remove += 1
  }
  if (remove > 0) values.splice(0, remove)
}

function unrefTimer(
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
