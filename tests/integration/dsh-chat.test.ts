/**
 * DSH 模型适配器集成测试。
 *
 * 使用窄接口 fake 验证宿主演进边界：精确 route/model、能力声明、单次
 * prepared call、有限重试、usage 和错误映射；不连接真实 DSH 或模型。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ChatModelError,
  type ChatModelRequest,
} from '../../src/core/chat/index.ts'
import { DshChatModel } from '../../src/model-providers/index.ts'
import type {
  DshGenerateOptions,
  DshLlmBridge,
  DshPreparedCall,
  DshResolvedModelInfo,
  DshStreamChunk,
} from '../../src/model-providers/dsh-types.ts'

interface FakeBridge {
  llm: DshLlmBridge
  preparedConfigs: unknown[]
  dispatchedOptions: DshGenerateOptions[]
}

function modelInfo(
  overrides: Partial<DshResolvedModelInfo> = {},
): DshResolvedModelInfo {
  return {
    provider: 'route-a',
    id: 'model-a',
    name: 'Model A',
    inputModalities: ['text'],
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
    },
    ...overrides,
  }
}

function createBridge(
  info: DshResolvedModelInfo,
  responses: DshStreamChunk[][],
): FakeBridge {
  const preparedConfigs: unknown[] = []
  const dispatchedOptions: DshGenerateOptions[] = []
  let dispatch = 0

  const llm: DshLlmBridge = {
    listProviders() {
      return [{ id: info.provider, name: 'Route A' }]
    },
    async listModels() {
      return [info]
    },
    async resolveModelInfo() {
      return info
    },
    async prepareCall(config) {
      preparedConfigs.push(config)
      const prepared: DshPreparedCall = {
        model: info,
        async *stream(options) {
          dispatchedOptions.push(options)
          const chunks = responses[dispatch]
          dispatch += 1
          if (chunks === undefined) {
            throw new Error('fake bridge received an unexpected dispatch')
          }
          for (const chunk of chunks) yield chunk
        },
      }
      return prepared
    },
    async *stream() {
      throw new Error('tests must dispatch through prepareCall')
    },
  }
  return { llm, preparedConfigs, dispatchedOptions }
}

function request(overrides: Partial<ChatModelRequest> = {}): ChatModelRequest {
  return {
    systemPrompt: 'system',
    messages: [{ role: 'user', text: 'hello' }],
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function collect(
  model: DshChatModel,
  input: ChatModelRequest,
): Promise<{ text: string; result: unknown }> {
  let text = ''
  let result: unknown = null
  for await (const event of model.stream(input)) {
    if (event.type === 'text') text += event.text
    else result = event.result
  }
  return { text, result }
}

test('DSH requires the exact route and model and explicit reasoning support', async () => {
  const bridge = createBridge(modelInfo(), [
    [
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ])
  const model = new DshChatModel({
    llm: bridge.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
    reasoningEffort: 'low',
  })

  await model.checkAvailable()
  assert.deepEqual(bridge.preparedConfigs[0], {
    provider: 'route-a',
    model: 'model-a',
    maxTokens: 256,
    reasoningEffort: 'low',
  })

  const missingRoute = new DshChatModel({
    llm: bridge.llm,
    route: 'route-missing',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
  })
  await assert.rejects(
    () => missingRoute.checkAvailable(),
    (error: unknown) =>
      error instanceof ChatModelError && error.code === 'model_not_found',
  )

  const noText = createBridge(
    modelInfo({ inputModalities: ['image'] }),
    [],
  )
  const textModel = new DshChatModel({
    llm: noText.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
  })
  await assert.rejects(
    () => textModel.checkAvailable(),
    (error: unknown) =>
      error instanceof ChatModelError &&
      error.code === 'model_input_not_supported',
  )

  const noReasoning = createBridge(
    modelInfo({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
    [],
  )
  const reasoningModel = new DshChatModel({
    llm: noReasoning.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
    reasoningEffort: 'low',
  })
  await assert.rejects(
    () => reasoningModel.checkAvailable(),
    (error: unknown) =>
      error instanceof ChatModelError &&
      error.code === 'model_reasoning_effort_unsupported',
  )
})

test('DSH streams visible text and usage without leaking reasoning', async () => {
  const bridge = createBridge(modelInfo(), [
    [
      { type: 'reasoning-delta', index: 0, text: 'private chain' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '你好' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          reasoningTokens: 4,
          totalTokens: 15,
        },
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'text', text: '你好' },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ])
  const model = new DshChatModel({
    llm: bridge.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
  })
  await model.checkAvailable()

  const { text, result } = await collect(model, request())
  assert.equal(text, '你好')
  assert.deepEqual(result, {
    attempts: 1,
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      reasoningTokens: 4,
      totalTokens: 15,
    },
    estimatedCost: null,
    pricing: null,
    responseId: null,
  })
  assert.equal(bridge.preparedConfigs.length, 2)
  assert.equal(bridge.dispatchedOptions.length, 1)
})

test('DSH does not pretend to support assistant prefill', async () => {
  const bridge = createBridge(modelInfo(), [])
  const model = new DshChatModel({
    llm: bridge.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
  })
  await model.checkAvailable()
  await assert.rejects(
    () => collect(model, request({ responsePrefill: '{"reply":"' })),
    (error: unknown) =>
      error instanceof ChatModelError &&
      error.code === 'model_capability_unsupported',
  )
  assert.equal(bridge.dispatchedOptions.length, 0)
})

test('DSH prepares every retry and only retries before visible text', async () => {
  const bridge = createBridge(modelInfo(), [
    [
      { type: 'reasoning-delta', index: 0, text: 'empty attempt' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    [
      { type: 'text-delta', index: 0, text: 'recovered' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ])
  const model = new DshChatModel({
    llm: bridge.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 1,
    retryBaseDelayMs: 0,
  })
  await model.checkAvailable()

  const { text, result } = await collect(model, request())
  assert.equal(text, 'recovered')
  assert.equal((result as { attempts: number }).attempts, 2)
  // 一次启动检查加两次独立 attempt；不能复用被派发过的 prepared call。
  assert.equal(bridge.preparedConfigs.length, 3)
  assert.equal(bridge.dispatchedOptions.length, 2)
})

test('DSH reports an explicit empty response after bounded retries', async () => {
  const empty = [
    { type: 'finish', reason: { kind: 'stop' } } as DshStreamChunk,
  ]
  const bridge = createBridge(modelInfo(), [empty, empty])
  const model = new DshChatModel({
    llm: bridge.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 1,
    retryBaseDelayMs: 0,
  })
  await model.checkAvailable()

  await assert.rejects(
    () => collect(model, request()),
    (error: unknown) =>
      error instanceof ChatModelError &&
      error.code === 'model_empty_response' &&
      error.attempts === 2,
  )
  assert.equal(bridge.dispatchedOptions.length, 2)
})

test('DSH maps terminal failures without copying upstream messages', async () => {
  const bridge = createBridge(modelInfo(), [
    [
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'AUTH',
            message: 'secret-token-value must not leak',
          },
        },
      },
    ],
  ])
  const model = new DshChatModel({
    llm: bridge.llm,
    route: 'route-a',
    model: 'model-a',
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    maxRetries: 0,
  })
  await model.checkAvailable()

  await assert.rejects(
    () => collect(model, request()),
    (error: unknown) => {
      assert.ok(error instanceof ChatModelError)
      assert.equal(error.code, 'model_auth_failed')
      assert.doesNotMatch(error.message, /secret-token-value/)
      return true
    },
  )
})
