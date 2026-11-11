/**
 * 正式独立程序的生命周期验收。
 *
 * 覆盖：同数据目录第二实例拒绝、优雅关闭释放锁并可重启、SIGKILL 后
 * 锁元数据恢复、数据库可重新打开。Windows 上使用与 SIGTERM 处理器
 * 相同的 stdin 触发路径；Linux/POSIX 上发送真实 SIGTERM。
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAppServer } from '../../src/app/index.ts'
import {
  readRuntimeLock,
  runtimeLockPath,
} from '../../src/app/runtime-lock.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

test('a second standalone instance is rejected while the first stays healthy', async t => {
  const layout = createLayout(t)
  configureMockModel(layout.configDir)
  const first = await startChild(layout, t)
  try {
    await assert.rejects(
      () =>
        createAppServer({
          configDir: layout.configDir,
          dataDir: layout.dataDir,
          port: 0,
          logger: { info(): void {}, error(): void {} },
        }),
      /已被另一个 Kanobot 实例占用/,
    )
    const health = await fetch(`${first.ready.baseUrl}/kanobot/api/health`)
    assert.equal(health.status, 200)

    const second = await runCli([
      '--config',
      layout.configDir,
      '--data',
      layout.dataDir,
      '--port',
      '0',
    ])
    assert.equal(second.code, 1)
    assert.match(second.stderr, /已被另一个 Kanobot 实例占用/)
    assert.equal(
      (await fetch(`${first.ready.baseUrl}/kanobot/api/health`)).status,
      200,
    )
  } finally {
    await first.stop('sigterm')
  }
})

test('graceful SIGINT/SIGTERM shutdown releases the lock and allows restart', async t => {
  const shutdowns: Array<{
    mode: ShutdownMode
    label: string
  }> = process.platform === 'win32'
    ? [
        { mode: 'sigterm', label: 'stdin SIGTERM path' },
        { mode: 'sigint', label: 'stdin SIGINT path' },
      ]
    : [
        { mode: 'signal-term', label: 'POSIX SIGTERM' },
        { mode: 'signal-int', label: 'POSIX SIGINT' },
      ]

  for (const shutdown of shutdowns) {
    const layout = createLayout(t)
    configureMockModel(layout.configDir)
    const first = await startChild(layout, t)
    assert.equal(existsSync(runtimeLockPath(layout.dataDir)), true)

    const exit = await first.stop(shutdown.mode)
    assert.equal(exit.code, 0, shutdown.label)
    assert.equal(existsSync(runtimeLockPath(layout.dataDir)), false)

    const second = await createAppServer({
      configDir: layout.configDir,
      dataDir: layout.dataDir,
      port: 0,
      logger: { info(): void {}, error(): void {} },
    })
    try {
      const health = await fetch(`${second.baseUrl}/kanobot/api/health`)
      assert.equal(health.status, 200)
    } finally {
      await second.close()
    }
    assert.equal(existsSync(runtimeLockPath(layout.dataDir)), false)
  }
})

test('SIGKILL leaves a recoverable stale lock and the next start reopens the database', async t => {
  const layout = createLayout(t)
  configureMockModel(layout.configDir)
  const first = await startChild(layout, t)
  const before = readRuntimeLock(layout.dataDir)
  assert.ok(before !== null)

  await first.kill()
  const stale = readRuntimeLock(layout.dataDir)
  assert.equal(stale?.ownerToken, before.ownerToken)
  assert.equal(existsSync(runtimeLockPath(layout.dataDir)), true)

  const restarted = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const health = await fetch(`${restarted.baseUrl}/kanobot/api/health`)
    assert.equal(health.status, 200)
    const after = readRuntimeLock(layout.dataDir)
    assert.notEqual(after?.ownerToken, before.ownerToken)
    assert.equal(after?.pid, process.pid)
  } finally {
    await restarted.close()
  }
  assert.equal(existsSync(runtimeLockPath(layout.dataDir)), false)
})

interface ChildApp {
  child: ChildProcessWithoutNullStreams
  ready: {
    pid: number
    port: number
    baseUrl: string
    bootstrapUrl: string
  }
  stop(mode: ShutdownMode): Promise<{ code: number | null }>
  kill(): Promise<void>
}

type ShutdownMode = 'sigterm' | 'sigint' | 'signal-term' | 'signal-int'

async function startChild(
  layout: { configDir: string; dataDir: string },
  t: TestContext,
): Promise<ChildApp> {
  const child = spawn(
    process.execPath,
    [
      'tests/fixtures/app-runtime.ts',
      layout.configDir,
      layout.dataDir,
      '0',
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let exited = false
  const exitPromise = new Promise<{ code: number | null }>(resolveExit => {
    child.once('close', code => {
      exited = true
      resolveExit({ code })
    })
  })
  t.after(() => {
    if (!exited) child.kill('SIGKILL')
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })

  const ready = await new Promise<ChildApp['ready']>((resolveReady, rejectReady) => {
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        if (line.startsWith('READY ')) {
          resolveReady(JSON.parse(line.slice(6)) as ChildApp['ready'])
          return
        }
        newline = stdout.indexOf('\n')
      }
    })
    child.once('error', rejectReady)
    child.once('close', code => {
      rejectReady(new Error(
        `child exited before ready (code ${code}): ${stderr}`,
      ))
    })
  })

  return {
    child,
    ready,
    async stop(mode): Promise<{ code: number | null }> {
      if (mode === 'signal-term') {
        child.kill('SIGTERM')
      } else if (mode === 'signal-int') {
        child.kill('SIGINT')
      } else {
        child.stdin.write(`${mode}\n`)
      }
      return await exitPromise
    },
    async kill(): Promise<void> {
      child.kill('SIGKILL')
      await exitPromise
    },
  }
}

function createLayout(t: TestContext): {
  root: string
  configDir: string
  dataDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-lifecycle-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, configDir, dataDir: join(root, 'data') }
}

function configureMockModel(configDir: string): void {
  const path = join(configDir, 'system.toml')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('[model]')
  const end = source.indexOf('[vision]')
  assert.ok(start >= 0 && end > start)
  const section = [
    '[model]',
    'provider = "mock"',
    'name = "kanobot-mock-v1"',
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

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runCli(args: string[]): Promise<CliResult> {
  return await new Promise<CliResult>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ['scripts/app-server.ts', ...args],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}
