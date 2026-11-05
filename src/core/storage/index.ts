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
  resolveStorageLayout,
} from './paths.ts'
export {
  MAX_CHAT_MESSAGE_CHARS,
  MAX_MEMORY_TEXT_CHARS,
  normalizeChatText,
  normalizeMemoryText,
} from './records.ts'
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
  ChatRole,
  ConversationRecord,
  FinishModelCallInput,
  MemoryListOptions,
  MemorySearchOptions,
  MemorySearchResult,
  ModelCallRecord,
  ModelCallPurpose,
  ModelCallStatus,
  ModelPricingRecord,
  ModelUsageRecord,
  OutboxRecord,
  OutboxStatus,
  PurgeResult,
  PurgeTarget,
  SnapshotResult,
  StorageOptions,
} from './types.ts'
