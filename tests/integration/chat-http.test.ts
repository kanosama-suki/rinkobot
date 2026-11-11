/**
 * M3.0 Web/SSE 适配测试。
 *
 * 用真实 node:http 监听临时端口，模拟所有者认证结果；不接触正式实例。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import {
  ChatModelError,
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

test('chat page and API fail closed without an owner session', async () => {
  const harness = await createHarness()
  try {
    const page = await fetch(`${harness.baseUrl}/kanobot/`)
    assert.equal(page.status, 401)
    assert.match(await page.text(), /需要有效的所有者会话/)

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
    assert.match(await page.text(), /Rinkobot · 独立陪伴核心/)

    const script = await fetch(`${harness.baseUrl}/kanobot/app.js`, {
      headers: authHeaders(),
    })
    assert.equal(script.status, 200)
    const scriptText = await script.text()
    assert.match(
      scriptText,
      /\/kanobot\/api\/conversation\?\$\{params\}/,
    )
    assert.match(scriptText, /const PAGE_SIZE = 50/)

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

test('conversation pages and the cross-conversation timeline use stable cursors', async () => {
  const harness = await createHarness()
  try {
    for (let index = 1; index <= 60; index += 1) {
      harness.store.appendChatMessage({
        conversationId: 'main',
        role: index % 2 === 1 ? 'user' : 'assistant',
        text: `主会话虚构消息 ${index}`,
        id: `main-message-${index}`,
      })
    }
    for (let index = 1; index <= 5; index += 1) {
      harness.store.appendChatMessage({
        conversationId: 'qq-private-40004',
        role: 'user',
        text: `其他私聊虚构消息 ${index}`,
        id: `other-message-${index}`,
      })
    }

    const firstResponse = await fetch(
      `${harness.baseUrl}/kanobot/api/conversation?limit=50`,
      { headers: authHeaders() },
    )
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as {
      messages: Array<{ id: string; sequence: number }>
      hasMore: boolean
      nextBeforeSequence: number | null
    }
    assert.equal(first.messages.length, 50)
    assert.equal(first.messages[0]?.id, 'main-message-11')
    assert.equal(first.messages.at(-1)?.id, 'main-message-60')
    assert.equal(first.hasMore, true)
    assert.equal(first.nextBeforeSequence, first.messages[0]?.sequence)

    const secondResponse = await fetch(
      `${harness.baseUrl}/kanobot/api/conversation` +
        `?limit=50&beforeSeq=${first.nextBeforeSequence}`,
      { headers: authHeaders() },
    )
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as {
      messages: Array<{ id: string; sequence: number }>
      hasMore: boolean
      nextBeforeSequence: number | null
    }
    assert.equal(second.messages.length, 10)
    assert.equal(second.hasMore, false)
    assert.equal(second.nextBeforeSequence, null)
    assert.equal(
      second.messages.some(message => first.messages.some(
        earlier => earlier.id === message.id,
      )),
      false,
    )

    const timelineResponse = await fetch(
      `${harness.baseUrl}/kanobot/api/timeline?limit=50`,
      { headers: authHeaders() },
    )
    assert.equal(timelineResponse.status, 200)
    const timeline = await timelineResponse.json() as {
      messages: Array<{
        id: string
        sequence: number
        conversationKind: string
        conversationLabel: string
      }>
      hasMore: boolean
      nextBeforeSequence: number | null
    }
    assert.equal(timeline.messages.length, 50)
    assert.equal(timeline.hasMore, true)
    assert.equal(timeline.nextBeforeSequence, timeline.messages[0]?.sequence)
    assert.deepEqual(
      timeline.messages.map(message => message.sequence),
      [...timeline.messages.map(message => message.sequence)].sort(
        (left, right) => left - right,
      ),
    )
    assert.equal(
      timeline.messages.at(-1)?.conversationKind,
      'qq-private',
    )
    assert.equal(
      timeline.messages.at(-1)?.conversationLabel,
      'qq-private-40004',
    )

    const directoryResponse = await fetch(
      `${harness.baseUrl}/kanobot/api/conversations`,
      { headers: authHeaders() },
    )
    assert.equal(directoryResponse.status, 200)
    const directory = await directoryResponse.json() as {
      ownerConversationId: string
      conversations: Array<{
        conversationId: string
        conversationKind: string
        messageCount: number
      }>
    }
    assert.equal(directory.ownerConversationId, 'main')
    assert.equal(
      directory.conversations.find(item => item.conversationId === 'main')
        ?.messageCount,
      60,
    )
    assert.equal(
      directory.conversations.find(
        item => item.conversationId === 'qq-private-40004',
      )?.conversationKind,
      'qq-private',
    )
  } finally {
    await harness.close()
  }
})

test('conversation APIs reject malformed limits, cursors, and conversation ids', async () => {
  const harness = await createHarness()
  try {
    const cases = [
      ['/kanobot/api/conversation?limit=0', 'invalid_limit'],
      ['/kanobot/api/conversation?limit=abc', 'invalid_limit'],
      ['/kanobot/api/conversation?beforeSeq=0', 'invalid_cursor'],
      ['/kanobot/api/timeline?beforeSeq=abc', 'invalid_cursor'],
      [
        '/kanobot/api/timeline?conversationId=bad%2Fid',
        'invalid_conversation',
      ],
    ] as const
    for (const [path, code] of cases) {
      const response = await fetch(`${harness.baseUrl}${path}`, {
        headers: authHeaders(),
      })
      assert.equal(response.status, 400, path)
      const body = await response.json() as { error: { code: string } }
      assert.equal(body.error.code, code, path)
    }
  } finally {
    await harness.close()
  }
})

test('conversation display names are editable without changing stable ids', async () => {
  const harness = await createHarness()
  try {
    harness.store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '所有者虚构消息。',
      id: 'display-main',
    })
    harness.store.appendChatMessage({
      conversationId: 'qq-private-40004',
      role: 'user',
      text: '私聊虚构消息。',
      id: 'display-private',
    })
    harness.store.appendChatMessage({
      conversationId: 'qq-group-20002',
      role: 'user',
      text: '群聊虚构消息。',
      id: 'display-group',
    })

    const initialDirectory = await fetch(
      `${harness.baseUrl}/kanobot/api/conversations`,
      { headers: authHeaders() },
    )
    const initial = await initialDirectory.json() as {
      conversations: Array<{
        conversationId: string
        conversationLabel: string
        displayName: string | null
      }>
    }
    assert.equal(
      initial.conversations.find(
        item => item.conversationId === 'qq-private-40004',
      )?.conversationLabel,
      'qq-private-40004',
    )
    assert.equal(
      initial.conversations.find(
        item => item.conversationId === 'qq-group-20002',
      )?.conversationLabel,
      'qq-group-20002',
    )

    const rename = await fetch(
      `${harness.baseUrl}/kanobot/api/conversations/qq-private-40004`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: '  夜间私聊  ' }),
      },
    )
    assert.equal(rename.status, 200)
    const renamed = await rename.json() as {
      conversationId: string
      conversationLabel: string
      displayName: string | null
      messageCount: number
    }
    assert.equal(renamed.conversationId, 'qq-private-40004')
    assert.equal(renamed.displayName, '夜间私聊')
    assert.equal(renamed.conversationLabel, '夜间私聊')
    assert.equal(renamed.messageCount, 1)

    const timelineResponse = await fetch(
      `${harness.baseUrl}/kanobot/api/timeline?conversationId=qq-private-40004`,
      { headers: authHeaders() },
    )
    const timeline = await timelineResponse.json() as {
      messages: Array<{
        conversationId: string
        conversationLabel: string
      }>
    }
    assert.equal(timeline.messages[0]?.conversationId, 'qq-private-40004')
    assert.equal(timeline.messages[0]?.conversationLabel, '夜间私聊')

    const reset = await fetch(
      `${harness.baseUrl}/kanobot/api/conversations/qq-private-40004`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: null }),
      },
    )
    assert.equal(reset.status, 200)
    const restored = await reset.json() as {
      conversationLabel: string
      displayName: string | null
    }
    assert.equal(restored.displayName, null)
    assert.equal(restored.conversationLabel, 'qq-private-40004')

    const rejected = [
      {
        path: '/kanobot/api/conversations/main',
        status: 409,
        code: 'owner_conversation_immutable',
        body: { displayName: '不能改名' },
      },
      {
        path: '/kanobot/api/conversations/qq-private-99999',
        status: 404,
        code: 'conversation_not_found',
        body: { displayName: '不存在' },
      },
      {
        path: '/kanobot/api/conversations/qq-private-40004',
        status: 400,
        code: 'invalid_display_name',
        body: { displayName: '换\n行' },
      },
      {
        path: '/kanobot/api/conversations/qq-private-40004',
        status: 400,
        code: 'invalid_display_name',
        body: { displayName: '名'.repeat(61) },
      },
      {
        path: '/kanobot/api/conversations/qq-private-40004',
        status: 400,
        code: 'invalid_body',
        body: { displayName: '合法', extra: true },
      },
      {
        path: '/kanobot/api/conversations/bad%2Fid',
        status: 400,
        code: 'invalid_conversation',
        body: { displayName: '非法 ID' },
      },
    ] as const
    for (const item of rejected) {
      const response = await fetch(`${harness.baseUrl}${item.path}`, {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(item.body),
      })
      assert.equal(response.status, item.status, item.path)
      const error = await response.json() as { error: { code: string } }
      assert.equal(error.error.code, item.code, item.path)
    }

    const unauthenticated = await fetch(
      `${harness.baseUrl}/kanobot/api/conversations/qq-private-40004`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '未认证' }),
      },
    )
    assert.equal(unauthenticated.status, 401)
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

test('empty model output reaches the page as an explicit SSE error', async () => {
  const harness = await createHarness(
    store => new KanobotChatService(store, new EmptyOutputChatModel()),
  )
  try {
    const response = await fetch(`${harness.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '这条虚构消息会触发空正文错误' }),
    })
    assert.equal(response.status, 200)
    const events = parseSse(await response.text())
    assert.equal(events[0]?.type, 'ready')
    const error = events.at(-1)
    assert.equal(error?.type, 'error')
    assert.equal(
      error?.type === 'error' ? error.code : null,
      'model_empty_response',
    )
    assert.match(
      error?.type === 'error' ? error.message : '',
      /没有返回可用正文/,
    )
    assert.equal(events.some(event => event.type === 'done'), false)

    const conversation = await fetch(
      `${harness.baseUrl}/kanobot/api/conversation`,
      { headers: authHeaders() },
    )
    const body = await conversation.json() as {
      messages: Array<{ role: string }>
      modelUsage: {
        lastCall: { status: string; errorCode: string | null } | null
      }
    }
    assert.deepEqual(body.messages.map(message => message.role), ['user'])
    assert.equal(body.modelUsage.lastCall?.status, 'failed')
    assert.equal(body.modelUsage.lastCall?.errorCode, 'model_empty_response')
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

class EmptyOutputChatModel implements ChatModel {
  readonly id = 'empty-output-test-model'
  readonly mode = 'test'
  readonly provider = 'test'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    throw new ChatModelError(
      'model_empty_response',
      'model produced no visible text',
      2,
    )
  }
}
