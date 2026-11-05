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

export type StoredMemory = MemoryRecord
