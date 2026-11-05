/**
 * 聊天链路的视觉集成测试。
 *
 * 使用本地假视觉模型和本地假聊天模型，验证独立转述、不可信上下文标记、
 * 两次调用审计、失败不落到聊天模型、额度预留和历史正文隔离。
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  ChatInputError,
  KanobotChatService,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import {
  VisionModelError,
  type VisionDescribeRequest,
  type VisionDescription,
  type VisionModel,
} from '../../src/core/vision/index.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import {
  TEST_IMAGES,
  TEST_PNG_BASE64,
  imagePayload,
} from '../helpers/vision-fixtures.ts'

const DESCRIPTION = '画面里有一张写着「KANO 2026」的虚构测试卡片。'

test('rejects an image before storage when vision is not configured', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const model = new CapturingChatModel()
    const chat = new KanobotChatService(store, model)
    await assert.rejects(
      collect(chat, {
        text: '未配置视觉时的虚构图片',
        images: [imagePayload('image/png')],
      }),
      (error: unknown) =>
        error instanceof ChatInputError &&
        error.code === 'vision_not_configured',
    )
    assert.equal(store.chatMessageCount(), 0)
    assert.equal(store.modelCallCountToday(), 0)
    assert.equal(model.requests.length, 0)
  } finally {
    store.close()
  }
})

test('describes an image once, then replies with a separate chat call', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const vision = new CapturingVisionModel(DESCRIPTION)
    const chatModel = new CapturingChatModel('我看到那张卡片了。')
    const chat = new KanobotChatService(store, chatModel, {
      dailyModelCallLimit: 10,
      maxConcurrentModelCalls: 2,
      vision: {
        model: vision,
        maxImageBytes: 5 * 1024 * 1024,
        maxDescriptionChars: 1_000,
      },
    })

    const events = await collect(chat, {
      text: '看看这张虚构卡片',
      images: [imagePayload('image/png')],
    })
    assert.deepEqual(
      events.map(event => event.type),
      ['vision', 'ready', 'delta', 'done'],
    )
    const visionEvent = events[0]
    assert.ok(visionEvent?.type === 'vision')
    assert.equal(visionEvent.phase, 'started')
    assert.equal(visionEvent.model.id, 'test/vision-model')

    assert.equal(vision.calls.length, 1)
    assert.deepEqual(
      Array.from(vision.calls[0]?.image ?? []),
      Array.from(TEST_IMAGES['image/png']),
    )
    assert.equal(vision.calls[0]?.mimeType, 'image/png')
    assert.match(
      vision.calls[0]?.instruction ?? '',
      /看看这张虚构卡片/,
    )

    assert.equal(chatModel.requests.length, 1)
    const request = chatModel.requests[0]
    assert.ok(request)
    assert.match(request.systemPrompt, /本轮附图内容（由独立视觉模型转述）/)
    assert.match(request.systemPrompt, /KANO 2026/)
    assert.match(request.systemPrompt, /确实附了一张图片/)
    assert.match(request.systemPrompt, /系统已经通过独立视觉模型读取/)
    assert.equal(request.messages.at(-1)?.text, '看看这张虚构卡片')
    assert.equal(JSON.stringify(request).includes(TEST_PNG_BASE64), false)

    const view = chat.conversation()
    assert.equal(view.vision.enabled, true)
    assert.equal(view.vision.model?.id, 'test/vision-model')
    assert.equal(view.vision.maxImages, 1)
    assert.equal(view.messages.length, 2)
    assert.equal(view.messages[0]?.text, '看看这张虚构卡片')
    assert.equal(store.modelCallCountToday(), 2)

    const visionCall = store.latestModelCall('main', 'vision')
    assert.ok(visionCall)
    assert.equal(visionCall.purpose, 'vision')
    assert.equal(visionCall.status, 'succeeded')
    assert.equal(visionCall.assistantMessageId, null)
    assert.equal(visionCall.provider, 'test')
    assert.equal(visionCall.model, 'test/vision-model')
    assert.equal(visionCall.responseId, 'vision-response-1')

    const chatCall = store.latestModelCall('main', 'chat')
    assert.ok(chatCall)
    assert.equal(chatCall.status, 'succeeded')
    assert.equal(chatCall.purpose, 'chat')
    assert.notEqual(chatCall.assistantMessageId, null)

    assertDatabaseOmitsTransientVisionData(
      store.databasePath,
      TEST_PNG_BASE64,
      DESCRIPTION,
    )
  } finally {
    store.close()
  }
})

test('image-only history stores a placeholder and never stores the description', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const vision = new CapturingVisionModel(DESCRIPTION)
    const chatModel = new CapturingChatModel('我看到了。')
    const chat = new KanobotChatService(store, chatModel, {
      vision: {
        model: vision,
        maxImageBytes: 5 * 1024 * 1024,
        maxDescriptionChars: 1_000,
      },
    })

    await collect(chat, { images: [imagePayload('image/png')] })
    await collect(chat, '刚才那张图里有什么？')

    const view = chat.conversation()
    assert.equal(view.messages[0]?.text, '（发送了一张图片）')
    assert.equal(chatModel.requests.length, 2)
    const followUp = chatModel.requests[1]
    assert.ok(followUp)
    const secondTurnContext = JSON.stringify(followUp)
    assert.equal(secondTurnContext.includes(DESCRIPTION), false)
    assert.equal(secondTurnContext.includes(TEST_PNG_BASE64), false)
    assert.equal(
      followUp.messages.some(message => message.text === '（发送了一张图片）'),
      true,
    )
  } finally {
    store.close()
  }
})

test('vision failure keeps the user message but never falls through to chat', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const vision = new FailingVisionModel(
      new VisionModelError(
        'vision_rate_limited',
        'test rate limit',
        2,
      ),
    )
    const chatModel = new CapturingChatModel()
    const chat = new KanobotChatService(store, chatModel, {
      vision: {
        model: vision,
        maxImageBytes: 5 * 1024 * 1024,
        maxDescriptionChars: 1_000,
      },
    })

    await assert.rejects(
      collect(chat, {
        text: '这张图会读取失败',
        images: [imagePayload('image/png')],
      }),
      (error: unknown) =>
        error instanceof ChatInputError &&
        error.code === 'vision_rate_limited',
    )
    assert.equal(chatModel.requests.length, 0)
    assert.equal(store.chatMessageCount(), 1)
    assert.equal(store.latestModelCall('main', 'chat'), null)
    const call = store.latestModelCall('main', 'vision')
    assert.ok(call)
    assert.equal(call.status, 'failed')
    assert.equal(call.attempts, 2)
    assert.equal(call.errorCode, 'vision_rate_limited')
    assert.equal(call.assistantMessageId, null)
    assertDatabaseOmitsTransientVisionData(
      store.databasePath,
      TEST_PNG_BASE64,
      DESCRIPTION,
    )
  } finally {
    store.close()
  }
})

test('an image turn reserves both daily calls while it is still running', async () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const controller = new AbortController()
  try {
    const vision = new QuotaProbeVisionModel()
    const chatModel = new CapturingChatModel()
    const chat = new KanobotChatService(store, chatModel, {
      dailyModelCallLimit: 3,
      maxConcurrentModelCalls: 2,
      vision: {
        model: vision,
        maxImageBytes: 5 * 1024 * 1024,
        maxDescriptionChars: 1_000,
      },
    })
    const iterator = chat
      .streamMessage(
        {
          text: '第一条占用额度的虚构图片',
          images: [imagePayload('image/png')],
        },
        controller.signal,
      )
      [Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.type, 'vision')

    await assert.rejects(
      collect(chat, {
        text: '第二条应该被额度预留拦下的虚构图片',
        images: [imagePayload('image/png')],
      }),
      (error: unknown) =>
        error instanceof ChatInputError &&
        error.code === 'daily_model_call_limit_reached',
    )
    assert.equal(store.chatMessageCount(), 1)

    controller.abort()
    await assert.rejects(iterator.next(), /aborted/)
    assert.equal(store.latestModelCall('main', 'vision')?.status, 'aborted')

    // 中止后预留必须释放；已落库的一条 aborted 审计仍占一个实际调用。
    await collect(chat, '额度释放后的虚构文字消息')
    assert.equal(store.modelCallCountToday(), 2)
  } finally {
    store.close()
  }
})

function assertDatabaseOmitsTransientVisionData(
  databasePath: string,
  base64: string,
  description: string,
): void {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const tables = ['bodies', 'events', 'model_calls', 'messages']
    const stored = tables
      .map(table => {
        const rows = db.prepare(`SELECT * FROM ${table}`).all()
        return JSON.stringify(rows)
      })
      .join('\n')
    assert.equal(stored.includes(base64), false)
    assert.equal(stored.includes(description), false)
  } finally {
    db.close()
  }
}

async function collect(
  chat: KanobotChatService,
  input: unknown,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const event of chat.streamMessage(
    input,
    new AbortController().signal,
  )) {
    events.push(event)
  }
  return events
}

class CapturingVisionModel implements VisionModel {
  readonly id = 'test/vision-model'
  readonly mode = 'test'
  readonly provider = 'test'
  readonly calls: VisionDescribeRequest[] = []
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  async describeImage(
    request: VisionDescribeRequest,
  ): Promise<VisionDescription> {
    if (request.signal.aborted) throw abortError()
    this.calls.push(request)
    return {
      text: this.text,
      attempts: 1,
      usage: {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 42,
      },
      estimatedCost: null,
      pricing: null,
      responseId: 'vision-response-1',
    }
  }
}

class FailingVisionModel implements VisionModel {
  readonly id = 'failing-vision-model'
  readonly mode = 'test'
  readonly provider = 'test'
  private readonly error: Error

  constructor(error: Error) {
    this.error = error
  }

  async describeImage(
    request: VisionDescribeRequest,
  ): Promise<VisionDescription> {
    if (request.signal.aborted) throw abortError()
    throw this.error
  }
}

class QuotaProbeVisionModel implements VisionModel {
  readonly id = 'quota-probe-vision'
  readonly mode = 'test'
  readonly provider = 'test'

  async describeImage(
    request: VisionDescribeRequest,
  ): Promise<VisionDescription> {
    if (request.instruction.includes('第二条')) {
      throw new VisionModelError(
        'vision_model_unavailable',
        'second request should have been rejected before this point',
        1,
      )
    }
    if (request.signal.aborted) throw abortError()
    await new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(abortError())
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()
    })
    throw new Error('unreachable')
  }
}

class CapturingChatModel implements ChatModel {
  readonly id = 'test/chat-model'
  readonly mode = 'test'
  readonly provider = 'test'
  readonly requests: ChatModelRequest[] = []
  private readonly reply: string

  constructor(reply = '这是虚构的视觉测试回复。') {
    this.reply = reply
  }

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'text', text: chatEnvelopeText(this.reply) }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: 'chat-response-1',
      },
    }
  }
}

function abortError(): Error {
  const error = new Error('test aborted')
  error.name = 'AbortError'
  return error
}
