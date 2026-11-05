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
  KanobotStorage,
  openStorageFromConfig,
  resolveConfiguredLayout,
} from './store.ts'
export type {
  AppendedEvent,
  BackupRecord,
  BodyRecord,
  MemoryListOptions,
  OutboxRecord,
  OutboxStatus,
  PurgeResult,
  PurgeTarget,
  SnapshotResult,
  StorageOptions,
} from './types.ts'
