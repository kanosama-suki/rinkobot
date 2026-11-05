/**
 * Magpie 视觉驱动集成测试。
 *
 * 所有 HTTP 服务都监听本机临时端口并返回虚构数据，不访问真实 Magpie、
 * 账户信息或视觉模型。测试覆盖启动能力检查、非流式请求、重试、超时、
 * 取消和错误脱敏。
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import {
  MagpieVisionModel,
  VisionModelError,
} from '../../src/core/vision/index.ts'
import {
  TEST_IMAGES,
  TEST_PNG_BASE64,
} from '../helpers/vision-fixtures.ts'

const MODEL_ID = 'test/vision-model'

test('requires an exact model that explicitly advertises image input', async () => {
  let models: unknown[] = [
    {
      id: MODEL_ID,
      modalities: { input: ['text'] },
    },
  ]
  const harness = await startServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    writeJson(response, 200, { data: models })
  })
  try {
    const model = visionModel(harness)
    await assert.rejects(
      model.checkAvailable(),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_model_not_image_capable',
    )

    models = [{ id: MODEL_ID }]
    await assert.rejects(
      model.checkAvailable(),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_model_not_image_capable',
    )

    models = [
      {
        id: MODEL_ID,
        max_output_tokens: 4096,
        modalities: { input: ['text', 'image'] },
      },
    ]
    await model.checkAvailable()
  } finally {
    await harness.close()
  }
})

test('rejects a missing exact vision model and an excessive output limit', async () => {
  let models: unknown[] = [{ id: 'auto/other-vision' }]
  const harness = await startServer((_request, response) => {
    writeJson(response, 200, { data: models })
  })
  try {
    const model = visionModel(harness)
    await assert.rejects(
      model.checkAvailable(),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_model_not_found',
    )

    models = [
      {
        id: MODEL_ID,
        max_output_tokens: 512,
        modalities: { input: ['text', 'image'] },
      },
    ]
    await assert.rejects(
      model.checkAvailable(),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_request_rejected',
    )
  } finally {
    await harness.close()
  }
})

test('describes an image with a non-stream OpenAI-compatible request', async () => {
  let chatHeaders: IncomingMessage['headers'] | null = null
  let chatBody: Record<string, unknown> | null = null
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      writeJson(response, 200, {
        data: [
          {
            id: MODEL_ID,
            max_output_tokens: 4096,
            modalities: { input: ['text', 'image'] },
            pricing: {
              prompt: '0.000001',
              completion: '0.000002',
              input_cache_read: '0.0000005',
            },
          },
        ],
      })
      return
    }
    if (request.url === '/v1/chat/completions') {
      chatHeaders = request.headers
      chatBody = JSON.parse(await readBody(request)) as Record<string, unknown>
      writeJson(response, 200, {
        id: 'vision-resp-1',
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '  卡片上写着「KANO 2026」。  ' },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: {
            cached_tokens: 10,
            cache_write_tokens: 0,
          },
          completion_tokens_details: {
            reasoning_tokens: 0,
          },
        },
      })
      return
    }
    writeJson(response, 404, { error: { message: 'not found' } })
  })
  try {
    const model = visionModel(harness, {
      apiKey: 'test-secret',
      sessionId: 'kanobot-vision-test',
    })
    await model.checkAvailable()
    const description = await model.describeImage({
      image: new Uint8Array(TEST_IMAGES['image/png']),
      mimeType: 'image/png',
      instruction: '请客观描述这张虚构测试卡片。',
      signal: new AbortController().signal,
    })

    assert.equal(description.text, '卡片上写着「KANO 2026」。')
    assert.equal(description.attempts, 1)
    assert.equal(description.responseId, 'vision-resp-1')
    assert.deepEqual(description.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 120,
    })
    assert.equal(description.estimatedCost, 0.000135)
    assert.equal(chatHeaders?.authorization, 'Bearer test-secret')
    assert.equal(
      chatHeaders?.['x-magpie-session'],
      'kanobot-vision-test',
    )
    assert.equal(chatBody?.model, MODEL_ID)
    assert.equal(chatBody?.stream, false)
    assert.equal(chatBody?.max_tokens, 2048)
    assert.equal(Object.hasOwn(chatBody ?? {}, 'response_format'), false)

    const messages = chatBody?.messages as Array<Record<string, unknown>>
    assert.equal(messages[0]?.role, 'system')
    assert.equal(messages[1]?.role, 'user')
    const content = messages[1]?.content as Array<Record<string, unknown>>
    assert.equal(content[0]?.type, 'text')
    assert.equal(content[0]?.text, '请客观描述这张虚构测试卡片。')
    assert.equal(content[1]?.type, 'image_url')
    assert.deepEqual(content[1]?.image_url, {
      url: `data:image/png;base64,${TEST_PNG_BASE64}`,
    })
  } finally {
    await harness.close()
  }
})

test('refuses to describe before the startup capability check', async () => {
  const harness = await startServer((_request, response) => {
    writeJson(response, 500, { error: { message: 'unexpected request' } })
  })
  try {
    const model = visionModel(harness)
    await assert.rejects(
      model.describeImage({
        image: new Uint8Array(TEST_IMAGES['image/png']),
        mimeType: 'image/png',
        instruction: '请描述。',
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_check_required',
    )
  } finally {
    await harness.close()
  }
})

test('retries transient failures before returning a description', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeVisionModels(response)
      return
    }
    chatRequests += 1
    if (chatRequests === 1) {
      writeJson(response, 500, { error: { message: 'temporary failure' } })
      return
    }
    writeJson(response, 200, visionResponse('重试后读到的虚构内容。'))
  })
  try {
    const model = visionModel(harness, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
    await model.checkAvailable()
    const description = await model.describeImage(imageRequest())
    assert.equal(chatRequests, 2)
    assert.equal(description.attempts, 2)
    assert.equal(description.text, '重试后读到的虚构内容。')
  } finally {
    await harness.close()
  }
})

test('times out each attempt and preserves the real attempt count', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeVisionModels(response)
      return
    }
    chatRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
    // 故意不结束响应；客户端必须在每次 attempt 超时后释放连接。
  })
  try {
    const model = visionModel(harness, {
      timeoutMs: 120,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
    await model.checkAvailable()
    await assert.rejects(
      model.describeImage(imageRequest()),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_timeout' &&
        error.attempts === 2,
    )
    assert.equal(chatRequests, 2)
  } finally {
    await harness.close()
  }
})

test('malformed JSON reports the actual retry attempt', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeVisionModels(response)
      return
    }
    chatRequests += 1
    writeRaw(response, 200, '{not-json}', 'application/json')
  })
  try {
    const model = visionModel(harness, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
    await model.checkAvailable()
    await assert.rejects(
      model.describeImage(imageRequest()),
      (error: unknown) =>
        error instanceof VisionModelError &&
        error.code === 'vision_protocol_error' &&
        error.attempts === 2,
    )
    assert.equal(chatRequests, 2)
  } finally {
    await harness.close()
  }
})

test('external cancellation stops without retry or fallback', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeVisionModels(response)
      return
    }
    chatRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
  })
  try {
    const model = visionModel(harness, {
      maxRetries: 3,
      retryBaseDelayMs: 0,
    })
    await model.checkAvailable()
    const controller = new AbortController()
    const pending = model.describeImage({
      ...imageRequest(),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 40)
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    assert.equal(chatRequests, 1)
  } finally {
    await harness.close()
  }
})

test('upstream errors do not leak their body or credentials', async () => {
  const secret = 'VISION-UPSTREAM-SECRET'
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeVisionModels(response)
      return
    }
    writeJson(response, 401, { error: { message: secret } })
  })
  try {
    const model = visionModel(harness, {
      apiKey: 'never-log-this-key',
      maxRetries: 0,
    })
    await model.checkAvailable()
    await assert.rejects(
      model.describeImage(imageRequest()),
      (error: unknown) => {
        assert.ok(error instanceof VisionModelError)
        assert.equal(error.code, 'vision_auth_failed')
        assert.equal(error.message.includes(secret), false)
        assert.equal(error.message.includes('never-log-this-key'), false)
        return true
      },
    )
  } finally {
    await harness.close()
  }
})

function visionModel(
  harness: ServerHarness,
  overrides: Partial<ConstructorParameters<typeof MagpieVisionModel>[0]> = {},
): MagpieVisionModel {
  return new MagpieVisionModel({
    baseUrl: harness.baseUrl,
    model: MODEL_ID,
    maxOutputTokens: 2048,
    timeoutMs: 5_000,
    maxRetries: 0,
    ...overrides,
  })
}

function imageRequest() {
  return {
    image: new Uint8Array(TEST_IMAGES['image/png']),
    mimeType: 'image/png' as const,
    instruction: '请客观描述这张虚构测试卡片。',
    signal: new AbortController().signal,
  }
}

function writeVisionModels(response: ServerResponse): void {
  writeJson(response, 200, {
    data: [
      {
        id: MODEL_ID,
        max_output_tokens: 4096,
        modalities: { input: ['text', 'image'] },
        pricing: {
          prompt: '0.000001',
          completion: '0.000002',
        },
      },
    ],
  })
}

function visionResponse(text: string): Record<string, unknown> {
  return {
    id: 'vision-resp-retry',
    choices: [{ message: { content: text } }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  }
}

interface ServerHarness {
  baseUrl: string
  close(): Promise<void>
}

async function startServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<ServerHarness> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' })
      }
      response.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
    },
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  writeRaw(response, status, `${JSON.stringify(payload)}\n`, 'application/json')
}

function writeRaw(
  response: ServerResponse,
  status: number,
  payload: string,
  contentType: string,
): void {
  const body = Buffer.from(payload, 'utf8')
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': String(body.byteLength),
  })
  response.end(body)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
