/**
 * 向本机运行中的独立程序申请一次性登录链接。
 *
 * 链接只打印到当前操作员终端，不写文件、不进入审计或 journal。命令需要
 * 与核心进程相同的操作系统用户读取数据目录下的 `kanobot.lock`。
 */

import { resolve } from 'node:path'

import { queryRuntimeControl } from '../src/app/runtime-lock.ts'

try {
  const dataDir = parseArgs(process.argv.slice(2))
  const response = await queryRuntimeControl(dataDir, {
    command: 'issue-login',
  })
  if (typeof response.url !== 'string' || response.url.trim() === '') {
    throw new Error('实例没有返回登录链接')
  }
  console.log(response.url)
} catch (error) {
  console.error(`[kanobot-login] ${formatError(error)}`)
  process.exitCode = 1
}

function parseArgs(args: string[]): string {
  let dataDir = process.env.KANOBOT_DATA_DIR?.trim() || undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--data') {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--data 缺少值')
      }
      dataDir = value
      continue
    }
    throw new Error(`未知参数 ${arg}`)
  }
  if (dataDir === undefined || dataDir.trim() === '') {
    throw new Error('必须通过 --data 或 KANOBOT_DATA_DIR 提供数据目录')
  }
  return resolve(dataDir)
}

function printHelp(): void {
  console.log(
    [
      '用法: npm run login -- --data <数据目录>',
      '',
      '向本机运行中的 Kanobot 实例申请一次性登录链接。',
      '链接只打印到当前终端；需要与实例相同的操作系统用户权限。',
    ].join('\n'),
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
