/**
 * 主数据库备份与恢复。
 *
 * 边界：
 * - 只备份主库，墓碑库始终独立保存；
 * - 备份用 VACUUM INTO 生成单文件副本，再用只读 quick_check 和 schema 检查；
 * - 恢复只替换主库文件，不碰墓碑库；之后由启动流程重放墓碑；
 * - 备份数量超过保留值时按创建时间删除最旧的文件。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  inspectDatabaseFile,
  quickCheckDatabase,
} from './database.ts'
import {
  StorageError,
  StorageIntegrityError,
} from './errors.ts'
import type { BackupRecord } from './types.ts'

const BACKUP_NAME = /^kanobot-backup-(\d{8})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([0-9a-f]{8})\.sqlite$/

export function createBackup(
  db: DatabaseSync,
  backupDir: string,
  retention: number,
  now: Date,
): BackupRecord {
  validateRetention(retention)
  if (Number.isNaN(now.getTime())) {
    throw new StorageError('BACKUP_FAILED', 'backup timestamp is invalid')
  }
  mkdirSync(backupDir, { recursive: true })
  const stamp = utcFileStamp(now)
  const path = join(
    backupDir,
    `kanobot-backup-${stamp}-${randomUUID().slice(0, 8)}.sqlite`,
  )
  // VACUUM INTO 要求目标不存在；随机后缀也避免同一毫秒内的测试互相覆盖。
  if (existsSync(path)) {
    throw new StorageError('BACKUP_FAILED', 'generated backup path already exists', {
      path,
    })
  }

  try {
    quickCheckDatabase(db, ':active-database:')
    db.prepare('VACUUM INTO ?').run(path)
    inspectDatabaseFile(path, 'main')
    pruneBackups(backupDir, retention)
  } catch (error) {
    try {
      rmSync(path, { force: true })
    } catch {
      // 失败副本清理失败时保留原始错误；下次列备份时会因校验失败暴露。
    }
    if (error instanceof StorageError) throw error
    throw new StorageError(
      'BACKUP_FAILED',
      `backup failed: ${errorMessage(error)}`,
      { cause: error, path },
    )
  }

  const bytes = statSync(path).size
  return {
    path,
    createdAt: parseBackupName(path)?.toISOString() ?? now.toISOString(),
    bytes,
  }
}

export function listBackups(backupDir: string): BackupRecord[] {
  if (!existsSync(backupDir)) return []
  const records: BackupRecord[] = []
  for (const name of readdirSync(backupDir)) {
    if (!BACKUP_NAME.test(name)) continue
    const path = join(backupDir, name)
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      const createdAt = parseBackupName(name)
      if (createdAt === null) continue
      records.push({ path, createdAt: createdAt.toISOString(), bytes: info.size })
    } catch (error) {
      // 扫描期间被删除的文件可以跳过；权限和磁盘错误必须显式暴露。
      if ((error as { code?: string }).code === 'ENOENT') continue
      throw new StorageError(
        'BACKUP_FAILED',
        `cannot inspect backup file: ${errorMessage(error)}`,
        { cause: error, path },
      )
    }
  }
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return records
}

export function pruneBackups(backupDir: string, retention: number): void {
  validateRetention(retention)
  const backups = listBackups(backupDir)
  for (const backup of backups.slice(retention)) {
    try {
      rmSync(backup.path, { force: true })
    } catch (error) {
      throw new StorageError(
        'BACKUP_FAILED',
        `cannot remove expired backup: ${errorMessage(error)}`,
        { cause: error, path: backup.path },
      )
    }
  }
}

export function hasBackupForLocalDay(
  backupDir: string,
  now: Date,
  timezone: string,
): boolean {
  const today = localDateKey(now, timezone)
  return listBackups(backupDir).some(
    backup => localDateKey(new Date(backup.createdAt), timezone) === today,
  )
}

export function localDateKey(date: Date, timezone: string): string {
  if (Number.isNaN(date.getTime())) {
    throw new StorageError('BACKUP_FAILED', 'cannot format an invalid date')
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = new Map(parts.map(part => [part.type, part.value]))
  const year = values.get('year')
  const month = values.get('month')
  const day = values.get('day')
  if (year === undefined || month === undefined || day === undefined) {
    throw new StorageError('BACKUP_FAILED', `cannot format date in ${timezone}`)
  }
  return `${year}-${month}-${day}`
}

/**
 * 把已验证备份原子替换到主库位置。
 *
 * 调用方必须先关闭正在使用的 KanobotStorage。墓碑库不在参数中，必须保留
 * 原文件并在下次打开时用于清理恢复出来的旧记录。
 */
export function restoreBackupToDatabase(
  backupPath: string,
  databasePath: string,
): void {
  if (!existsSync(backupPath)) {
    throw new StorageError('IO', 'backup file does not exist', { path: backupPath })
  }
  if (samePath(backupPath, databasePath)) {
    throw new StorageError('RESTORE_FAILED', 'backup and target database are the same file')
  }
  inspectDatabaseFile(backupPath, 'main')

  const parent = dirname(databasePath)
  mkdirSync(parent, { recursive: true })
  const suffix = randomUUID()
  const temporaryPath = `${databasePath}.restore-${suffix}.tmp`
  const rollbackPath = `${databasePath}.rollback-${suffix}`
  let movedOldDatabase = false

  try {
    copyFileSync(backupPath, temporaryPath)
    inspectDatabaseFile(temporaryPath, 'main')
    removeSidecars(databasePath)
    if (existsSync(databasePath)) {
      renameSync(databasePath, rollbackPath)
      movedOldDatabase = true
    }
    renameSync(temporaryPath, databasePath)
    inspectDatabaseFile(databasePath, 'main')
    if (movedOldDatabase) {
      rmSync(rollbackPath, { force: true })
    }
  } catch (error) {
    // 替换失败时尽量把旧库放回原位；若回滚也失败，错误信息保留两个路径。
    try {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
      if (movedOldDatabase && existsSync(rollbackPath) && !existsSync(databasePath)) {
        renameSync(rollbackPath, databasePath)
      }
    } catch (rollbackError) {
      throw new StorageError(
        'RESTORE_FAILED',
        `restore failed and rollback failed: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
        { cause: error, path: databasePath },
      )
    }
    if (error instanceof StorageIntegrityError) {
      throw new StorageError(
        'RESTORE_FAILED',
        `restored file failed verification: ${error.message}`,
        { cause: error, path: databasePath },
      )
    }
    if (error instanceof StorageError) throw error
    throw new StorageError(
      'RESTORE_FAILED',
      `restore failed: ${errorMessage(error)}`,
      { cause: error, path: databasePath },
    )
  }
}

function removeSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true })
  }
}

function validateRetention(retention: number): void {
  if (!Number.isInteger(retention) || retention < 1 || retention > 30) {
    throw new StorageError(
      'BACKUP_FAILED',
      'backup retention must be an integer between 1 and 30',
    )
  }
}

function parseBackupName(path: string): Date | null {
  const name = basename(path)
  const match = BACKUP_NAME.exec(name)
  if (match === null) return null
  const iso =
    `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}` +
    `T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function utcFileStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.', '')
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32'
      ? value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
      : value.replace(/\\/g, '/')
  return normalize(left) === normalize(right)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
