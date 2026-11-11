/**
 * M4 网页主动性 API 集成测试。
 *
 * 使用真实回环 HTTP 和临时数据库，验证鉴权、确认/拒绝提醒、取消、
 * 熔断恢复、确认字段和所有者页面资源。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import {
  KanobotChatService,
  MockChatModel,
} from '../../src/core/chat/index.ts'
import {
  KanobotInitiativeService,
  type DailyPlanDraft,
  type DailyReviewContext,
  type DailyReviewDraft,
  type InitiativeBrain,
  type ProactiveContext,
  type ProactiveDraft,
} from '../../src/core/initiative/index.ts'
import { KanobotEmergencyService } from '../../src/core/policy/index.ts'
import { CHAT_BASE_PATH, registerChatSurface } from '../../src/web/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('initiative API fails closed without an owner session', async () => {
  const harness = await createHarness()
  try {
    const response = await fetch(`${harness.baseUrl}/kanobot/api/initiative`)
    assert.equal(response.status, 401)
    assert.equal(harness.store.listReminders().length, 0)
  } finally {
    await harness.close()
  }
})

test('owner page exposes initiative controls and actions require confirmation', async () => {
  const harness = await createHarness()
  try {
    const page = await fetch(`${harness.baseUrl}/kanobot/`, {
      headers: authHeaders(),
    })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /id="tab-button-initiative"/)
    assert.match(html, /id="notification-enable"/)
    assert.match(html, /id="reminder-candidate-list"/)
    const script = await fetch(`${harness.baseUrl}/kanobot/app.js`, {
      headers: authHeaders(),
    })
    assert.equal(script.status, 200)
    const js = await script.text()
    assert.match(js, /async function loadInitiative/)
    assert.match(js, /function notifyProactiveMessage/)

    const initial = await request(harness, '/kanobot/api/initiative')
    assert.equal(initial.status, 200)
    const initialView = await initial.json() as InitiativeView
    assert.equal(initialView.enabled, true)
    assert.deepEqual(initialView.reminderCandidates, [])
    assert.deepEqual(initialView.reminders, [])

    const confirmCandidate = seedCandidate(harness.store, 'confirm')
    const missingConfirmation = await request(
      harness,
      `/kanobot/api/initiative/reminder-candidates/${confirmCandidate.id}/confirm`,
      { method: 'POST', body: {} },
    )
    assert.equal(missingConfirmation.status, 400)
    assert.equal(
      harness.store.getReminderCandidate(confirmCandidate.id)?.status,
      'pending',
    )

    const confirmed = await request(
      harness,
      `/kanobot/api/initiative/reminder-candidates/${confirmCandidate.id}/confirm`,
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(confirmed.status, 200)
    const confirmedView = await confirmed.json() as {
      initiative: InitiativeView
    }
    assert.equal(confirmedView.initiative.reminderCandidates.length, 0)
    const reminder = confirmedView.initiative.reminders.find(
      item => item.text === '虚构提醒 confirm',
    )
    assert.ok(reminder)
    assert.equal(reminder.status, 'confirmed')

    const rejected = await request(
      harness,
      `/kanobot/api/initiative/reminder-candidates/${seedCandidate(
        harness.store,
        'reject',
      ).id}/reject`,
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(rejected.status, 200)

    const cancelled = await request(
      harness,
      `/kanobot/api/initiative/reminders/${reminder.id}`,
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(cancelled.status, 200)
    const cancelledView = await cancelled.json() as {
      initiative: InitiativeView
    }
    assert.equal(
      cancelledView.initiative.reminders.find(
        item => item.id === reminder.id,
      )?.status,
      'cancelled',
    )

    harness.store.updateInitiativeState({
      circuitOpenedAt: '2026-11-05T23:50:00.000Z',
      updatedAt: '2026-11-05T23:50:00.000Z',
    })
    assert.equal(
      (await request(harness, '/kanobot/api/initiative')).status,
      200,
    )
    const reset = await request(
      harness,
      '/kanobot/api/initiative/circuit/reset',
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(reset.status, 200)
    const resetView = await reset.json() as { initiative: InitiativeView }
    assert.equal(resetView.initiative.circuit.open, false)

    const badId = await request(
      harness,
      '/kanobot/api/initiative/reminders/%20',
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(badId.status, 400)
    const missing = await request(
      harness,
      '/kanobot/api/initiative/reminders/reminder-does-not-exist',
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(missing.status, 404)
  } finally {
    await harness.close()
  }
})

interface InitiativeView {
  enabled: boolean
  circuit: { open: boolean }
  reminderCandidates: Array<{ id: string; status: string }>
  reminders: Array<{ id: string; text: string; status: string }>
}

type TestStore = ReturnType<ReturnType<typeof createWorkspace>['open']>

function seedCandidate(store: TestStore, suffix: string) {
  const source = store.appendChatMessage({
    id: `message-candidate-${suffix}`,
    conversationId: 'main',
    role: 'user',
    text: `虚构提醒来源 ${suffix}`,
    createdAt: '2026-11-05T23:00:00.000Z',
  })
  return store.putReminderCandidate({
    id: `candidate-${suffix}`,
    text: `虚构提醒 ${suffix}`,
    dueAt: '2026-11-06T02:00:00.000Z',
    sourceMessageId: source.id,
    createdAt: '2026-11-05T23:00:00.000Z',
  })
}

async function createHarness(): Promise<{
  baseUrl: string
  store: TestStore
  close(): Promise<void>
}> {
  const ws = createWorkspace(test, { now: '2026-11-05T23:00:00.000Z' })
  const store = ws.open()
  const emergency = new KanobotEmergencyService(
    store,
    ws.root,
    ws.loaded.policy.emergency.stopFile,
    ws.clock,
  )
  const initiative = new KanobotInitiativeService(
    store,
    new IdleBrain(),
    {
      config: ws.loaded.initiative,
      timezone: ws.loaded.system.time.timezone,
      quietHoursStart: ws.loaded.system.time.quietHoursStart,
      quietHoursEnd: ws.loaded.system.time.quietHoursEnd,
      emergency,
      clock: ws.clock,
    },
  )
  const chat = new KanobotChatService(store, new MockChatModel(), {
    clock: ws.clock,
  })
  let handler:
    | ((
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
      ) => void | Promise<void>)
    | undefined
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
    initiative,
    logger: { info(): void {} },
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
    store,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      dispose()
      store.close()
    },
  }
}

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

function authHeaders(): Record<string, string> {
  return { 'x-test-auth': 'kanobot' }
}

class IdleBrain implements InitiativeBrain {
  async planDay(): Promise<DailyPlanDraft> {
    return { schemaVersion: 1, items: [] }
  }

  async composeProactive(
    _context: ProactiveContext,
  ): Promise<ProactiveDraft> {
    return {
      schemaVersion: 1,
      shouldSend: false,
      message: '',
      reasonCode: 'nothing_to_say',
      careItemId: null,
    }
  }

  async reviewDay(
    _context: DailyReviewContext,
  ): Promise<DailyReviewDraft> {
    return {
      schemaVersion: 1,
      summary: '没有需要整理的虚构消息。',
      facts: [],
      memories: [],
    }
  }
}
