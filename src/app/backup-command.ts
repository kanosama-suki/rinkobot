/**
 * 可执行备份管理命令的共享实现。
 *
 * 边界：
 * - list/create 只读取主库，不启动核心、不打开墓碑写入路径；
 * - create 复用 `createBackup` 的 VACUUM INTO + quick_check 流程；
 * - restore 必须先取得数据目录 IPC 锁，存活实例存在时 fail-closed；
 * - restore 只替换主库，不触碰 tombstones.sqlite；旧 schema 备份拒绝恢复。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { loadConfigFromDirectory } from '../core/config/index.ts'
import {
  createBackup,
  inspectDatabaseFile,
  listBackups,
  resolveStorageLayout,
  restoreBackupToDatabase,
} from '../core/storage/index.ts'
import type { BackupRecord } from '../core/storage/index.ts'
import { KANOBOT_VERSION } from '../version.ts'
import { acquireRuntimeLock } from './runtime-lock.ts'

export type BackupCommandName = 'list' | 'create' | 'restore'

export interface BackupCommandOptions {
  configDir: string
  dataDir: string
  command: BackupCommandName
  /** create 使用当前时间；测试可注入固定时间。 */
  now?: Date
  /** restore 必填：绝对路径或备份目录中的文件名。 */
  backup?: string
}

export interface BackupCommandResult {
  command: BackupCommandName
  backups?: BackupRecord[]
  backup?: BackupRecord
  restoredBackupPath?: string
}

export async function runBackupCommand(
  options: BackupCommandOptions,
): Promise<BackupCommandResult> {
  const configDir = requireDirectoryOption(options.configDir, 'configDir')
  const dataDir = requireDirectoryOption(options.dataDir, 'dataDir')
  if (configDir === dataDir) {
    throw new Error('configDir and dataDir must be different directories')
  }
  const loaded = loadConfigFromDirectory(configDir)
  const layout = resolveStorageLayout(dataDir, loaded.system.storage)

  if (options.command === 'list') {
    return {
      command: 'list',
      backups: listBackups(layout.backupDir),
    }
  }

  if (!existsSync(layout.tombstonePath)) {
    throw new Error(
      '独立墓碑库不存在；为避免产生无法启动的数据目录，拒绝继续。',
    )
  }
  inspectDatabaseFile(layout.tombstonePath, 'tombstones')

  if (options.command === 'create') {
    if (!existsSync(layout.databasePath)) {
      throw new Error('主库不存在；请先启动一次独立程序再创建备份。')
    }
    const db = new DatabaseSync(layout.databasePath, { readOnly: true })
    try {
      const backup = createBackup(
        db,
        layout.backupDir,
        loaded.system.storage.backupRetention,
        options.now ?? new Date(),
      )
      return { command: 'create', backup }
    } finally {
      db.close()
    }
  }

  if (typeof options.backup !== 'string' || options.backup.trim() === '') {
    throw new Error('restore 需要 --backup <绝对路径或备份文件名>')
  }

  const lock = await acquireRuntimeLock(layout.dataDir, {
    version: KANOBOT_VERSION,
  })
  try {
    const backupPath = resolveBackupPath(layout.backupDir, options.backup)
    restoreBackupToDatabase(backupPath, layout.databasePath, {
      requireCurrentSchema: true,
    })
    return {
      command: 'restore',
      restoredBackupPath: backupPath,
    }
  } finally {
    await lock.release()
  }
}

function resolveBackupPath(backupDir: string, requested: string): string {
  const candidate = isAbsolute(requested)
    ? resolve(requested)
    : join(backupDir, requested)
  if (!existsSync(candidate)) {
    throw new Error(`备份文件不存在：${candidate}`)
  }
  return candidate
}

function requireDirectoryOption(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be provided explicitly`)
  }
  return resolve(value)
}
