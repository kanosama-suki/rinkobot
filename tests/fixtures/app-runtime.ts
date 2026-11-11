/**
 * R1 生命周期子进程夹具。
 *
 * 启动正式 createAppServer，并通过 stdout 的 READY 行报告端口。父测试
 * 可以发送 SIGTERM/SIGKILL；Windows 不提供 POSIX SIGTERM 投递，因此
 * 额外支持从 stdin 触发与 SIGTERM 处理器完全相同的路径。
 */

import { resolve } from 'node:path'

import { createAppServer } from '../../src/app/index.ts'

const [configArg, dataArg, portArg] = process.argv.slice(2)
if (configArg === undefined || dataArg === undefined) {
  console.error('[fixture] config and data directories are required')
  process.exit(1)
}

const server = await createAppServer({
  configDir: resolve(configArg),
  dataDir: resolve(dataArg),
  port: portArg === undefined ? 0 : Number(portArg),
  logger: {
    info(message: string): void {
      console.log(`LOG ${message}`)
    },
    error(message: string): void {
      console.error(`ERR ${message}`)
    },
  },
})

console.log(`READY ${JSON.stringify({
  pid: process.pid,
  port: server.port,
  baseUrl: server.baseUrl,
  bootstrapUrl: server.bootstrapUrl,
})}`)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`CLOSING ${signal}`)
  try {
    await server.close()
    console.log('CLOSED')
    process.stdin.destroy()
    process.exitCode = 0
    setImmediate(() => process.exit(0))
  } catch (error) {
    console.error(
      `[fixture] close failed: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    process.exitCode = 1
    setImmediate(() => process.exit(1))
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})

process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', chunk => {
  input += chunk
  let newline = input.indexOf('\n')
  while (newline >= 0) {
    const command = input.slice(0, newline).trim()
    input = input.slice(newline + 1)
    if (command === 'sigterm') {
      process.emit('SIGTERM', 'SIGTERM')
    } else if (command === 'sigint') {
      process.emit('SIGINT', 'SIGINT')
    } else if (command === 'close') {
      void shutdown('stdin-close')
    }
    newline = input.indexOf('\n')
  }
})
