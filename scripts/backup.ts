/**
 * 备份管理 CLI。
 *
 * 用法：
 *   node scripts/backup.ts --config <目录> --data <目录> list
 *   node scripts/backup.ts --config <目录> --data <目录> create
 *   node scripts/backup.ts --config <目录> --data <目录> restore --backup <文件>
 *
 * restore 要求服务已经停止，并通过数据目录 IPC 锁确认没有存活实例。
 * 输出为 JSON，便于脚本和验收记录使用；不打印 token、Cookie 或聊天正文。
 */

import { resolve } from 'node:path'

import {
  runBackupCommand,
  type BackupCommandName,
} from '../src/app/backup-command.ts'

interface CliOptions {
  configDir: string
  dataDir: string
  command: BackupCommandName
  backup?: string
}

try {
  const options = parseArgs(process.argv.slice(2))
  const result = await runBackupCommand(options)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`[kanobot-backup] ${formatError(error)}`)
  process.exitCode = 1
}

function parseArgs(args: string[]): CliOptions {
  let configDir = process.env.KANOBOT_CONFIG_DIR?.trim() || undefined
  let dataDir = process.env.KANOBOT_DATA_DIR?.trim() || undefined
  let command: BackupCommandName | undefined
  let backup: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--config') {
      configDir = requireValue(args, ++index, '--config')
      continue
    }
    if (arg === '--data') {
      dataDir = requireValue(args, ++index, '--data')
      continue
    }
    if (arg === '--backup') {
      backup = requireValue(args, ++index, '--backup')
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`未知参数 ${arg}`)
    }
    if (command !== undefined) {
      throw new Error(`只能指定一个命令，收到 ${command} 和 ${arg}`)
    }
    if (arg !== 'list' && arg !== 'create' && arg !== 'restore') {
      throw new Error(`未知命令 ${arg}；可用 list、create、restore`)
    }
    command = arg
  }

  if (configDir === undefined) {
    throw new Error('必须通过 --config 或 KANOBOT_CONFIG_DIR 提供配置目录')
  }
  if (dataDir === undefined) {
    throw new Error('必须通过 --data 或 KANOBOT_DATA_DIR 提供数据目录')
  }
  if (command === undefined) {
    throw new Error('缺少命令；可用 list、create、restore')
  }
  if (command === 'restore' && (backup === undefined || backup.trim() === '')) {
    throw new Error('restore 需要 --backup <绝对路径或备份文件名>')
  }
  return {
    configDir: resolve(configDir),
    dataDir: resolve(dataDir),
    command,
    backup,
  }
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} 缺少值`)
  }
  return value
}

function printHelp(): void {
  console.log(
    [
      '用法: npm run backup -- --config <目录> --data <目录> <命令> [选项]',
      '',
      '  list                          列出主库备份',
      '  create                        创建一份一致性主库备份',
      '  restore --backup <文件>       恢复主库；服务必须先停止',
      '',
      '  --config <目录>               正式配置目录（必需）',
      '  --data <目录>                 正式数据目录（必需）',
      '  --backup <文件>               绝对路径或备份目录中的文件名',
      '  -h, --help                    显示帮助',
      '',
      '也可用 KANOBOT_CONFIG_DIR 和 KANOBOT_DATA_DIR 提供目录。',
      'restore 只替换主库，不会覆盖独立 tombstones.sqlite。',
    ].join('\n'),
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
