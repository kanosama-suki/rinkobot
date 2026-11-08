/**
 * 插件生命周期集成测试。
 *
 * 用最小的 fake context 模拟 Cordis 的 logger/effect/reflect，验证真实插件
 * 的启停、可选服务读取、坏配置顺序、启动报告和定时器清理。
 */

import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
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
import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import { KanobotStorage } from '../../src/core/storage/index.ts'
import { systemClock } from '../../src/core/state/index.ts'
import type { DshLlmBridge } from '../../src/model-providers/index.ts'
import type {
  DshPreparedCall,
  DshResolvedModelInfo,
} from '../../src/model-providers/dsh-types.ts'

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
    llm?: DshLlmBridge
  }
  logs: string[]
  dispose(): void
}

function createFakeContext(llm?: DshLlmBridge): FakePluginContext {
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
      reflect: {
        get(name: string): unknown {
          return name === 'llm' ? llm : undefined
        },
      },
      // Cordis 未 inject 的服务通过 ctx.llm 读取会抛错；这个 getter 让测试
      // 在插件绕过 reflect 直接读取时立即失败。
      get llm(): never {
        throw new Error('plugin must read optional services through ctx.reflect')
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
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let created = 0
  let cleared = 0

  // 调度器的 timer 会 unref，因此不会出现在 getActiveResourcesInfo() 里。
  // 监视 setInterval/clearInterval 才能验证插件确实创建并清理了唯一 timer。
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    created += 1
    return originalSetInterval(...args)
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    cleared += 1
    originalClearInterval(timer)
  }) as typeof clearInterval

  try {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const fake = createFakeContext()
      try {
        await apply(fake.ctx, {
          configDir: examplesDir,
          dataDir,
          heartbeatMs: 60_000,
          modelMode: 'mock',
        })

        assert.ok(
          fake.logs.some(
            line =>
              line.includes(PLUGIN_NAME) &&
              line.includes(PLUGIN_VERSION) &&
              line.includes('loaded'),
          ),
        )
        assert.equal(created, cycle + 1)
      } finally {
        // 断言失败时也必须先卸载插件，否则打开的数据库会掩盖真正的错误。
        fake.dispose()
        await new Promise<void>(resolve => setImmediate(resolve))
      }

      assert.equal(cleared, cycle + 1)
      assert.equal(timeoutCount(), baseline)
      assert.ok(fake.logs.some(line => line.includes('unloaded')))
    }
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
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
          modelMode: 'mock',
      }),
    /configuration directory does not exist/,
  )
  assert.equal(timeoutCount(), baseline)

  fake.dispose()
})

test('enabled vision rejects mock mode before opening storage or registering a timer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-vision-mock-'))
  const configDir = join(dir, 'config')
  const dataDir = join(dir, 'data')
  const baseline = timeoutCount()
  const fake = createFakeContext()

  try {
    cpSync(examplesDir, configDir, { recursive: true })
    const systemPath = join(configDir, 'system.toml')
    const system = readFileSync(systemPath, 'utf8').replace(
      'enabled = false',
      [
        'enabled = true',
        'provider = "magpie"',
        'name = "test/vision-model"',
        'base_url = "http://127.0.0.1:3425/v1"',
        'max_output_tokens = 2048',
      ].join('\n'),
    )
    writeFileSync(systemPath, system, 'utf8')

    await assert.rejects(
      () =>
        apply(fake.ctx, {
          configDir,
          dataDir,
          heartbeatMs: 60_000,
          modelMode: 'mock',
        }),
      /vision\.enabled requires a real model provider, not mock/,
    )
    assert.equal(timeoutCount(), baseline)
    // 视觉模式校验先于存储初始化，失败时不应生成数据目录或数据库。
    assert.equal(existsSync(dataDir), false)
  } finally {
    fake.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
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
      modelMode: 'mock',
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
    assert.equal(report.configuredModel, 'dsdsdsds/deepseek-flash')
    assert.equal(report.contextMaxPromptChars, 20_000)
    assert.equal(report.timezone, 'Asia/Shanghai')
    assert.equal(report.identity, 'placeholder')
    assert.equal(report.database, join(dataDir, 'kanobot.sqlite'))
    assert.equal(report.tombstones, join(dataDir, 'tombstones.sqlite'))
    assert.equal(report.chatPath, '/kanobot/')
    assert.equal(report.modelMode, 'mock')
    assert.equal(report.visionEnabled, false)
    assert.equal(report.visionProvider, null)
    assert.equal(report.visionModel, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin activation merges pre-existing owner QQ history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-plugin-owner-history-'))
  const configDir = join(dir, 'config')
  const dataDir = join(dir, 'data')
  const fake = createFakeContext()
  try {
    cpSync(examplesDir, configDir, { recursive: true })
    const store = KanobotStorage.openFromConfig(
      loadConfigFromDirectory(configDir),
      dataDir,
      systemClock,
    )
    try {
      store.appendChatMessage({
        conversationId: 'main',
        role: 'user',
        text: '插件启动前的主会话虚构消息。',
        id: 'plugin-main',
        createdAt: '2026-11-08T01:00:00.000Z',
      })
      store.appendChatMessage({
        conversationId: 'qq-private-10001',
        role: 'user',
        text: '插件启动前的所有者私聊虚构消息。',
        id: 'plugin-owner-private',
        createdAt: '2026-11-08T02:00:00.000Z',
      })
    } finally {
      store.close()
    }

    const channelsPath = join(configDir, 'channels.toml')
    const channels = readFileSync(channelsPath, 'utf8')
      .replace('private_allow = []', 'private_allow = ["10001"]')
      .replace(
        '# owner_qq = "123456789"',
        'owner_qq = "10001"',
      )
    writeFileSync(channelsPath, channels, 'utf8')

    await apply(fake.ctx, {
      configDir,
      dataDir,
      heartbeatMs: 60_000,
      modelMode: 'mock',
    })
  } finally {
    fake.dispose()
  }

  const reopened = KanobotStorage.openFromConfig(
    loadConfigFromDirectory(configDir),
    dataDir,
    systemClock,
  )
  try {
    assert.deepEqual(
      reopened.listChatMessages('main', 10).map(message => message.id),
      ['plugin-main', 'plugin-owner-private'],
    )
    assert.equal(reopened.getConversation('qq-private-10001'), null)
  } finally {
    reopened.close()
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
          modelMode: 'mock',
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

test('DSH provider fails before storage when reflect does not expose llm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-plugin-dsh-missing-'))
  const configDir = join(dir, 'config')
  const dataDir = join(dir, 'data')
  const baseline = timeoutCount()
  const fake = createFakeContext()

  try {
    configureDshChatModel(configDir)
    await assert.rejects(
      () =>
        apply(fake.ctx, {
          configDir,
          dataDir,
          heartbeatMs: 60_000,
        }),
      /host does not expose ctx\.llm/,
    )
    assert.equal(existsSync(dataDir), false)
    assert.equal(timeoutCount(), baseline)
  } finally {
    fake.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DSH provider receives the host bridge and reports the exact route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-plugin-dsh-'))
  const configDir = join(dir, 'config')
  const dataDir = join(dir, 'data')
  const reportPath = join(dir, 'startup.json')
  const fake = createFakeContext(createDshBridge())

  try {
    configureDshChatModel(configDir)
    await apply(fake.ctx, {
      configDir,
      dataDir,
      heartbeatMs: 60_000,
      startupReportPath: reportPath,
    })
  } finally {
    fake.dispose()
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      provider: string
      model: string
      modelMode: string
    }
    assert.equal(report.provider, 'test-route')
    assert.equal(report.model, 'test/chat-model')
    assert.equal(report.modelMode, 'dsh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a legacy modelMode magpie does not mask the configured provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-plugin-legacy-mode-'))
  const configDir = join(dir, 'config')
  const dataDir = join(dir, 'data')
  const reportPath = join(dir, 'startup.json')
  const fake = createFakeContext(createDshBridge())

  try {
    configureDshChatModel(configDir)
    await apply(fake.ctx, {
      configDir,
      dataDir,
      heartbeatMs: 60_000,
      modelMode: 'magpie',
      startupReportPath: reportPath,
    })
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      provider: string
      configuredProvider: string
      modelMode: string
    }
    assert.equal(report.provider, 'test-route')
    assert.equal(report.configuredProvider, 'dsh')
    assert.equal(report.modelMode, 'dsh')
  } finally {
    fake.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

function configureDshChatModel(configDir: string): void {
  cpSync(examplesDir, configDir, { recursive: true })
  const path = join(configDir, 'system.toml')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('[model]')
  const end = source.indexOf('[vision]')
  assert.ok(start >= 0 && end > start)
  const section = [
    '[model]',
    'provider = "dsh"',
    'route = "test-route"',
    'name = "test/chat-model"',
    'timeout_ms = 5000',
    'max_retries = 0',
    'max_output_tokens = 4096',
    '',
  ].join('\n')
  writeFileSync(
    path,
    `${source.slice(0, start)}${section}\n${source.slice(end)}`,
    'utf8',
  )
}

function createDshBridge(): DshLlmBridge {
  const info: DshResolvedModelInfo = {
    provider: 'test-route',
    id: 'test/chat-model',
    name: 'Test Chat Model',
    inputModalities: ['text'],
  }
  return {
    listProviders() {
      return [{ id: info.provider, name: 'Test Route' }]
    },
    async listModels() {
      return [info]
    },
    async resolveModelInfo() {
      return info
    },
    async prepareCall() {
      const prepared: DshPreparedCall = {
        model: info,
        async *stream() {
          throw new Error('startup test must not dispatch model calls')
        },
      }
      return prepared
    },
    async *stream() {
      throw new Error('startup test must not dispatch model calls')
    },
  }
}
