/**
 * 启动本地开发网页。
 *
 * 默认只使用 mock 模型、config/examples 和 tmp/dev-data。真实路由必须
 * 显式 `--model-mode magpie`，且仍只监听 127.0.0.1。
 */

import { resolve } from 'node:path'

import { createDevServer } from '../src/dev/index.ts'
import type { ModelProviderMode } from '../src/model-providers/index.ts'

interface CliOptions {
  configDir?: string
  dataDir?: string
  modelMode: ModelProviderMode
  port: number
}

const options = parseArgs(process.argv.slice(2))
const server = await createDevServer({
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

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[kanobot-dev] ${signal}; closing…`)
  try {
    await server.close()
    process.exitCode = 0
  } catch (error) {
    console.error(`[kanobot-dev] close failed: ${formatError(error)}`)
    process.exitCode = 1
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})

function parseArgs(args: string[]): CliOptions {
  let configDir: string | undefined
  let dataDir: string | undefined
  let modelMode: ModelProviderMode = 'mock'
  let port = 4101

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
    if (arg === '--model-mode') {
      const value = requireValue(args, ++index, '--model-mode')
      if (value !== 'mock' && value !== 'magpie') {
        throw new Error('--model-mode 只能是 mock 或 magpie')
      }
      modelMode = value
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

  return {
    configDir: configDir === undefined ? undefined : resolve(configDir),
    dataDir: dataDir === undefined ? undefined : resolve(dataDir),
    modelMode,
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
      '用法: npm run dev -- [选项]',
      '',
      '  --config <目录>        配置目录，默认 config/examples',
      '  --data <目录>          数据目录，默认 tmp/dev-data',
      '  --model-mode <模式>    mock（默认）或 magpie',
      '  --port <端口>          默认 4101；0 表示随机端口',
      '  -h, --help             显示帮助',
    ].join('\n'),
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
