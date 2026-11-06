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
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import type {
  VisionDescribeRequest,
  VisionDescription,
  VisionModel,
} from '../../src/core/vision/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
} from '../../src/web/index.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { imagePayload } from '../helpers/vision-fixtures.ts'

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
    assert.match(await page.text(), /M4 聊天、主动性与陪伴/)

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

test('the page exposes image controls and the chat API runs the vision turn', async () => {
  const vision = new HttpVisionModel()
  const chatModel = new HttpChatModel()
  const harness = await createHarness(store =>
    new KanobotChatService(store, chatModel, {
      dailyModelCallLimit: 10,
      vision: {
        model: vision,
        maxImageBytes: 1_048_576,
        maxDescriptionChars: 1_000,
      },
    }),
  )
  try {
    const page = await fetch(`${harness.baseUrl}/kanobot/`, {
      headers: authHeaders(),
    })
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /id="image-input"/)
    assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/)
    const script = await fetch(`${harness.baseUrl}/kanobot/app.js`, {
      headers: authHeaders(),
    })
    assert.equal(script.status, 200)
    assert.match(await script.text(), /正在读取图片/)

    const response = await fetch(`${harness.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: '网页图片闭环的虚构卡片',
        images: [imagePayload('image/png')],
      }),
    })
    assert.equal(response.status, 200)
    const events = parseSse(await response.text())
    assert.equal(events[0]?.type, 'vision')
    assert.equal(events.at(-1)?.type, 'done')
    assert.equal(vision.calls, 1)
    assert.equal(chatModel.calls, 1)
    assert.equal(harness.store.modelCallCountToday(), 2)

    const conversation = await fetch(
      `${harness.baseUrl}/kanobot/api/conversation`,
      { headers: authHeaders() },
    )
    const body = await conversation.json() as {
      vision: {
        enabled: boolean
        maxImageBytes: number
        model: { id: string } | null
      }
      messages: Array<{ role: string; text: string }>
    }
    assert.equal(body.vision.enabled, true)
    assert.equal(body.vision.maxImageBytes, 1_048_576)
    assert.equal(body.vision.model?.id, 'http-vision-model')
    assert.equal(body.messages[0]?.text, '网页图片闭环的虚构卡片')
  } finally {
    await harness.close()
  }
})

test('the chat API rejects unknown body fields before opening an SSE stream', async () => {
  const harness = await createHarness()
  try {
    const response = await fetch(`${harness.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '不应落库', extra: true }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as {
      error: { code: string }
    }
    assert.equal(body.error.code, 'invalid_body')
    assert.equal(harness.store.chatMessageCount(), 0)
  } finally {
    await harness.close()
  }
})

type TestStore = ReturnType<ReturnType<typeof createWorkspace>['open']>

async function createHarness(
  createChat: (store: TestStore) => KanobotChatService = store =>
    new KanobotChatService(store, new MockChatModel()),
): Promise<{
  baseUrl: string
  store: TestStore
  close(): Promise<void>
}> {
  const ws = createWorkspace(test)
  const store = ws.open()
  const chat = createChat(store)
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

class HttpVisionModel implements VisionModel {
  readonly id = 'http-vision-model'
  readonly mode = 'test'
  readonly provider = 'test'
  calls = 0

  async describeImage(
    request: VisionDescribeRequest,
  ): Promise<VisionDescription> {
    this.calls += 1
    if (request.signal.aborted) {
      const error = new Error('test aborted')
      error.name = 'AbortError'
      throw error
    }
    return {
      text: '图片里是一张写着「KANO 2026」的虚构卡片。',
      attempts: 1,
      usage: null,
      estimatedCost: null,
      pricing: null,
      responseId: 'http-vision-response',
    }
  }
}

class HttpChatModel implements ChatModel {
  readonly id = 'http-chat-model'
  readonly mode = 'test'
  readonly provider = 'test'
  calls = 0

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.calls += 1
    yield { type: 'text', text: chatEnvelopeText('我看到那张虚构卡片了。') }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: 'http-chat-response',
      },
    }
  }
}
