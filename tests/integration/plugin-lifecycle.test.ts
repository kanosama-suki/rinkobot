/**
 * 插件生命周期集成测试。
 *
 * 用最小的 fake context 模拟 Cordis 的 logger/effect，验证真实插件的
 * 启停、坏配置顺序、启动报告和定时器清理。
 */

import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply, PLUGIN_NAME, PLUGIN_VERSION } from '../../src/plugin/index.ts'

const examplesDir = fileURLToPath(new URL('../../config/examples', import.meta.url))

interface FakePluginContext {
  ctx: {
    logger: {
      info(message: string): void
    }
    effect(callback: () => () => void): () => void
    webServer: {
      register(): () => void
    }
    connection: {
      admit(): { peer: object }
    }
  }
  logs: string[]
  dispose(): void
}

function createFakeContext(): FakePluginContext {
  const logs: string[] = []
  const disposers: Array<() => void> = []
  let disposed = false

  // 按逆序执行 disposer，模拟宿主卸载插件时的资源释放方式。
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
      webServer: {
        register(): () => void {
          return () => {}
        },
      },
      connection: {
        admit(): { peer: object } {
          return { peer: {} }
        },
      },
    },
    logs,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const cleanup of disposers.reverse()) {
        cleanup()
      }
    },
  }
}

function timeoutCount(): number {
  // Node 的活动资源列表能区分定时器；测试只关心 Timeout 数量。
  return process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
}

test('the real plugin apply/dispose cycle leaves no timer behind', async () => {
  const baseline = timeoutCount()
  const dataDir = mkdtempSync(join(tmpdir(), 'kanobot-plugin-data-'))

  try {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const fake = createFakeContext()
      await apply(fake.ctx, {
        configDir: examplesDir,
        dataDir,
        heartbeatMs: 60_000,
      })

      assert.ok(
        fake.logs.some(
          line =>
            line.includes(PLUGIN_NAME) &&
            line.includes(PLUGIN_VERSION) &&
            line.includes('loaded'),
        ),
      )
      assert.ok(timeoutCount() >= baseline + 1)

      fake.dispose()
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.equal(timeoutCount(), baseline)
      assert.ok(fake.logs.some(line => line.includes('unloaded')))
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin configuration failures happen before a timer is registered', async () => {
  const baseline = timeoutCount()
  const fake = createFakeContext()

  await assert.rejects(
    () =>
      apply(fake.ctx, {
        configDir: `${examplesDir}-missing`,
        heartbeatMs: 60_000,
      }),
    /configuration directory does not exist/,
  )
  assert.equal(timeoutCount(), baseline)

  fake.dispose()
})

test('an explicit startup report proves successful activation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-startup-report-'))
  const reportPath = join(dir, 'startup.json')
  const dataDir = join(dir, 'data')
  const fake = createFakeContext()

  try {
    await apply(fake.ctx, {
      configDir: examplesDir,
      dataDir,
      heartbeatMs: 60_000,
      startupReportPath: reportPath,
    })
    fake.dispose()
  } finally {
    // 断言失败时也要清理定时器和临时目录，避免测试进程被挂住。
    fake.dispose()
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    assert.equal(report.plugin, PLUGIN_NAME)
    assert.equal(report.version, PLUGIN_VERSION)
    assert.equal(report.provider, 'mock')
    assert.equal(report.model, 'kanobot-mock-v1')
    assert.equal(report.configuredProvider, 'magpie')
    assert.equal(report.configuredModel, 'deepseek/deepseek-flash')
    assert.equal(report.contextMaxPromptChars, 20_000)
    assert.equal(report.timezone, 'Asia/Shanghai')
    assert.equal(report.identity, 'placeholder')
    assert.equal(report.database, join(dataDir, 'kanobot.sqlite'))
    assert.equal(report.tombstones, join(dataDir, 'tombstones.sqlite'))
    assert.equal(report.chatPath, '/kanobot/')
    assert.equal(report.modelMode, 'mock')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt existing database blocks plugin activation before a timer exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-corrupt-data-'))
  const databasePath = join(dir, 'kanobot.sqlite')
  const corrupt = Buffer.alloc(1024, 0x41)
  writeFileSync(databasePath, corrupt)
  const baseline = timeoutCount()
  const fake = createFakeContext()

  try {
    await assert.rejects(
      () =>
        apply(fake.ctx, {
          configDir: examplesDir,
          dataDir: dir,
          heartbeatMs: 60_000,
        }),
      /invalid SQLite file header/,
    )
    assert.equal(timeoutCount(), baseline)
    // fail-closed 的关键是原文件不被删除，更不能被自动换成空库。
    assert.deepEqual(readFileSync(databasePath), corrupt)
  } finally {
    fake.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
