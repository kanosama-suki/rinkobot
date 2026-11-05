/**
 * 状态模块公开接口。
 *
 * 存储和宿主适配层只从这里导入，不直接依赖 reducer 的内部辅助函数。
 */

export { canonicalJson, sha256Hex, snapshotCoreJson, snapshotJson } from './canonical.ts'
export {
  createManualClock,
  parseInstant,
  systemClock,
} from './clock.ts'
export type { Clock, ManualClock } from './clock.ts'
export {
  StateValidationError,
  validateAppraisal,
  validateLifeState,
  validateMemoryRecord,
  validatePolicyDecision,
  validateStateEvent,
  validateStateSnapshot,
  validateTombstone,
} from './events.ts'
export { createInitialState, reduceState } from './reducer.ts'
export {
  APPRAISAL_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
  POLICY_DECISION_SCHEMA_VERSION,
  STATE_EVENT_SCHEMA_VERSION,
  STATE_SNAPSHOT_SCHEMA_VERSION,
  TOMBSTONE_SCHEMA_VERSION,
} from './types.ts'
export type {
  Activity,
  ActivityChangedPayload,
  Appraisal,
  AppraisalRecordedPayload,
  Commitment,
  CommitmentCreatedPayload,
  CommitmentResolvedPayload,
  EventSource,
  Importance,
  InteractionRecordedPayload,
  LifeState,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
  PolicyDecision,
  RelationshipAdjustedPayload,
  Sensitivity,
  StateEvent,
  StateEventPayload,
  StateSnapshot,
  StoredEvent,
  TickPayload,
  Tombstone,
  TombstoneTargetType,
} from './types.ts'
