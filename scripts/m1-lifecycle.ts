/**
 * M1 生命周期验收脚本。
 *
 * 使用真实插件的 apply/dispose 和最小 fake host context，重复 10 次，
 * 对比加载前后的活动资源，确认定时器没有泄漏。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, PLUGIN_NAME, PLUGIN_VERSION } from '../src/plugin/index.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const configDir = resolve(repoRoot, 'config', 'examples')
const outputIndex = process.argv.indexOf('--output')
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined

function createFakeContext(): {
  ctx: {
    logger: { info(message: string): void }
    effect(callback: () => () => void): () => void
  }
  logs: string[]
  dispose(): void
} {
  const logs: string[] = []
  const disposers: Array<() => void> = []
  let disposed = false
  // 只实现插件实际用到的 logger/effect，避免测试依赖完整 DSH 宿主。
  return {
    ctx: {
      logger: {
        info(message: string): void {
          logs.push(message)
        },
      },
      effect(callback: () => () => void): () => void {
        const cleanup = callback()
        disposers.push(cleanup)
        return cleanup
      },
    },
    logs,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const cleanup of disposers.reverse()) cleanup()
    },
  }
}

function resources(): string[] {
  // 排序后再比较，资源类型集合相同但顺序不同不应导致误报。
  return process.getActiveResourcesInfo().slice().sort()
}

function timeoutCount(values: readonly string[]): number {
  return values.filter(value => value === 'Timeout').length
}

async function main(): Promise<void> {
  const before = resources()
  let firstCycleDuring: string[] = []
  let logs: string[] = []

  for (let cycle = 0; cycle < 10; cycle += 1) {
    const fake = createFakeContext()
    apply(fake.ctx, { configDir, heartbeatMs: 60_000 })
    if (cycle === 0) firstCycleDuring = resources()
    fake.dispose()
    // 等一轮事件循环，让 clearInterval 后的资源句柄状态稳定下来。
    await new Promise<void>(resolveTick => setImmediate(resolveTick))
    if (cycle === 9) logs = fake.logs
  }

  await new Promise<void>(resolveTick => setImmediate(resolveTick))
  const after = resources()
  const ok =
    timeoutCount(firstCycleDuring) > timeoutCount(before) &&
    JSON.stringify(after) === JSON.stringify(before)
  const report = {
    ok,
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    cycles: 10,
    configDir,
    generatedAt: new Date().toISOString(),
    before,
    firstCycleDuring,
    after,
    logs,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(text)
  if (output !== undefined) {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, text, 'utf8')
  }
  if (!ok) process.exitCode = 1
}

await main()
