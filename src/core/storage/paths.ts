/**
 * 存储路径解析。
 *
 * 配置里的路径一律相对数据目录；这里解析成绝对路径并再次检查目录边界。
 * 数据库、墓碑库和备份目录必须位于数据目录内，避免配置把私人数据写到
 * 仓库或任意系统目录。
 */

import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'

import { StoragePathError } from './errors.ts'
import type { StorageOptions } from './types.ts'
import type { LifeStateConfig } from '../config/types.ts'
import type { Clock } from '../state/index.ts'

export interface StorageLayout {
  dataDir: string
  databasePath: string
  tombstonePath: string
  backupDir: string
}

export interface ConfigStorageInput {
  dataDir: string
  storage: {
    database: string
    tombstones: string
    backupDir: string
    snapshotEveryEvents: number
    snapshotIntervalHours: number
    backupRetention: number
  }
  timezone: string
  lifeState: LifeStateConfig
  trashRetentionDays: number
  clock: Clock
}

export function resolveStorageLayout(
  dataDir: string,
  storage: ConfigStorageInput['storage'],
): StorageLayout {
  if (dataDir.trim() === '') {
    throw new StoragePathError('dataDir must not be empty')
  }
  const requestedRoot = resolve(dataDir)
  try {
    mkdirSync(requestedRoot, { recursive: true })
  } catch (error) {
    throw new StoragePathError(
      `cannot create data directory: ${errorMessage(error)}`,
      requestedRoot,
    )
  }
  assertDirectory(requestedRoot, 'data directory')
  const root = realpathSync.native(requestedRoot)
  const databasePath = resolveDataPath(root, storage.database, 'storage.database')
  const tombstonePath = resolveDataPath(root, storage.tombstones, 'storage.tombstones')
  const backupDir = resolveDataPath(root, storage.backupDir, 'storage.backup_dir')

  if (databasePath === tombstonePath) {
    throw new StoragePathError(
      'main database and tombstone database must be different files',
      databasePath,
    )
  }
  if (backupDir === databasePath || backupDir === tombstonePath) {
    throw new StoragePathError(
      'backup directory must not be one of the database files',
      backupDir,
    )
  }
  return { dataDir: root, databasePath, tombstonePath, backupDir }
}

export function createStorageOptions(input: ConfigStorageInput): StorageOptions {
  const layout = resolveStorageLayout(input.dataDir, input.storage)
  return {
    ...layout,
    timezone: input.timezone,
    lifeState: input.lifeState,
    trashRetentionDays: input.trashRetentionDays,
    snapshotEveryEvents: input.storage.snapshotEveryEvents,
    snapshotIntervalHours: input.storage.snapshotIntervalHours,
    backupRetention: input.storage.backupRetention,
    clock: input.clock,
  }
}

export function resolveDataPath(
  root: string,
  configuredPath: string,
  field: string,
): string {
  if (
    configuredPath.trim() === '' ||
    configuredPath.includes('\0') ||
    isAbsolute(configuredPath) ||
    /^[A-Za-z]:[\\/]/.test(configuredPath)
  ) {
    throw new StoragePathError(`${field} must be a relative path`, configuredPath)
  }
  const target = resolve(root, configuredPath)
  const relation = relative(root, target)
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new StoragePathError(`${field} escapes the data directory`, target)
  }
  return target
}

function assertDirectory(path: string, label: string): void {
  try {
    const info = statSync(path)
    if (!info.isDirectory()) {
      throw new StoragePathError(`${label} is not a directory`, path)
    }
  } catch (error) {
    if (error instanceof StoragePathError) throw error
    throw new StoragePathError(
      `${label} is not accessible: ${errorMessage(error)}`,
      path,
    )
  }
}

export function assertRegularFileIfPresent(path: string, label: string): void {
  try {
    const info = lstatSync(path)
    if (!info.isFile()) {
      throw new StoragePathError(`${label} exists but is not a regular file`, path)
    }
  } catch (error) {
    if (error instanceof StoragePathError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new StoragePathError(
      `${label} is not accessible: ${errorMessage(error)}`,
      path,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
