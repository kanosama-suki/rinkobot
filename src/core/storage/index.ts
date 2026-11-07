/**
 * M2 存储模块公开接口。
 *
 * 宿主和核心模块只从这里导入；数据库实现细节、SQL 和路径拼接不对外。
 */

export {
  createBackup,
  hasBackupForLocalDay,
  listBackups,
  localDateKey,
  pruneBackups,
  restoreBackupToDatabase,
} from './backup.ts'
export {
  STORAGE_SCHEMA_VERSION,
  TOMBSTONE_STORE_SCHEMA_VERSION,
  inspectDatabaseFile,
  openMainDatabase,
  openTombstoneDatabase,
  quickCheckDatabase,
} from './database.ts'
export {
  SchemaCompatibilityError,
  StorageError,
  StorageIntegrityError,
  StoragePathError,
} from './errors.ts'
export {
  createStorageOptions,
  resolveDataPath,
  resolveStorageLayout,
} from './paths.ts'
export {
  MAX_CHAT_MESSAGE_CHARS,
  MAX_MEMORY_TEXT_CHARS,
  normalizeChatText,
  normalizeMemoryText,
} from './records.ts'
export {
  listMemorySearchTokens,
} from './memory-search.ts'
export {
  KanobotStorage,
  openStorageFromConfig,
  resolveConfiguredLayout,
} from './store.ts'
export type {
  AppendedEvent,
  BackupRecord,
  BeginModelCallInput,
  BodyRecord,
  ChatMessageInput,
  ChatMessageRecord,
  ChatTurnAuditRecord,
  ChatRole,
  CareItemRecord,
  CareItemStatus,
  ConfirmReminderCandidateResult,
  ConversationRecord,
  DailyPlanItemRecord,
  DailyPlanRecord,
  DailySummaryRecord,
  EmergencyStateRecord,
  EnqueueOutboxInput,
  FinishModelCallInput,
  InitiativeRunRecord,
  InitiativeStateRecord,
  MemoryListOptions,
  MemoryDecisionAction,
  MemoryDecisionRecord,
  MemoryDecisionSource,
  MemorySearchOptions,
  MemorySearchResult,
  ModelCallRecord,
  ModelCallPurpose,
  ModelCallStatus,
  ModelPricingRecord,
  ModelUsageRecord,
  OutboxDeliveryResult,
  OutboxKind,
  OutboxRecord,
  OutboxStatus,
  OwnerAuditAction,
  OwnerAuditOutcome,
  OwnerAuditRecord,
  OwnerAuditTargetType,
  PurgeResult,
  PurgeTarget,
  PutCareItemInput,
  PutDailyPlanInput,
  PutDailySummaryInput,
  PutReplyStyleCheckInput,
  PutReminderCandidateInput,
  PutReminderInput,
  RecordInitiativeRunInput,
  RecordMemoryDecisionInput,
  RecordOwnerAuditInput,
  ReminderCandidateRecord,
  ReminderCandidateStatus,
  ReminderRecord,
  ReminderStatus,
  ReplyStyleCheckRecord,
  SetEmergencyStateInput,
  SnapshotResult,
  StorageOptions,
  UpdateInitiativeStateInput,
} from './types.ts'
