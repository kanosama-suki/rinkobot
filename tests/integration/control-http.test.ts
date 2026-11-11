/**
 * M3.4 紧急停止、所有者审计和风格检查 HTTP 集成测试。
 *
 * 使用临时数据库和临时 STOP 文件，不访问测试 Profile 或正式实例。
 */

import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'

import {
  KanobotChatService,
  MockChatModel,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import {
  AuditTimelineService,
  OwnerAuditService,
} from '../../src/core/observability/index.ts'
import { KanobotEmergencyService } from '../../src/core/policy/index.ts'
import { CHAT_BASE_PATH, registerChatSurface } from '../../src/web/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('emergency state persists and STOP file cannot auto-resume it', () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  try {
    let emergency = new KanobotEmergencyService(
      store,
      ws.root,
      'STOP',
      ws.clock,
    )
    assert.equal(emergency.status().stopped, false)
    assert.equal(emergency.stop().stopped, true)
    assert.equal(existsSync(join(ws.root, 'STOP')), true)
    store.close()

    store = ws.open()
    emergency = new KanobotEmergencyService(store, ws.root, 'STOP', ws.clock)
    assert.equal(emergency.status().stopped, true)
    assert.equal(emergency.status().reasonCode, 'owner_stop')

    emergency.resume()
    assert.equal(emergency.status().stopped, false)
    assert.equal(existsSync(join(ws.root, 'STOP')), false)

    writeFileSync(join(ws.root, 'STOP'), 'manual stop\n', 'utf8')
    assert.equal(emergency.status().stopped, true)
    assert.equal(emergency.status().reasonCode, 'stop_file')
  } finally {
    store.close()
  }
})

test('control and audit endpoints fail closed without an owner session', async () => {
  const harness = await createHarness()
  try {
    assert.equal((await fetch(`${harness.baseUrl}/kanobot/api/control`)).status, 401)
    assert.equal((await fetch(`${harness.baseUrl}/kanobot/api/audit`)).status, 401)
    assert.equal(
      (
        await fetch(`${harness.baseUrl}/kanobot/api/emergency/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        })
      ).status,
      401,
    )
  } finally {
    await harness.close()
  }
})

test('owner can stop, still chat, inspect audit, and resume', async () => {
  const harness = await createHarness()
  try {
    const initial = await request(harness, '/kanobot/api/control')
    assert.equal(initial.status, 200)
    const initialBody = await initial.json() as {
      emergency: { stopped: boolean }
    }
    assert.equal(initialBody.emergency.stopped, false)

    const missingConfirmation = await request(
      harness,
      '/kanobot/api/emergency/stop',
      { method: 'POST', body: {} },
    )
    assert.equal(missingConfirmation.status, 400)

    const stopped = await request(
      harness,
      '/kanobot/api/emergency/stop',
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(stopped.status, 200)
    const stoppedBody = await stopped.json() as {
      emergency: { stopped: boolean; stopFilePresent: boolean }
    }
    assert.equal(stoppedBody.emergency.stopped, true)
    assert.equal(stoppedBody.emergency.stopFilePresent, true)

    const chatResponse = await fetch(`${harness.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ text: '停止后仍然要回复这条消息。' }),
    })
    assert.equal(chatResponse.status, 200)
    const events = parseSse(await chatResponse.text())
    assert.equal(events.at(-1)?.type, 'done')

    const memory = await request(harness, '/kanobot/api/memories', {
      method: 'POST',
      body: {
        text: 'kano 喜欢在安静的地方聊天。',
        kind: 'preference',
      },
    })
    assert.equal(memory.status, 201)

    const audit = await request(harness, '/kanobot/api/audit?limit=20')
    assert.equal(audit.status, 200)
    const auditBody = await audit.json() as {
      events: Array<{ action: string; outcome: string }>
      timeline: Array<{ source: string; targetId: string | null }>
    }
    assert.ok(
      auditBody.events.some(event => event.action === 'emergency.stop'),
    )
    assert.ok(
      auditBody.events.some(event => event.action === 'memory.create'),
    )
    assert.ok(auditBody.events.every(event => event.outcome === 'succeeded'))
    assert.ok(auditBody.timeline.some(entry => entry.source === 'model'))
    assert.ok(auditBody.timeline.some(entry => entry.source === 'style'))
    assert.ok(auditBody.timeline.some(entry => entry.source === 'chat'))

    const invalidSource = await request(
      harness,
      '/kanobot/api/audit?source=unknown',
    )
    assert.equal(invalidSource.status, 400)

    const resumed = await request(
      harness,
      '/kanobot/api/emergency/resume',
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(resumed.status, 200)
    const resumedBody = await resumed.json() as {
      emergency: { stopped: boolean; stopFilePresent: boolean }
    }
    assert.equal(resumedBody.emergency.stopped, false)
    assert.equal(resumedBody.emergency.stopFilePresent, false)
  } finally {
    await harness.close()
  }
})

async function request(
  harness: Awaited<ReturnType<typeof createHarness>>,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    accept: 'application/json',
  }
  const init: RequestInit = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  return fetch(`${harness.baseUrl}${path}`, init)
}

async function createHarness(): Promise<{
  baseUrl: string
  close(): Promise<void>
}> {
  const ws = createWorkspace(test)
  const store = ws.open()
  const memory = new KanobotMemoryService(store, ws.clock)
  const audit = new OwnerAuditService(store, ws.clock)
  const emergency = new KanobotEmergencyService(
    store,
    ws.root,
    'STOP',
    ws.clock,
  )
  const chat = new KanobotChatService(store, new MockChatModel(), {
    memory,
  })
  let handler: ((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void | Promise<void>) | undefined
  const dispose = registerChatSurface({
    webServer: {
      register(route): () => void {
        assert.equal(route.kind, 'prefix')
        assert.equal(route.path, CHAT_BASE_PATH)
        handler = route.handler
        return () => {
          handler = undefined
        }
      },
    },
    connection: {
      admit(request): { peer: object } | { rejection: 401 } {
        return request.headers['x-test-auth'] === 'kanobot'
          ? { peer: {} }
          : { rejection: 401 }
      },
    },
    chat,
    memory,
    audit,
    timeline: new AuditTimelineService(store),
    emergency,
    logger: {
      info(): void {},
    },
  })
  const server = createServer((request, response) => {
    assert.ok(handler)
    void handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      dispose()
      store.close()
    },
  }
}

function authHeaders(): Record<string, string> {
  return { 'x-test-auth': 'kanobot' }
}

function parseSse(text: string): ChatStreamEvent[] {
  return text
    .split('\n\n')
    .map(frame =>
      frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter(Boolean)
    .map(data => JSON.parse(data) as ChatStreamEvent)
}
