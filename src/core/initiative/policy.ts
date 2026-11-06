/**
 * 主动消息的确定性闸门与 outbox 状态转换。
 *
 * 边界：这里是纯函数，不读时钟、不发网络请求、不生成文案。模型或测试
 * 都必须通过同一组规则，避免“人格提示词写得很安全但运行时没有门”。
 */

import type { InitiativeConfig } from '../config/types.ts'
import type { LifeState } from '../state/index.ts'
import type { OutboxStatus } from '../storage/index.ts'
import { quietEndsAtOrAfter } from './time.ts'

export type ProactiveGateReason =
  | 'disabled'
  | 'circuit_open'
  | 'quiet_hours'
  | 'recent_chat'
  | 'busy'
  | 'not_due'

export interface ProactiveGateInput {
  config: InitiativeConfig['proactive']
  now: Date
  timezone: string
  quietStart: string
  quietEnd: string
  nextProactiveAt: string | null
  lastChatMessageAt: string | null
  state: LifeState
  circuitOpenedAt: string | null
}

export interface ProactiveGateDecision {
  allowed: boolean
  reason: ProactiveGateReason | null
  retryAt: string | null
}

export function evaluateProactiveGate(
  input: ProactiveGateInput,
): ProactiveGateDecision {
  if (!input.config.enabled) {
    return denied('disabled', null)
  }
  if (input.circuitOpenedAt !== null) {
    return denied('circuit_open', null)
  }
  const quietEnd = quietEndsAtOrAfter(
    input.now,
    input.timezone,
    input.quietStart,
    input.quietEnd,
  )
  if (quietEnd.getTime() > input.now.getTime()) {
    return denied('quiet_hours', quietEnd.toISOString())
  }
  if (
    input.lastChatMessageAt !== null &&
    input.now.getTime() - Date.parse(input.lastChatMessageAt) <
      input.config.chatCooldownMinutes * 60_000
  ) {
    return denied(
      'recent_chat',
      new Date(
        Date.parse(input.lastChatMessageAt) +
          input.config.chatCooldownMinutes * 60_000,
      ).toISOString(),
    )
  }
  if (
    input.state.attention.busyUntil !== null &&
    Date.parse(input.state.attention.busyUntil) > input.now.getTime()
  ) {
    return denied('busy', input.state.attention.busyUntil)
  }
  if (
    input.nextProactiveAt !== null &&
    Date.parse(input.nextProactiveAt) > input.now.getTime()
  ) {
    return denied('not_due', input.nextProactiveAt)
  }
  return { allowed: true, reason: null, retryAt: null }
}

export function nextProactiveIntervalMs(
  config: InitiativeConfig['proactive'],
  random: () => number,
  consecutiveUnanswered: number,
): number {
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('random must return a value in [0, 1)')
  }
  const baseMinutes =
    config.minIntervalMinutes +
    (config.maxIntervalMinutes - config.minIntervalMinutes) * sample
  const slowdown =
    1 +
    Math.max(0, consecutiveUnanswered) *
      config.unansweredSlowdownMultiplier
  return Math.round(
    Math.min(baseMinutes * slowdown, 24 * 60) * 60_000,
  )
}

const OUTBOX_TRANSITIONS: Record<
  OutboxStatus,
  readonly OutboxStatus[]
> = {
  pending: ['sending', 'delivered', 'cancelled', 'expired', 'failed'],
  sending: ['delivered', 'failed', 'unknown'],
  delivered: [],
  failed: ['pending', 'cancelled'],
  unknown: ['delivered', 'failed', 'cancelled'],
  cancelled: [],
  expired: [],
}

export function canTransitionOutbox(
  from: OutboxStatus,
  to: OutboxStatus,
): boolean {
  return OUTBOX_TRANSITIONS[from].includes(to)
}

function denied(
  reason: ProactiveGateReason,
  retryAt: string | null,
): ProactiveGateDecision {
  return { allowed: false, reason, retryAt }
}
