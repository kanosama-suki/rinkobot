/**
 * QQ 连发消息的逻辑回合聚合器。
 *
 * 只做时间窗口、文本/图片合并和上限检查；不读取图片字节、不调用模型，
 * 也不做平台去重。每个 key 由“会话 + 发送者”组成，群友之间不会串轮。
 */

import type {
  CoalescerResult,
  InboundFragment,
  InboundTurn,
} from './types.ts'

export interface CoalescerOptions {
  quietMs: number
  maxWaitMs: number
  maxImages: number
  maxTotalImageBytes: number
  maxTextChars: number
  onResult(result: CoalescerResult): void | Promise<void>
  onError?(error: unknown): void
  now?(): number
  setTimer?(callback: () => void, delayMs: number): unknown
  clearTimer?(timer: unknown): void
}

export interface CoalescerPushResult {
  accepted: boolean
  reason?: string
  key: string
}

interface PendingEntry {
  key: string
  fragments: InboundFragment[]
  firstAt: number
  lastAt: number
  textChars: number
  imageCount: number
  declaredImageBytes: number
  overflowCode: string | null
  timer: unknown | null
}

export class InboundCoalescer {
  private readonly options: CoalescerOptions
  private readonly pending = new Map<string, PendingEntry>()
  private disposed = false

  constructor(options: CoalescerOptions) {
    validateInteger(options.quietMs, 'quietMs', 1, 60_000)
    validateInteger(options.maxWaitMs, 'maxWaitMs', options.quietMs, 120_000)
    validateInteger(options.maxImages, 'maxImages', 1, 4)
    validateInteger(
      options.maxTotalImageBytes,
      'maxTotalImageBytes',
      1,
      20 * 1024 * 1024,
    )
    validateInteger(options.maxTextChars, 'maxTextChars', 1, 4_000)
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? ((callback, delay) => setTimeout(callback, delay)),
      clearTimer: options.clearTimer ?? (timer => {
        clearTimeout(timer as ReturnType<typeof setTimeout>)
      }),
    }
  }

  push(fragment: InboundFragment): CoalescerPushResult {
    const key = fragmentKey(fragment)
    if (this.disposed) {
      return { accepted: false, reason: 'channel_closed', key }
    }
    if (fragment.text.trim() === '' && fragment.images.length === 0) {
      return { accepted: false, reason: 'empty_message', key }
    }

    const now = this.now()
    let entry = this.pending.get(key)
    if (entry === undefined) {
      entry = {
        key,
        fragments: [],
        firstAt: now,
        lastAt: now,
        textChars: 0,
        imageCount: 0,
        declaredImageBytes: 0,
        overflowCode: null,
        timer: null,
      }
      this.pending.set(key, entry)
    }

    entry.fragments.push(fragment)
    entry.lastAt = now
    entry.textChars += Array.from(fragment.text).length
    entry.imageCount += fragment.images.length
    for (const image of fragment.images) {
      entry.declaredImageBytes += image.declaredBytes ?? 0
    }
    if (entry.overflowCode === null) {
      entry.overflowCode = overflowCode(entry, this.options)
    }
    this.schedule(entry)
    return { accepted: true, key }
  }

  hasPending(key: string): boolean {
    return this.pending.has(key)
  }

  pendingCount(): number {
    return this.pending.size
  }

  async flush(key: string): Promise<void> {
    const entry = this.pending.get(key)
    if (entry === undefined) return
    this.pending.delete(key)
    this.clearEntryTimer(entry)
    const result = this.buildResult(entry)
    try {
      await this.options.onResult(result)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.pending.values()) {
      this.clearEntryTimer(entry)
    }
    this.pending.clear()
  }

  private schedule(entry: PendingEntry): void {
    this.clearEntryTimer(entry)
    const now = this.now()
    const maxRemaining = entry.firstAt + this.options.maxWaitMs - now
    const delay = Math.max(0, Math.min(this.options.quietMs, maxRemaining))
    entry.timer = this.options.setTimer?.(() => {
      entry.timer = null
      if (this.pending.get(entry.key) !== entry) return
      const current = this.now()
      const quiet = current - entry.lastAt >= this.options.quietMs
      const maxed = current - entry.firstAt >= this.options.maxWaitMs
      if (quiet || maxed) {
        void this.flush(entry.key)
      } else {
        this.schedule(entry)
      }
    }, delay) ?? null
  }

  private clearEntryTimer(entry: PendingEntry): void {
    if (entry.timer === null) return
    this.options.clearTimer?.(entry.timer)
    entry.timer = null
  }

  private buildResult(entry: PendingEntry): CoalescerResult {
    const fragments = entry.fragments
    const messageIds = [...new Set(fragments.flatMap(item => item.messageIds))]
    const first = fragments[0]
    if (first === undefined) {
      return {
        ok: false,
        reason: 'empty_message',
        conversationKey: '',
        senderKey: '',
        targetKey: '',
        messageIds,
      }
    }
    if (entry.overflowCode !== null) {
      return {
        ok: false,
        reason: entry.overflowCode,
        conversationKey: first.conversationKey,
        senderKey: first.senderKey,
        targetKey: first.targetKey,
        messageIds,
      }
    }
    const text = fragments
      .map(item => item.text.trim())
      .filter(item => item !== '')
      .join('\n')
      .trim()
    const images = fragments.flatMap(item => item.images)
    if (text === '' && images.length === 0) {
      return {
        ok: false,
        reason: 'empty_message',
        conversationKey: first.conversationKey,
        senderKey: first.senderKey,
        targetKey: first.targetKey,
        messageIds,
      }
    }
    const turn: InboundTurn = {
      channel: 'qq',
      conversationKey: first.conversationKey,
      senderKey: first.senderKey,
      targetKey: first.targetKey,
      text,
      images,
      messageIds,
      receivedAt: new Date(entry.firstAt).toISOString(),
    }
    return { ok: true, turn }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

export function fragmentKey(fragment: InboundFragment): string {
  return `${fragment.conversationKey}\n${fragment.senderKey}`
}

function overflowCode(
  entry: PendingEntry,
  options: CoalescerOptions,
): string | null {
  if (entry.textChars > options.maxTextChars) return 'message_too_long'
  if (entry.imageCount > options.maxImages) return 'too_many_images'
  if (entry.declaredImageBytes > options.maxTotalImageBytes) {
    return 'images_too_large'
  }
  return null
}

function validateInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    )
  }
}
