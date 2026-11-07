/**
 * 存储层公开记录类型。
 *
 * BodyRecord 是唯一允许保存正文的普通记录；MemoryRecord、事件、快照和
 * outbox 只保存 body ID。OutboxRecord 的状态机投递逻辑留到 M4。
 */

import type { LifeStateConfig } from '../config/types.ts'
import type {
  Clock,
  MemoryRecord,
  StateSnapshot,
  Tombstone,
} from '../state/index.ts'

export interface StorageOptions {
  dataDir: string
  databasePath: string
  tombstonePath: string
  backupDir: string
  timezone: string
  lifeState: LifeStateConfig
  trashRetentionDays: number
  snapshotEveryEvents: number
  snapshotIntervalHours: number
  backupRetention: number
  clock: Clock
}

export interface BodyRecord {
  id: string
  kind: string
  content: string
  createdAt: string
}

export type ChatRole = 'user' | 'assistant'

export interface ConversationRecord {
  id: string
  createdAt: string
  updatedAt: string
}

export interface ChatMessageRecord {
  id: string
  bodyId: string
  conversationId: string
  role: ChatRole
  text: string
  createdAt: string
}

export interface ChatMessageInput {
  conversationId: string
  role: ChatRole
  text: string
  id?: string
  createdAt?: string
}

export type ModelCallStatus = 'running' | 'succeeded' | 'failed' | 'aborted'
// memory_extraction 仅用于读取 M3.3 及更早的历史审计行；
// vision 是 M3.7 独立图片转述调用，不产生 assistant message。
export type ModelCallPurpose =
  | 'chat'
  | 'memory_extraction'
  | 'vision'
  | 'initiative'
  | 'daily_review'

export interface ModelUsageRecord {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface ModelPricingRecord {
  prompt: number | null
  completion: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/**
 * 一次用户请求对应的模型调用审计行。
 *
 * `attempts` 是网关内部实际发出的 HTTP 请求数；行本身按用户请求计一次，
 * 这样每日额度不会因为重试而被重复放大。正文永远不进入此表。
 */
export interface ModelCallRecord {
  id: string
  conversationId: string
  // 聊天/视觉调用锚定到触发它的用户消息；主动消息和每日整理没有当前
  // 用户消息，因此使用 null，而不是伪造一条聊天记录。
  userMessageId: string | null
  assistantMessageId: string | null
  purpose: ModelCallPurpose
  provider: string
  model: string
  startedAt: string
  completedAt: string | null
  localDay: string
  status: ModelCallStatus
  attempts: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  estimatedCost: number | null
  pricing: ModelPricingRecord | null
  responseId: string | null
  errorCode: string | null
}

export interface BeginModelCallInput {
  conversationId: string
  userMessageId?: string | null
  purpose?: ModelCallPurpose
  provider: string
  model: string
  id?: string
  startedAt?: string
}

export interface FinishModelCallInput {
  status: Exclude<ModelCallStatus, 'running'>
  completedAt?: string
  assistantMessageId?: string | null
  attempts: number
  usage?: ModelUsageRecord | null
  estimatedCost?: number | null
  pricing?: ModelPricingRecord | null
  responseId?: string | null
  errorCode?: string | null
}

export interface ReplyStyleCheckRecord {
  id: string
  assistantMessageId: string
  schemaVersion: 1
  ok: boolean
  violationCodes: string[]
  // 一次自动重写最多发生一次；初始违规代码单独保留，便于在最终回复
  // 通过检查后仍能审计第一版为什么被丢弃。
  retryCount: 0 | 1
  initialViolationCodes: string[]
  checkedAt: string
}

export interface PutReplyStyleCheckInput {
  assistantMessageId: string
  ok: boolean
  violationCodes: string[]
  retryCount?: 0 | 1
  initialViolationCodes?: string[]
  checkedAt?: string
  id?: string
}

/**
 * 统一审计使用的聊天回合摘要。
 *
 * 只包含消息/调用元数据，不读取 bodies，因此不会把正文或提示词带进
 * 审计接口。
 */
export interface ChatTurnAuditRecord {
  assistantMessageId: string
  conversationId: string
  createdAt: string
  modelCallCount: number
  succeededModelCallCount: number
  styleOk: boolean | null
  violationCodes: string[]
  retryCount: number | null
}

export type OwnerAuditAction =
  | 'memory.create'
  | 'memory.correct'
  | 'memory.promote'
  | 'memory.trash'
  | 'memory.restore'
  | 'memory.purge'
  | 'emergency.stop'
  | 'emergency.resume'

export type OwnerAuditTargetType = 'memory' | 'system'
export type OwnerAuditOutcome = 'succeeded' | 'failed'

export interface OwnerAuditRecord {
  id: string
  occurredAt: string
  action: OwnerAuditAction
  targetType: OwnerAuditTargetType
  targetId: string
  outcome: OwnerAuditOutcome
  detailCode: string | null
}

export interface RecordOwnerAuditInput {
  action: OwnerAuditAction
  targetType: OwnerAuditTargetType
  targetId: string
  outcome?: OwnerAuditOutcome
  detailCode?: string | null
  occurredAt?: string
  id?: string
}

export interface EmergencyStateRecord {
  stopped: boolean
  updatedAt: string
  reasonCode: string
}

export interface SetEmergencyStateInput {
  stopped: boolean
  reasonCode: string
  updatedAt?: string
}

export type OutboxStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired'

export type OutboxKind = 'proactive' | 'reminder' | 'system' | 'legacy'

export interface OutboxRecord {
  id: string
  target: string
  payloadRef: string
  kind: OutboxKind
  status: OutboxStatus
  dueAt: string | null
  createdAt: string
  updatedAt: string
  attempts: number
  maxAttempts: number
  lastErrorCode: string | null
  deliveredMessageId: string | null
}

export interface OutboxDeliveryResult {
  outbox: OutboxRecord
  message: ChatMessageRecord
}

export interface InitiativeStateRecord {
  lastTickAt: string | null
  nextProactiveAt: string | null
  lastProactiveAt: string | null
  consecutiveUnanswered: number
  circuitOpenedAt: string | null
  lastDailyPlanDay: string | null
  lastDailyReviewDay: string | null
  lastReviewAttemptDay: string | null
  dailyReviewAttempts: number
  lastTrashPurgeDay: string | null
  updatedAt: string
}

export interface UpdateInitiativeStateInput {
  lastTickAt?: string | null
  nextProactiveAt?: string | null
  lastProactiveAt?: string | null
  consecutiveUnanswered?: number
  circuitOpenedAt?: string | null
  lastDailyPlanDay?: string | null
  lastDailyReviewDay?: string | null
  lastReviewAttemptDay?: string | null
  dailyReviewAttempts?: number
  lastTrashPurgeDay?: string | null
  updatedAt?: string
}

export interface DailyPlanItemRecord {
  id: string
  localDay: string
  position: number
  kind: string
  titleRef: string
  startsAt: string
  endsAt: string
  status: 'planned' | 'active' | 'completed' | 'skipped'
  createdAt: string
}

export interface DailyPlanRecord {
  localDay: string
  createdAt: string
  items: DailyPlanItemRecord[]
}

export interface PutDailyPlanInput {
  localDay: string
  createdAt?: string
  items: Array<{
    id: string
    position: number
    kind: string
    title: string
    startsAt: string
    endsAt: string
  }>
}

export type ReminderStatus =
  | 'confirmed'
  | 'queued'
  | 'delivered'
  | 'cancelled'
  | 'failed'

export interface ReminderRecord {
  id: string
  bodyRef: string
  dueAt: string
  status: ReminderStatus
  createdAt: string
  confirmedAt: string
  deliveredAt: string | null
  outboxId: string | null
}

export interface PutReminderInput {
  id?: string
  text: string
  dueAt: string
  createdAt?: string
  confirmedAt?: string
}

export type ReminderCandidateStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'

export interface ReminderCandidateRecord {
  id: string
  bodyRef: string
  dueAt: string
  status: ReminderCandidateStatus
  createdAt: string
  sourceMessageId: string
  confirmedReminderId: string | null
}

export interface PutReminderCandidateInput {
  id?: string
  text: string
  dueAt: string
  sourceMessageId: string
  createdAt?: string
}

export interface ConfirmReminderCandidateResult {
  candidate: ReminderCandidateRecord
  reminder: ReminderRecord
}

export type CareItemStatus =
  | 'pending'
  | 'queued'
  | 'delivered'
  | 'dismissed'
  | 'expired'

export interface CareItemRecord {
  id: string
  sourceMessageId: string
  bodyRef: string
  dueFrom: string
  dueUntil: string
  status: CareItemStatus
  createdAt: string
  deliveredAt: string | null
  outboxId: string | null
}

export interface PutCareItemInput {
  id?: string
  text: string
  sourceMessageId: string
  dueFrom: string
  dueUntil: string
  createdAt?: string
}

export interface EnqueueOutboxInput {
  id?: string
  target: string
  kind: 'proactive' | 'reminder' | 'system'
  text: string
  dueAt?: string | null
  maxAttempts: number
  createdAt?: string
  careItemIds?: string[]
}

export interface DailySummaryRecord {
  id: string
  localDay: string
  bodyRef: string
  sourceRefs: string[]
  createdAt: string
}

export interface PutDailySummaryInput {
  localDay: string
  summary: string
  sourceMessageIds: string[]
  createdAt?: string
}

export interface InitiativeRunRecord {
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

export interface RecordInitiativeRunInput {
  kind: InitiativeRunRecord['kind']
  outcome: InitiativeRunRecord['outcome']
  detailCode: string
  targetId?: string | null
  occurredAt?: string
  id?: string
}

export interface AppendedEvent {
  sequence: number
  snapshot: SnapshotResult | null
}

export interface SnapshotResult {
  snapshot: StateSnapshot
  json: string
}

export interface PurgeTarget {
  targetType: Tombstone['targetType']
  targetId: string
}

export interface PurgeResult {
  target: PurgeTarget
  tombstones: Tombstone[]
  deletedBodies: number
  deletedMessages: number
  deletedMemories: number
  deletedOutbox: number
  rebuiltSnapshotSequence: number
}

export interface BackupRecord {
  path: string
  createdAt: string
  bytes: number
}

export interface MemoryListOptions {
  includeDeleted?: boolean
  onlyDeleted?: boolean
}

export type MemoryDecisionAction =
  | 'retained'
  | 'suppressed'
  | 'extracted'
  | 'archived'
  | 'restored'

export type MemoryDecisionSource =
  | 'chat_candidate'
  | 'explicit_fallback'
  | 'cooling'
  | 'owner'

/**
 * 记忆仲裁与冷却的脱敏审计记录。
 *
 * 只保存动作代码、对象 ID 和原因代码，永远不保存候选或用户原文。
 */
export interface MemoryDecisionRecord {
  id: string
  occurredAt: string
  action: MemoryDecisionAction
  reasonCode: string
  source: MemoryDecisionSource
  targetId: string | null
}

export interface RecordMemoryDecisionInput {
  action: MemoryDecisionAction
  reasonCode: string
  source: MemoryDecisionSource
  targetId?: string | null
  occurredAt?: string
  id?: string
}

export interface MemorySearchOptions {
  limit?: number
  markRecalled?: boolean
  matchMode?: 'all' | 'any'
}

export interface MemorySearchResult {
  memory: MemoryRecord
  text: string
  rank: number
}

export type StoredMemory = MemoryRecord
