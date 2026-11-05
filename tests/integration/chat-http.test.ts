/**
 * M3.0 Web/SSE 适配测试。
 *
 * 用真实 node:http 监听临时端口，模拟 DSH 的认证结果；不接触测试 Profile。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import {
  KanobotChatService,
  MockChatModel,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
} from '../../src/web/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('chat page and API fail closed without a DSH session', async () => {
  const harness = await createHarness()
  try {
    const page = await fetch(`${harness.baseUrl}/kanobot/`)
    assert.equal(page.status, 401)
    assert.match(await page.text(), /需要先登录 DSH/)

    const chat = await fetch(`${harness.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '不应该写入' }),
    })
    assert.equal(chat.status, 401)
    assert.equal(harness.store.chatMessageCount(), 0)
  } finally {
    await harness.close()
  }
})

test('authenticated page, SSE chat, and conversation restore work together', async () => {
  const harness = await createHarness()
  try {
    const page = await fetch(`${harness.baseUrl}/kanobot/`, {
      headers: authHeaders(),
    })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.match(await page.text(), /M3\.4 聊天、记忆与控制/)

    const response = await fetch(`${harness.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '网页闭环的虚构消息' }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const events = parseSse(await response.text())
    assert.equal(events[0]?.type, 'ready')
    assert.ok(events.some(event => event.type === 'delta'))
    const done = events.at(-1)
    assert.equal(done?.type, 'done')
    assert.ok(done?.type === 'done' && done.modelCall.status === 'succeeded')
    assert.equal(
      done?.type === 'done' ? done.modelUsage.todayCallCount : -1,
      1,
    )

    const conversation = await fetch(
      `${harness.baseUrl}/kanobot/api/conversation`,
      { headers: authHeaders() },
    )
    assert.equal(conversation.status, 200)
    const body = await conversation.json() as {
      messages: Array<{ role: string; text: string }>
      state: { messageCount: number }
      modelUsage: { lastCall: { status: string } | null; todayCallCount: number }
    }
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0]?.role, 'user')
    assert.equal(body.messages[1]?.role, 'assistant')
    assert.equal(body.state.messageCount, 2)
    assert.equal(body.modelUsage.lastCall?.status, 'succeeded')
    assert.equal(body.modelUsage.todayCallCount, 1)
  } finally {
    await harness.close()
  }
})

async function createHarness(): Promise<{
  baseUrl: string
  store: ReturnType<ReturnType<typeof createWorkspace>['open']>
  close(): Promise<void>
}> {
  const ws = createWorkspace(test)
  const store = ws.open()
  const chat = new KanobotChatService(store, new MockChatModel())
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
