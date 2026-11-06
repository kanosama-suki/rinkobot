/**
 * 主动性与日常生活的领域契约。
 *
 * 边界：
 * - 模型只能给出计划、消息和摘要候选，是否保存/发送由确定性服务决定；
 * - 这里不包含任何真实人格、私人日程或正文；
 * - 所有时间进入持久化前都是规范 UTC ISO。
 */

import type { ChatMessageRecord } from '../storage/index.ts'
import type { LifeState } from '../state/index.ts'

export type DailyPlanKind =
  | 'reading'
  | 'movie'
  | 'simulation'
  | 'study'
  | 'resting'
  | 'walk'
  | 'music'

export interface DailyPlanItemDraft {
  kind: DailyPlanKind
  title: string
  durationMinutes: number
}

export interface DailyPlanDraft {
  schemaVersion: 1
  items: DailyPlanItemDraft[]
}

export interface ProactiveContext {
  now: string
  timezone: string
  state: LifeState
  recentMessages: readonly ChatMessageRecord[]
  plan: readonly DailyPlanViewItem[]
  lastDailySummary: string | null
  latestUserMessageAt: string | null
  silenceMinutes: number | null
  longSilence: boolean
  consecutiveUnanswered: number
  morningGreeting: boolean
  dueCare: readonly {
    id: string
    text: string
    dueUntil: string
  }[]
  styleViolations?: readonly string[]
}

export interface ProactiveDraft {
  schemaVersion: 1
  shouldSend: boolean
  message: string
  reasonCode: string
  careItemId: string | null
}

export interface DailyReviewFact {
  text: string
  messageIds: string[]
}

export interface DailyReviewMemoryDraft {
  text: string
  kind: string
  importance: 'normal' | 'important' | 'permanent'
  sensitivity: 'normal' | 'sensitive' | 'third_party'
  messageIds: string[]
}

export interface DailyReviewDraft {
  schemaVersion: 1
  summary: string
  facts: DailyReviewFact[]
  memories: DailyReviewMemoryDraft[]
}

export interface DailyReviewContext {
  localDay: string
  timezone: string
  messages: readonly ChatMessageRecord[]
  state: LifeState
}

export interface InitiativeBrain {
  planDay(input: {
    now: string
    timezone: string
    state: LifeState
    maxItems: number
    signal: AbortSignal
  }): Promise<DailyPlanDraft>
  composeProactive(
    input: ProactiveContext,
    signal: AbortSignal,
  ): Promise<ProactiveDraft>
  reviewDay(
    input: DailyReviewContext,
    signal: AbortSignal,
  ): Promise<DailyReviewDraft>
}

export interface DailyPlanViewItem {
  id: string
  localDay: string
  position: number
  kind: DailyPlanKind
  title: string
  startsAt: string
  endsAt: string
  status: 'planned' | 'active' | 'completed' | 'skipped'
}

export interface DailyPlanView {
  localDay: string
  createdAt: string
  items: DailyPlanViewItem[]
}

export interface ReminderView {
  id: string
  text: string
  dueAt: string
  status:
    | 'confirmed'
    | 'queued'
    | 'delivered'
    | 'cancelled'
    | 'failed'
  createdAt: string
  deliveredAt: string | null
}

export interface ReminderCandidateView {
  id: string
  text: string
  dueAt: string
  status: 'pending' | 'confirmed' | 'rejected'
  createdAt: string
  sourceMessageId: string
  confirmedReminderId: string | null
}

export interface CareItemView {
  id: string
  text: string
  dueFrom: string
  dueUntil: string
  status: 'pending' | 'queued' | 'delivered' | 'dismissed' | 'expired'
  createdAt: string
  deliveredAt: string | null
}

export interface DailySummaryView {
  localDay: string
  summary: string
  sourceMessageIds: string[]
  createdAt: string
}

export interface InitiativeRunView {
  id: string
  occurredAt: string
  kind:
    | 'tick'
    | 'daily_plan'
    | 'daily_review'
    | 'proactive'
    | 'reminder'
    | 'outbox'
    | 'circuit'
  outcome: 'allowed' | 'sent' | 'skipped' | 'failed'
  detailCode: string
  targetId: string | null
}

export interface InitiativeView {
  enabled: boolean
  quietNow: boolean
  lastTickAt: string | null
  nextProactiveAt: string | null
  lastProactiveAt: string | null
  consecutiveUnanswered: number
  circuit: {
    open: boolean
    openedAt: string | null
    recentMessageCount: number
  }
  plan: DailyPlanView | null
  reminderCandidates: ReminderCandidateView[]
  reminders: ReminderView[]
  careItems: CareItemView[]
  summaries: DailySummaryView[]
  latestRuns: InitiativeRunView[]
}

export interface InitiativeTickResult {
  status: 'completed' | 'stopped'
  deliveredOutbox: number
  proactiveSent: boolean
  planGenerated: boolean
  reviewCompleted: boolean
}

export interface InitiativeServiceLike {
  tick(signal: AbortSignal): Promise<InitiativeTickResult>
}

export class InitiativeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'InitiativeError'
    this.code = code
  }
}
