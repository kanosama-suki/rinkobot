/**
 * 事件、状态、快照和记忆的版本化数据契约。
 *
 * 边界：
 * - 事件与快照不内嵌聊天正文，只保存正文 ID；
 * - 所有时间字段使用带毫秒的 UTC ISO 字符串；
 * - 模型判断和确定性事件都显式携带来源与置信度。
 */

export const STATE_EVENT_SCHEMA_VERSION = 1
export const STATE_SNAPSHOT_SCHEMA_VERSION = 1
export const APPRAISAL_SCHEMA_VERSION = 1
export const POLICY_DECISION_SCHEMA_VERSION = 1
export const MEMORY_SCHEMA_VERSION = 2
export const TOMBSTONE_SCHEMA_VERSION = 1

export type EventSource =
  | 'user'
  | 'rinko'
  | 'system'
  | 'owner'
  | 'tick'
  | 'browser'

export type Activity =
  | 'idle'
  | 'talking'
  | 'reading'
  | 'resting'
  | 'away'
  | 'busy'

export interface Appraisal {
  schemaVersion: 1
  valence: number
  arousal: number
  confidence: number
  summaryRef?: string
  evidenceRefs: string[]
}

export interface PolicyDecision {
  schemaVersion: 1
  allowed: boolean
  reasonCode: string
  constraints: {
    maxReplyChars?: number
    deferUntil?: string
  }
  decidedAt: string
}

export interface Commitment {
  id: string
  descriptionRef: string
  dueAt: string | null
  status: 'open' | 'completed' | 'cancelled'
}

export interface LifeState {
  activity: Activity
  affect: {
    valence: number
    arousal: number
  }
  energy: number
  socialBattery: number
  relationship: {
    closeness: number
    hurt: number
    repairNeeded: boolean
  }
  attention: {
    busyUntil: string | null
  }
  commitments: Commitment[]
}

export interface TickPayload {
  elapsedMinutes: number
  awake: boolean
}

export interface ActivityChangedPayload {
  activity: Activity
  busyUntil: string | null
}

export interface AppraisalRecordedPayload {
  appraisal: Appraisal
}

export interface InteractionRecordedPayload {
  kind: 'conversation' | 'conflict' | 'apology' | 'shared_experience'
  intensity: number
}

export interface RelationshipAdjustedPayload {
  closenessDelta: number
  hurtDelta: number
}

export interface CommitmentCreatedPayload {
  commitmentId: string
  descriptionRef: string
  dueAt: string | null
}

export interface CommitmentResolvedPayload {
  commitmentId: string
  status: 'completed' | 'cancelled'
}

interface StateEventBase<Type extends string, Payload> {
  eventId: string
  schemaVersion: 1
  occurredAt: string
  source: EventSource
  type: Type
  payload: Payload
  evidenceRefs: string[]
  confidence: number
}

export type StateEvent =
  | StateEventBase<'tick', TickPayload>
  | StateEventBase<'activity.changed', ActivityChangedPayload>
  | StateEventBase<'appraisal.recorded', AppraisalRecordedPayload>
  | StateEventBase<'interaction.recorded', InteractionRecordedPayload>
  | StateEventBase<'relationship.adjusted', RelationshipAdjustedPayload>
  | StateEventBase<'commitment.created', CommitmentCreatedPayload>
  | StateEventBase<'commitment.resolved', CommitmentResolvedPayload>

export type StateEventPayload =
  | TickPayload
  | ActivityChangedPayload
  | AppraisalRecordedPayload
  | InteractionRecordedPayload
  | RelationshipAdjustedPayload
  | CommitmentCreatedPayload
  | CommitmentResolvedPayload

export interface StateSnapshot {
  schemaVersion: 1
  state: LifeState
  lastSequence: number
  lastEventId: string | null
  generatedAt: string
  stateHash: string
}

export type MemorySource = 'user_stated' | 'rinko_inferred' | 'external'
export type Sensitivity = 'normal' | 'sensitive' | 'third_party'
export type Importance = 'normal' | 'important' | 'permanent'
export type MemoryStatus =
  | 'candidate'
  | 'active'
  | 'archived'
  | 'replaced'
  | 'deleted'

export interface MemoryRecord {
  schemaVersion: 2
  id: string
  kind: string
  contentRef: string
  quoteRef: string | null
  source: MemorySource
  createdAt: string
  confidence: number
  sensitivity: Sensitivity
  importance: Importance
  /**
   * 由确定性指令或所有者操作确认，不是模型自报。
   * 冷却归档必须跳过这些记录。
   */
  explicitlyRequested: boolean
  lastRecalledAt: string | null
  status: MemoryStatus
  replacedBy: string | null
  // 软删除时填写；永久墓碑由独立的 Tombstone 记录，不写在这里。
  deletedAt: string | null
  purgeAfter: string | null
}

export type TombstoneTargetType = 'body' | 'memory' | 'outbox' | 'event'

export interface Tombstone {
  schemaVersion: 1
  targetType: TombstoneTargetType
  targetId: string
  purgedAt: string
}

export interface StoredEvent {
  sequence: number
  event: StateEvent
}
