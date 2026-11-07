/**
 * Magpie 网关集成测试。
 *
 * 所有 HTTP 服务都在本机临时端口上伪造，不调用真实模型，也不读取真实
 * Magpie 用量或账户信息。测试覆盖分片 UTF-8、usage、重试、超时、取消、
 * 协议错误和“有正文后不重试”的边界。
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import {
  ChatModelError,
  MagpieChatModel,
  type ChatModelStreamEvent,
} from '../../src/core/chat/index.ts'

const MODEL_ID = 'deepseek/deepseek-flash'

test('accepts an IPv6 loopback base URL at construction', () => {
  assert.doesNotThrow(() => new MagpieChatModel({
    baseUrl: 'http://[0:0:0:0:0:0:0:1]:3425/v1/',
    model: MODEL_ID,
    maxOutputTokens: 4096,
    timeoutMs: 2_000,
    maxRetries: 0,
  }))
})

test('Magpie streams fragmented UTF-8, ignores reasoning, and parses usage', async () => {
  let chatBody: Record<string, unknown> | null = null
  let chatHeaders: IncomingMessage['headers'] | null = null
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      assert.equal(request.headers.authorization, 'Bearer test-secret')
      assert.equal(request.headers['x-magpie-session'], 'kanobot-test')
      writeJson(response, 200, {
        data: [
          {
            id: MODEL_ID,
            max_output_tokens: 393216,
            reasoning_levels: ['none', 'low', 'high', 'max'],
            pricing: {
              prompt: '0.00000015',
              completion: '0.0000006',
              input_cache_read: '0.000000003',
            },
          },
        ],
      })
      return
    }
    if (request.url === '/v1/chat/completions') {
      chatHeaders = request.headers
      chatBody = JSON.parse(await readBody(request)) as Record<string, unknown>
      const frames = [
        'data: {"id":"resp-sse-1","choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n',
        'data: {"id":"resp-sse-1","choices":[{"delta":{"reasoning_content":"SECRET-COT","content":"你好，世界"}}]}\r\n\r\n',
        'data: {"id":"resp-sse-1","choices":[{"delta":{"content":"喵。"}}]}\r\n\r\n',
        'data: {"id":"resp-sse-1","choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
        'data: {"id":"resp-sse-1","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":11,"total_tokens":53,"prompt_tokens_details":{"cached_tokens":10,"cache_write_tokens":0},"completion_tokens_details":{"reasoning_tokens":9}}}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ].join('')
      const bytes = Buffer.from(frames, 'utf8')
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      response.flushHeaders()
      // 故意按字节切分，确保中文 UTF-8 序列和 CRLF 都可能跨网络分片。
      for (let offset = 0; offset < bytes.length; offset += 7) {
        response.write(bytes.subarray(offset, offset + 7))
      }
      response.end()
      return
    }
    writeJson(response, 404, { error: { message: 'not found' } })
  })

  try {
    const model = new MagpieChatModel({
      baseUrl: harness.baseUrl,
      model: MODEL_ID,
      maxOutputTokens: 4096,
      timeoutMs: 5_000,
      maxRetries: 0,
      reasoningEffort: 'low',
      apiKey: 'test-secret',
      sessionId: 'kanobot-test',
    })
    await model.checkAvailable()
    const events = await collect(model)
    assert.equal(
      events
        .filter((event): event is Extract<ChatModelStreamEvent, { type: 'text' }> =>
          event.type === 'text',
        )
        .map(event => event.text)
        .join(''),
      '你好，世界喵。',
    )
    assert.equal(JSON.stringify(events).includes('SECRET-COT'), false)
    const resultEvents = events.filter(event => event.type === 'result')
    assert.equal(resultEvents.length, 1)
    const result = resultEvents[0]
    assert.ok(result?.type === 'result')
    assert.equal(result.result.attempts, 1)
    assert.equal(result.result.responseId, 'resp-sse-1')
    assert.deepEqual(result.result.usage, {
      inputTokens: 42,
      outputTokens: 11,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 9,
      totalTokens: 53,
    })
    assert.equal(result.result.estimatedCost, 0.00001143)
    assert.equal(chatHeaders?.authorization, 'Bearer test-secret')
    assert.equal(chatHeaders?.['x-magpie-session'], 'kanobot-test')
    assert.equal(chatBody?.model, MODEL_ID)
    assert.equal(chatBody?.max_tokens, 4096)
    assert.equal(chatBody?.reasoning_effort, 'low')
    assert.equal(chatBody?.stream, true)
    assert.deepEqual(chatBody?.stream_options, { include_usage: true })
    assert.deepEqual(chatBody?.response_format, { type: 'json_object' })
    assert.equal(Array.isArray(chatBody?.messages), true)

    // 视觉/普通文本调用不要求 JSON 输出，不能把 response_format 无条件带上。
    await collect(model, new AbortController().signal, false)
    assert.ok(chatBody !== null)
    assert.equal(Object.hasOwn(chatBody, 'response_format'), false)
  } finally {
    await harness.close()
  }
})

test('omits reasoning_effort when it is not configured', async () => {
  let chatBody: Record<string, unknown> | null = null
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatBody = JSON.parse(await readBody(request)) as Record<string, unknown>
    writeSse(
      response,
      'data: {"choices":[{"delta":{"content":"{\\"schemaVersion\\":1}"}}]}\n\n' +
        'data: [DONE]\n\n',
    )
  })
  try {
    const model = new MagpieChatModel({
      baseUrl: harness.baseUrl,
      model: MODEL_ID,
      maxOutputTokens: 4096,
      timeoutMs: 5_000,
      maxRetries: 0,
    })
    await model.checkAvailable()
    await collect(model)
    assert.ok(chatBody !== null)
    assert.equal(Object.hasOwn(chatBody, 'reasoning_effort'), false)
  } finally {
    await harness.close()
  }
})

test('sends a response prefill as the final assistant message', async () => {
  let chatBody: Record<string, unknown> | null = null
  const prefill = '{"schemaVersion":1,"reply":"'
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatBody = JSON.parse(await readBody(request)) as Record<string, unknown>
    const payload = JSON.stringify({
      choices: [{ delta: { content: `${prefill}收到喵。"}` } }],
    })
    writeSse(response, `data: ${payload}\n\ndata: [DONE]\n\n`)
  })
  try {
    const model = await checkedModel(harness)
    const events = await collectWithPrefill(model, prefill)
    const text = events
      .filter((event): event is Extract<ChatModelStreamEvent, { type: 'text' }> =>
        event.type === 'text',
      )
      .map(event => event.text)
      .join('')
    assert.equal(text, `${prefill}收到喵。"}`)
    assert.ok(chatBody !== null)
    const messages = chatBody.messages as Array<{ role: string; content: string }>
    assert.equal(messages.length, 3)
    assert.deepEqual(messages.at(-1), { role: 'assistant', content: prefill })
  } finally {
    await harness.close()
  }
})

test('does not treat a prefill-only stream as visible output', async () => {
  const prefill = '{"schemaVersion":1,"reply":"'
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    await readBody(request)
    writeSse(
      response,
      `data: {"choices":[{"delta":{"content":${JSON.stringify(prefill)}}}]}\n\n` +
        'data: [DONE]\n\n',
    )
  })
  try {
    const model = await checkedModel(harness)
    await assert.rejects(
      collectWithPrefill(model, prefill),
      (error: unknown) =>
        error instanceof ChatModelError &&
        error.code === 'model_empty_response',
    )
  } finally {
    await harness.close()
  }
})

test('rejects a reasoning effort the upstream model does not declare', async () => {
  const harness = await startServer((_request, response) => {
    writeJson(response, 200, {
      data: [
        {
          id: MODEL_ID,
          max_output_tokens: 393216,
          reasoning_levels: ['none', 'high'],
        },
      ],
    })
  })
  try {
    const model = new MagpieChatModel({
      baseUrl: harness.baseUrl,
      model: MODEL_ID,
      maxOutputTokens: 4096,
      timeoutMs: 2_000,
      maxRetries: 0,
      reasoningEffort: 'low',
    })
    await assert.rejects(
      model.checkAvailable(),
      (error: unknown) =>
        error instanceof ChatModelError &&
        error.code === 'model_reasoning_effort_unsupported',
    )
  } finally {
    await harness.close()
  }
})

test('startup check requires the exact configured model and honest output limits', async () => {
  const harness = await startServer((_request, response) => {
    writeJson(response, 200, {
      data: [
        {
          id: 'auto/preferred',
          max_output_tokens: 128000,
          pricing: { prompt: '1', completion: '1' },
        },
      ],
    })
  })
  try {
    const missing = new MagpieChatModel({
      baseUrl: harness.baseUrl,
      model: MODEL_ID,
      maxOutputTokens: 4096,
      timeoutMs: 2_000,
      maxRetries: 0,
    })
    await assert.rejects(
      missing.checkAvailable(),
      (error: unknown) =>
        error instanceof ChatModelError && error.code === 'model_not_found',
    )
  } finally {
    await harness.close()
  }
})

test('retries transient HTTP failures before the first text token', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatRequests += 1
    if (chatRequests === 1) {
      writeJson(response, 500, {
        error: { message: 'UPSTREAM-SECRET-BODY' },
      })
      return
    }
    writeSse(response, 'data: {"choices":[{"delta":{"content":"重试成功。"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n')
  })
  try {
    const model = await checkedModel(harness, { maxRetries: 2, retryBaseDelayMs: 0 })
    const events = await collect(model)
    assert.equal(chatRequests, 2)
    const result = events.find(event => event.type === 'result')
    assert.ok(result?.type === 'result')
    assert.equal(result.result.attempts, 2)
    assert.equal(
      events.filter(event => event.type === 'text').map(event => event.text).join(''),
      '重试成功。',
    )
  } finally {
    await harness.close()
  }
})

test('retries an empty visible stream and succeeds on the next attempt', async () => {
  let chatRequests = 0
  const systemPrompts: string[] = []
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    const body = JSON.parse(await readBody(request)) as {
      messages?: Array<{ role?: string; content?: string }>
    }
    systemPrompts.push(
      body.messages?.find(message => message.role === 'system')?.content ?? '',
    )
    chatRequests += 1
    if (chatRequests === 1) {
      writeSse(
        response,
        'data: {"choices":[{"delta":{"reasoning_content":"ONLY-REASONING","content":"  "}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n' +
          'data: [DONE]\n\n',
      )
      return
    }
    writeSse(
      response,
      'data: {"choices":[{"delta":{"content":"第二次有正文。"}}]}\n\n' +
        'data: [DONE]\n\n',
    )
  })
  try {
    const model = await checkedModel(harness, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
    const events = await collect(model)
    assert.equal(chatRequests, 2)
    assert.equal(systemPrompts[0]?.includes('可见正文纠错'), false)
    assert.equal(systemPrompts[1]?.includes('可见正文纠错'), true)
    assert.equal(systemPrompts[1]?.includes('至少一个非空白字符'), true)
    const result = events.find(event => event.type === 'result')
    assert.ok(result?.type === 'result')
    assert.equal(result.result.attempts, 2)
    assert.equal(
      events
        .filter(event => event.type === 'text')
        .map(event => event.text)
        .join('')
        .trim(),
      '第二次有正文。',
    )
    assert.equal(JSON.stringify(events).includes('ONLY-REASONING'), false)
  } finally {
    await harness.close()
  }
})

test('a stream with no visible text in every attempt fails explicitly', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatRequests += 1
    writeSse(
      response,
      'data: {"choices":[{"delta":{"reasoning_content":"NO-VISIBLE-TEXT","content":""}}]}\n\n' +
        'data: [DONE]\n\n',
    )
  })
  try {
    const model = await checkedModel(harness, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
    await assert.rejects(
      collect(model),
      (error: unknown) =>
        error instanceof ChatModelError &&
        error.code === 'model_empty_response' &&
        error.attempts === 2,
    )
    assert.equal(chatRequests, 2)
  } finally {
    await harness.close()
  }
})

test('does not retry after text has reached the consumer', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatRequests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    response.write('data: {"choices":[{"delta":{"content":"已经输出"}}]}\n\n')
    setTimeout(() => {
      response.destroy(new Error('fake connection loss'))
    }, 20)
  })
  try {
    const model = await checkedModel(harness, { maxRetries: 3, retryBaseDelayMs: 0 })
    const events: ChatModelStreamEvent[] = []
    await assert.rejects(async () => {
      for await (const event of model.stream(requestFor(model))) {
        events.push(event)
      }
    })
    assert.equal(chatRequests, 1)
    assert.equal(
      events.filter(event => event.type === 'text').map(event => event.text).join(''),
      '已经输出',
    )
  } finally {
    await harness.close()
  }
})

test('times out each attempt and reports a bounded retry count', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatRequests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    // 故意永不结束；请求控制器应在每次 attempt 超时时释放它。
  })
  try {
    const model = await checkedModel(harness, {
      timeoutMs: 120,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
    await assert.rejects(
      collect(model),
      (error: unknown) =>
        error instanceof ChatModelError &&
        error.code === 'model_timeout' &&
        error.attempts === 2,
    )
    assert.equal(chatRequests, 2)
  } finally {
    await harness.close()
  }
})

test('external cancellation aborts without retry or fallback', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatRequests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
  })
  try {
    const model = await checkedModel(harness, { maxRetries: 3, retryBaseDelayMs: 0 })
    const controller = new AbortController()
    const pending = collect(model, controller.signal)
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    assert.equal(chatRequests, 1)
  } finally {
    await harness.close()
  }
})

test('malformed SSE JSON is a non-retryable protocol error', async () => {
  let chatRequests = 0
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    chatRequests += 1
    writeSse(response, 'data: {not-json}\n\ndata: [DONE]\n\n')
  })
  try {
    const model = await checkedModel(harness, { maxRetries: 3, retryBaseDelayMs: 0 })
    await assert.rejects(
      collect(model),
      (error: unknown) =>
        error instanceof ChatModelError &&
        error.code === 'model_protocol_error' &&
        error.attempts === 1,
    )
    assert.equal(chatRequests, 1)
  } finally {
    await harness.close()
  }
})

test('upstream errors do not leak their response body or credentials', async () => {
  const secret = 'UPSTREAM-SECRET-BODY'
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeModels(response)
      return
    }
    writeJson(response, 401, { error: { message: secret } })
  })
  try {
    const model = await checkedModel(harness, {
      maxRetries: 0,
      apiKey: 'never-log-me',
    })
    await assert.rejects(
      collect(model),
      (error: unknown) => {
        assert.ok(error instanceof ChatModelError)
        assert.equal(error.code, 'model_auth_failed')
        assert.equal(error.message.includes(secret), false)
        assert.equal(error.message.includes('never-log-me'), false)
        return true
      },
    )
  } finally {
    await harness.close()
  }
})

async function checkedModel(
  harness: ServerHarness,
  overrides: Partial<ConstructorParameters<typeof MagpieChatModel>[0]> = {},
): Promise<MagpieChatModel> {
  const model = new MagpieChatModel({
    baseUrl: harness.baseUrl,
    model: MODEL_ID,
    maxOutputTokens: 4096,
    timeoutMs: 5_000,
    maxRetries: 0,
    reasoningEffort: 'low',
    ...overrides,
  })
  await model.checkAvailable()
  return model
}

function requestFor(model: MagpieChatModel, jsonMode = true) {
  return {
    systemPrompt: '占位测试人格',
    messages: [{ role: 'user' as const, text: '虚构测试消息' }],
    jsonMode,
    signal: new AbortController().signal,
  }
}

async function collect(
  model: MagpieChatModel,
  signal: AbortSignal = new AbortController().signal,
  jsonMode = true,
): Promise<ChatModelStreamEvent[]> {
  const events: ChatModelStreamEvent[] = []
  for await (const event of model.stream({
    ...requestFor(model, jsonMode),
    signal,
  })) {
    events.push(event)
  }
  return events
}

async function collectWithPrefill(
  model: MagpieChatModel,
  responsePrefill: string,
): Promise<ChatModelStreamEvent[]> {
  const events: ChatModelStreamEvent[] = []
  for await (const event of model.stream({
    ...requestFor(model),
    responsePrefill,
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  return events
}

interface ServerHarness {
  baseUrl: string
  close(): Promise<void>
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
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

function writeModels(response: ServerResponse): void {
  writeJson(response, 200, {
    data: [
      {
        id: MODEL_ID,
        max_output_tokens: 393216,
        reasoning_levels: ['none', 'low', 'high', 'max'],
        pricing: {
          prompt: '0.00000015',
          completion: '0.0000006',
          input_cache_read: '0.000000003',
        },
      },
    ],
  })
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  response.end(body)
}

function writeSse(response: ServerResponse, payload: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
  response.end(payload)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
