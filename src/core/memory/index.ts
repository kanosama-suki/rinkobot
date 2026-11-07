/**
 * 长期记忆模块公开入口。
 */

export { KanobotMemoryService } from './service.ts'
export {
  DEFAULT_CANDIDATE_ARCHIVE_DAYS,
  DEFAULT_MEMORY_RECALL_SETTINGS,
  type MemoryRecallSettings,
  type MemoryServiceOptions,
} from './service.ts'
export {
  analyzeMemoryQuery,
  scoreMemoryRelevance,
  type MemoryQueryIntent,
  type MemoryQueryPlan,
  type MemoryQuerySubject,
  type MemoryRecallResult,
  type MemoryRelevance,
} from './recall.ts'
export {
  extractExplicitMemoryText,
  hasExplicitRememberInstruction,
} from './explicit.ts'
export {
  MEMORY_ARBITER_REASON_CODES,
  arbitrateExplicitMemoryText,
  arbitrateMemoryCandidates,
} from './arbiter.ts'
export type {
  ExplicitMemoryArbitration,
  MemoryArbiterAction,
  MemoryArbiterReasonCode,
  MemoryArbitrationItem,
  MemoryArbitrationResult,
  ReminderBoundaryCandidate,
} from './arbiter.ts'
export {
  guardMemorySensitivity,
  parseMemoryCandidate,
} from './candidate.ts'
export type { ParsedMemoryCandidate } from './candidate.ts'
export { MemoryInputError } from './types.ts'
export type {
  CorrectMemoryInput,
  MemoryExtractionSummary,
  MemoryRecallOptions,
  MemorySearchOptions,
  MemoryView,
  OwnerMemoryInput,
  RememberMemoryInput,
} from './types.ts'
