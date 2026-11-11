/**
 * 独立程序健康检查验收。
 *
 * 覆盖：未登录回环 200、最小字段、无 Cookie、Host/Origin 仍受校验、
 * 非 GET 拒绝、本地控制通道重新签发一次性登录链接，以及数据库/
 * 调度器不可用时纯响应逻辑返回 503。
 */

import assert from 'node:assert/strict'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  request as httpRequest,
  type IncomingMessage,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAppServer } from '../../src/app/index.ts'
import {
  buildHealthPayload,
  healthStatusCode,
  type HealthPayload,
} from '../../src/app/health.ts'
import {
  queryRuntimeControl,
  readRuntimeLock,
} from '../../src/app/runtime-lock.ts'
import { InitiativeScheduler } from '../../src/core/initiative/index.ts'
import { KanobotStorage } from '../../src/core/storage/index.ts'
import { KANOBOT_VERSION } from '../../src/version.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

test('health is reachable without login and exposes only minimal status', async t => {
  const layout = createLayout(t)
  configureChatModel(layout.configDir)
  const app = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const response = await fetch(`${app.baseUrl}/kanobot/api/health`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json() as HealthPayload
    assert.deepEqual(Object.keys(payload).sort(), [
      'database',
      'ok',
      'qq',
      'scheduler',
      'status',
      'uptime',
      'version',
    ])
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'ready')
    assert.equal(payload.database, 'ok')
    assert.equal(payload.scheduler, 'running')
    assert.equal(payload.qq, 'disabled')
    assert.equal(payload.version, KANOBOT_VERSION)
    assert.ok(Number.isInteger(payload.uptime))

    const serialized = JSON.stringify(payload)
    for (const sensitive of [
      layout.configDir,
      layout.dataDir,
      'kanobot.sqlite',
      'mock',
      'token',
      'cookie',
      readRuntimeLock(layout.dataDir)?.ownerToken ?? 'owner-token-missing',
    ]) {
      assert.equal(serialized.includes(sensitive), false)
    }

    const badOrigin = await fetch(`${app.baseUrl}/kanobot/api/health`, {
      headers: { origin: 'http://malicious.invalid' },
    })
    assert.equal(badOrigin.status, 403)

    const badHostStatus = await requestStatus(
      `${app.baseUrl}/kanobot/api/health`,
      'malicious.invalid',
    )
    assert.equal(badHostStatus, 403)

    const post = await fetch(`${app.baseUrl}/kanobot/api/health`, {
      method: 'POST',
    })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET')

    const loginResponse = await queryRuntimeControl(layout.dataDir, {
      command: 'issue-login',
    })
    assert.equal(typeof loginResponse.url, 'string')
    const login = await fetch(String(loginResponse.url), {
      redirect: 'manual',
    })
    assert.equal(login.status, 303)
    assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/)
  } finally {
    await app.close()
  }
})

test('health reports 503 when database or scheduler is unavailable', async t => {
  const base = {
    startedAtMillis: 1_000,
    nowMillis: 61_000,
    version: 'test',
    databaseOk: true,
    schedulerRunning: true,
    qqEnabled: false,
    shuttingDown: false,
  }
  const ready = buildHealthPayload(base)
  assert.equal(ready.ok, true)
  assert.equal(ready.uptime, 60)
  assert.equal(healthStatusCode(ready), 200)

  const noDatabase = buildHealthPayload({ ...base, databaseOk: false })
  assert.equal(noDatabase.ok, false)
  assert.equal(noDatabase.status, 'unavailable')
  assert.equal(noDatabase.database, 'unavailable')
  assert.equal(healthStatusCode(noDatabase), 503)

  const noScheduler = buildHealthPayload({ ...base, schedulerRunning: false })
  assert.equal(noScheduler.ok, false)
  assert.equal(noScheduler.scheduler, 'stopped')
  assert.equal(healthStatusCode(noScheduler), 503)

  const stopping = buildHealthPayload({ ...base, shuttingDown: true })
  assert.equal(stopping.status, 'shutting_down')
  assert.equal(healthStatusCode(stopping), 503)

  const layout = createLayout(t)
  configureChatModel(layout.configDir)

  const databaseHealth = t.mock.method(
    KanobotStorage.prototype,
    'healthCheck',
    () => {
      throw new Error('synthetic database health failure')
    },
  )
  const databaseApp = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const response = await fetch(`${databaseApp.baseUrl}/kanobot/api/health`)
    assert.equal(response.status, 503)
    const payload = await response.json() as HealthPayload
    assert.equal(payload.ok, false)
    assert.equal(payload.database, 'unavailable')
    assert.equal(payload.scheduler, 'running')
  } finally {
    await databaseApp.close()
    databaseHealth.mock.restore()
  }

  const schedulerStart = t.mock.method(
    InitiativeScheduler.prototype,
    'start',
    () => {},
  )
  const schedulerApp = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const response = await fetch(`${schedulerApp.baseUrl}/kanobot/api/health`)
    assert.equal(response.status, 503)
    const payload = await response.json() as HealthPayload
    assert.equal(payload.ok, false)
    assert.equal(payload.database, 'ok')
    assert.equal(payload.scheduler, 'stopped')
  } finally {
    await schedulerApp.close()
    schedulerStart.mock.restore()
  }
})

test('startup report includes operational state but no login token or paths', async t => {
  const layout = createLayout(t)
  configureChatModel(layout.configDir)
  const logs: string[] = []
  const app = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: {
      info(message: string): void {
        logs.push(message)
      },
      error(): void {},
    },
  })
  try {
    const startup = logs.find(line => line.includes('[kanobot-app] startup'))
    assert.ok(startup !== undefined)
    const lockOwner = readRuntimeLock(layout.dataDir)?.ownerToken
    assert.ok(lockOwner !== undefined)
    assert.match(startup, /pid=\d+/)
    assert.match(startup, /version=0\.21\.0/)
    assert.match(startup, /schema=12/)
    assert.match(startup, new RegExp(`lockOwner=${lockOwner.slice(0, 12)}(?:\\s|$)`))
    assert.match(startup, /backups=\d+/)
    assert.match(startup, /dailyBackup=(created|existing)/)
    assert.match(startup, /scheduler=running/)
    assert.match(startup, /qq=disabled/)
    assert.equal(startup.includes(lockOwner), false)
    assert.equal(logs.some(line => line.includes('?token=')), false)
    assert.equal(logs.some(line => line.includes(layout.configDir)), false)
    assert.equal(logs.some(line => line.includes(layout.dataDir)), false)
    assert.equal(logs.some(line => line.includes('kanobot-mock-v1')), false)
  } finally {
    await app.close()
  }
})

function createLayout(t: TestContext): {
  root: string
  configDir: string
  dataDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-health-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, configDir, dataDir: join(root, 'data') }
}

function configureChatModel(configDir: string): void {
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

async function requestStatus(url: string, host: string): Promise<number> {
  return await new Promise<number>((resolveStatus, rejectStatus) => {
    const parsed = new URL(url)
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: { host },
    }, (response: IncomingMessage) => {
      response.resume()
      response.once('end', () => resolveStatus(response.statusCode ?? 0))
    })
    request.once('error', rejectStatus)
    request.end()
  })
}
