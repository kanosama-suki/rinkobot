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
// memory_extraction 仅用于读取 M3.3 及更早的历史审计行。
export type ModelCallPurpose = 'chat' | 'memory_extraction'

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
  userMessageId: string
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
  userMessageId: string
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
  checkedAt: string
}

export interface PutReplyStyleCheckInput {
  assistantMessageId: string
  ok: boolean
  violationCodes: string[]
  checkedAt?: string
  id?: string
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

export type OutboxStatus = 'pending' | 'delivered' | 'failed' | 'cancelled'

export interface OutboxRecord {
  id: string
  target: string
  payloadRef: string
  status: OutboxStatus
  dueAt: string | null
  createdAt: string
  attempts: number
  lastErrorCode: string | null
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
