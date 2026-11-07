/**
 * 模型 provider 工厂集成测试。
 *
 * 用本机临时 OpenAI-compatible 服务验证第三方路由不依赖 Magpie；同时覆盖
 * 缺凭据、缺 DSH 宿主接口、精确模型与视觉图片能力的 fail-closed 行为。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  SystemConfig,
  VisionConfig,
} from '../../src/core/config/index.ts'
import {
  createChatModelFromConfig,
  createVisionModelFromConfig,
} from '../../src/model-providers/index.ts'

const MODEL_ID = 'acme/chat-test'

interface HttpHarness {
  baseUrl: string
  close(): Promise<void>
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<HttpHarness> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

function chatConfig(
  baseUrl: string | null,
  overrides: Partial<SystemConfig['model']> = {},
): SystemConfig['model'] {
  return {
    provider: 'openai-compatible',
    route: null,
    name: MODEL_ID,
    baseUrl,
    apiKeyEnv: null,
    apiKeySecret: null,
    allowPrivateNetwork: true,
    timeoutMs: 2_000,
    maxRetries: 0,
    maxOutputTokens: 256,
    reasoningEffort: null,
    ...overrides,
  }
}

function visionConfig(
  baseUrl: string,
  overrides: Partial<VisionConfig> = {},
): VisionConfig {
  return {
    enabled: true,
    provider: 'openai-compatible',
    route: null,
    name: MODEL_ID,
    baseUrl,
    apiKeyEnv: null,
    apiKeySecret: null,
    allowPrivateNetwork: true,
    timeoutMs: 2_000,
    maxRetries: 0,
    maxOutputTokens: 256,
    maxImageBytes: 1024 * 1024,
    maxDescriptionChars: 500,
    ...overrides,
  }
}

test('openai-compatible chat works without Magpie and does not send its session header', async () => {
  let modelsHeaders: IncomingMessage['headers'] | null = null
  let chatHeaders: IncomingMessage['headers'] | null = null
  let chatBody: Record<string, unknown> | null = null
  const harness = await startServer(async (request, response) => {
    if (request.url === '/v1/models') {
      modelsHeaders = request.headers
      writeJson(response, 200, {
        data: [{ id: MODEL_ID, max_output_tokens: 1024 }],
      })
      return
    }
    if (request.url === '/v1/chat/completions') {
      chatHeaders = request.headers
      chatBody = JSON.parse(await readBody(request)) as Record<string, unknown>
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
      })
      response.end(
        [
          'data: {"choices":[{"delta":{"content":"第三方可用"}}]}\r\n\r\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
          'data: [DONE]\r\n\r\n',
        ].join(''),
      )
      return
    }
    writeJson(response, 404, { error: { message: 'not found' } })
  })
  const configDir = mkdtempSync(join(tmpdir(), 'kanobot-provider-factory-'))

  try {
    const model = await createChatModelFromConfig(chatConfig(harness.baseUrl), {
      configDir,
      apiKeyOverride: 'third-party-key',
    })
    assert.equal(model.provider, 'openai-compatible')
    assert.equal(model.mode, 'openai-compatible')
    assert.equal(model.id, MODEL_ID)

    const controller = new AbortController()
    let text = ''
    for await (const event of model.stream({
      systemPrompt: 'system',
      messages: [{ role: 'user', text: 'hello' }],
      signal: controller.signal,
    })) {
      if (event.type === 'text') text += event.text
    }
    assert.equal(text, '第三方可用')
    assert.equal(modelsHeaders?.authorization, 'Bearer third-party-key')
    assert.equal(modelsHeaders?.['x-magpie-session'], undefined)
    assert.equal(chatHeaders?.['x-magpie-session'], undefined)
    assert.equal(chatHeaders?.authorization, 'Bearer third-party-key')
    assert.equal(chatBody?.model, MODEL_ID)
  } finally {
    await harness.close()
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('provider factories fail closed for missing credentials and host capabilities', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'kanobot-provider-fail-'))
  try {
    await assert.rejects(
      () =>
        createChatModelFromConfig(
          chatConfig('http://127.0.0.1:1/v1', {
            apiKeyEnv: 'KANOBOT_TEST_MISSING_KEY',
          }),
          { configDir },
        ),
      /environment variable is empty or missing/,
    )

    await assert.rejects(
      () =>
        createChatModelFromConfig(
          chatConfig(null, {
            provider: 'dsh',
            route: 'route-a',
          }),
          { configDir },
        ),
      /host does not expose ctx\.llm/,
    )

    await assert.rejects(
      () =>
        createChatModelFromConfig(
          chatConfig(null, {
            provider: 'dsh',
            route: null,
          }),
          { configDir },
        ),
      /requires an exact provider route/,
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('vision factory requires an exact model with explicit image input', async () => {
  const harness = await startServer((request, response) => {
    if (request.url === '/v1/models') {
      writeJson(response, 200, {
        data: [{ id: MODEL_ID, max_output_tokens: 1024 }],
      })
      return
    }
    writeJson(response, 404, { error: { message: 'not found' } })
  })
  const configDir = mkdtempSync(join(tmpdir(), 'kanobot-vision-factory-'))
  try {
    await assert.rejects(
      () =>
        createVisionModelFromConfig(visionConfig(harness.baseUrl), {
          configDir,
        }),
      /explicitly advertise image input/,
    )
    await assert.rejects(
      () =>
        createVisionModelFromConfig(
          visionConfig(harness.baseUrl, { name: 'acme/missing-vision' }),
          { configDir },
        ),
      /does not contain exact vision model/,
    )
  } finally {
    await harness.close()
    rmSync(configDir, { recursive: true, force: true })
  }
})

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json',
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
