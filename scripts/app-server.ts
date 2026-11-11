/**
 * 启动正式独立程序。
 *
 * 配置目录和数据目录必须显式提供（参数或环境变量），不会回退到
 * config/examples 或 tmp。程序只监听 127.0.0.1，并要求一次性登录链接。
 */

import { resolve } from 'node:path'

import {
  createAppServer,
  type AppServer,
} from '../src/app/index.ts'

interface CliOptions {
  configDir: string
  dataDir: string
  port: number
}

let options: CliOptions
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`[rinkobot-app] ${formatError(error)}`)
  console.error('使用 --help 查看启动参数。')
  process.exitCode = 1
  throw error
}

let server: AppServer | undefined
let shuttingDown = false
let pendingSignal: string | null = null

async function closeAndExit(): Promise<void> {
  const activeServer = server
  if (activeServer === undefined) return
  try {
    await activeServer.close()
    console.log('[rinkobot-app] shutdown complete; runtime lock released')
    process.exitCode = 0
  } catch (error) {
    console.error(`[rinkobot-app] close failed: ${formatError(error)}`)
    process.exitCode = 1
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[rinkobot-app] ${signal}; closing…`)
  if (server === undefined) {
    pendingSignal = signal
    console.log(
      '[rinkobot-app] startup still in progress; shutdown queued until ' +
        'initialization finishes.',
    )
    return
  }
  await closeAndExit()
}

let signalCount = 0
function handleSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  signalCount += 1
  if (signalCount > 1) {
    console.error(
      `[rinkobot-app] second ${signal}; forcing immediate exit. ` +
        'A stale lock will be recovered by the next startup.',
    )
    process.exit(1)
  }
  void shutdown(signal)
}

process.on('SIGINT', () => handleSignal('SIGINT'))
process.on('SIGTERM', () => handleSignal('SIGTERM'))

try {
  server = await createAppServer({
    ...options,
    logger: {
      info(message: string): void {
        console.log(message)
      },
      error(message: string): void {
        console.error(message)
      },
    },
  })
} catch (error) {
  console.error(`[rinkobot-app] startup failed: ${formatError(error)}`)
  process.exit(1)
}

if (pendingSignal !== null) {
  console.log(
    `[rinkobot-app] startup complete; continuing queued ${pendingSignal} ` +
      'shutdown.',
  )
  await closeAndExit()
}

function parseArgs(args: string[]): CliOptions {
  let configDir =
    process.env.KANOBOT_CONFIG_DIR?.trim() || undefined
  let dataDir =
    process.env.KANOBOT_DATA_DIR?.trim() || undefined
  let port = 4200

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
    if (arg === '--port') {
      const value = requireValue(args, ++index, '--port')
      if (!/^\d+$/.test(value)) {
        throw new Error('--port 必须是 0 到 65535 的整数')
      }
      port = Number(value)
      continue
    }
    throw new Error(`未知参数 ${arg}`)
  }

  if (configDir === undefined) {
    throw new Error(
      '必须通过 --config 或 KANOBOT_CONFIG_DIR 提供配置目录',
    )
  }
  if (dataDir === undefined) {
    throw new Error(
      '必须通过 --data 或 KANOBOT_DATA_DIR 提供数据目录',
    )
  }
  return {
    configDir: resolve(configDir),
    dataDir: resolve(dataDir),
    port,
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
      '用法: npm run app -- --config <目录> --data <目录> [选项]',
      '',
      '  --config <目录>        正式配置目录（必需）',
      '  --data <目录>          正式数据目录（必需）',
      '  --port <端口>          默认 4200；0 表示随机端口',
      '  -h, --help             显示帮助',
      '',
      '也可用 KANOBOT_CONFIG_DIR 和 KANOBOT_DATA_DIR 提供目录。',
      '首次启动后使用终端打印的一次性登录地址进入。',
    ].join('\n'),
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
