/**
 * DSH 宿主模型适配器。
 *
 * DSH 的 `ctx.llm.stream()` 是单次 provider attempt，不经过 agent-loop 的
 * 持久重试；因此这里只在尚未输出任何可见正文时做有限重试。DSH 当前
 * GenerateOptions 没有 assistant prefill 或 JSON response_format，适配器
 * 显式声明不支持这两项，聊天服务会退回“提示词约束 + 严格解析”，不会伪造
 * 预填结果。
 */

import { randomUUID } from 'node:crypto'

import {
  ChatModelError,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelResult,
  type ChatModelStreamEvent,
  type ChatUsage,
} from '../core/chat/index.ts'
import type {
  DshGenerateOptions,
  DshLlmBridge,
  DshPreparedCall,
  DshResolvedModelInfo,
  DshStreamChunk,
} from './dsh-types.ts'

const DEFAULT_RETRY_BASE_MS = 250
const MAX_RETRY_DELAY_MS = 4_000
const REPAIR_PROMPT = `

## 可见正文纠错（本轮重试）
上一次生成没有产生任何可见正文。请直接输出符合上方要求的完整内容；
reply 必须包含至少一个非空白字符。不要只输出空白、推理过程或解释。`

export interface DshChatModelOptions {
  llm: DshLlmBridge
  route: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
  maxRetries: number
  reasoningEffort?: string | null
  retryBaseDelayMs?: number
}

interface AttemptState {
  emittedText: boolean
}

export class DshChatModel implements ChatModel {
  readonly id: string
  readonly mode = 'dsh'
  readonly provider: string
  readonly capabilities = {
    responsePrefill: false,
    jsonMode: false,
  } as const

  private readonly llm: DshLlmBridge
  private readonly route: string
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly reasoningEffort: string | null
  private readonly retryBaseDelayMs: number
  private resolved: DshResolvedModelInfo | null = null

  constructor(options: DshChatModelOptions) {
    this.llm = options.llm
    this.route = validateLabel(options.route, 'route')
    this.provider = this.route
    this.id = validateLabel(options.model, 'model')
    this.maxOutputTokens = validatePositiveInteger(
      options.maxOutputTokens,
      'maxOutputTokens',
    )
    this.timeoutMs = validatePositiveInteger(options.timeoutMs, 'timeoutMs')
    if (
      !Number.isInteger(options.maxRetries) ||
      options.maxRetries < 0 ||
      options.maxRetries > 5
    ) {
      throw new RangeError('maxRetries must be an integer between 0 and 5')
    }
    this.maxRetries = options.maxRetries
    this.reasoningEffort =
      options.reasoningEffort === undefined ||
      options.reasoningEffort === null
        ? null
        : validateLabel(options.reasoningEffort, 'reasoningEffort')
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS
  }

  async checkAvailable(signal?: AbortSignal): Promise<void> {
    const providers = this.llm.listProviders()
    if (!providers.some(provider => provider.id === this.route)) {
      throw new ChatModelError(
        'model_not_found',
        `DSH does not have a provider route named "${this.route}"`,
        1,
      )
    }

    let model: DshResolvedModelInfo
    try {
      model = await this.llm.resolveModelInfo(
        this.route,
        this.id,
        signal,
      )
    } catch (error) {
      throw normalizeDshFailure(error, 1)
    }
    if (
      model.inputModalities === undefined ||
      !model.inputModalities.includes('text')
    ) {
      throw new ChatModelError(
        'model_input_not_supported',
        `DSH model "${this.id}" does not explicitly declare text input`,
        1,
      )
    }
    if (
      this.reasoningEffort !== null &&
      (
        model.reasoning === undefined ||
        !model.reasoning.efforts.some(
          effort => effort.id === this.reasoningEffort,
        )
      )
    ) {
      throw new ChatModelError(
        'model_reasoning_effort_unsupported',
        `DSH model "${this.id}" does not declare reasoning effort "${this.reasoningEffort}"`,
        1,
      )
    }
    try {
      // prepareCall 会把输出上限、推理强度和精确路由一起交给 DSH 校验，
      // 比只看模型列表更接近真正请求时的边界。
      await this.llm.prepareCall(
        {
          provider: this.route,
          model: this.id,
          maxTokens: this.maxOutputTokens,
          ...(this.reasoningEffort === null
            ? {}
            : { reasoningEffort: this.reasoningEffort }),
        },
        signal,
      )
    } catch (error) {
      throw normalizeDshFailure(error, 1)
    }
    this.resolved = model
  }

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    if (this.resolved === null) {
      throw new ChatModelError(
        'model_check_required',
        'DSH model availability must be checked before streaming',
        0,
      )
    }
    if (request.responsePrefill !== undefined) {
      throw new ChatModelError(
        'model_capability_unsupported',
        'the DSH provider does not support assistant response prefill',
        0,
      )
    }

    let lastError: ChatModelError | null = null
    let repair = false
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      if (request.signal.aborted) throw abortError()
      const state: AttemptState = { emittedText: false }
      try {
        const result = yield* this.streamAttempt(
          request,
          attempt,
          state,
          repair,
        )
        yield { type: 'result', result }
        return
      } catch (error) {
        if (request.signal.aborted) throw abortError()
        const normalized = normalizeDshFailure(error, attempt)
        lastError = normalized
        if (normalized.code === 'model_empty_response') repair = true
        if (
          state.emittedText ||
          attempt >= this.maxRetries + 1 ||
          !isRetryable(normalized.code)
        ) {
          throw normalized
        }
        await sleep(this.retryDelay(attempt), request.signal)
      }
    }
    throw lastError ?? new ChatModelError(
      'model_failed',
      'DSH request failed without a diagnostic',
      this.maxRetries + 1,
    )
  }

  private async *streamAttempt(
    request: ChatModelRequest,
    attempt: number,
    state: AttemptState,
    repair: boolean,
  ): AsyncGenerator<ChatModelStreamEvent, ChatModelResult> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const combined = AbortSignal.any([request.signal, controller.signal])
    let prepared: DshPreparedCall
    try {
      // DSH 明确约束 prepared call 只能派发一次；每次重试必须重新准备，
      // 同时让本次 attempt 的超时也覆盖准备阶段。
      prepared = await this.llm.prepareCall(
        {
          provider: this.route,
          model: this.id,
          maxTokens: this.maxOutputTokens,
          ...(this.reasoningEffort === null
            ? {}
            : { reasoningEffort: this.reasoningEffort }),
        },
        combined,
      )
    } catch (error) {
      clearTimeout(timeout)
      if (request.signal.aborted) throw abortError()
      if (timedOut) {
        throw new ChatModelError(
          'model_timeout',
          `DSH request preparation exceeded ${this.timeoutMs} ms`,
          attempt,
        )
      }
      throw normalizeDshFailure(error, attempt)
    }
    const options: DshGenerateOptions = {
      provider: this.route,
      model: this.id,
      system: repair
        ? `${request.systemPrompt}${REPAIR_PROMPT}`
        : request.systemPrompt,
      messages: request.messages.map(message =>
        message.role === 'user'
          ? {
              role: 'user' as const,
              content: [{ type: 'text' as const, text: message.text }],
            }
          : {
              role: 'assistant' as const,
              id: randomUUID(),
              content: [{ type: 'text' as const, text: message.text }],
              source: {
                kind: 'model' as const,
                provider: this.route,
                model: this.id,
              },
            }
      ),
      maxTokens: this.maxOutputTokens,
      ...(this.reasoningEffort === null
        ? {}
        : { reasoningEffort: this.reasoningEffort }),
      signal: combined,
    }

    const textIndexes = new Set<number>()
    let text = ''
    let usage: ChatUsage | null = null
    let finished = false
    try {
      for await (const chunk of prepared.stream(options)) {
        if (request.signal.aborted) throw abortError()
        switch (chunk.type) {
          case 'text-delta': {
            const value = chunk as Extract<DshStreamChunk, { type: 'text-delta' }>
            if (value.text === '') {
              throw protocolError('DSH emitted an empty text delta', attempt)
            }
            textIndexes.add(value.index)
            text += value.text
            state.emittedText = text.trim() !== ''
            yield { type: 'text', text: value.text }
            break
          }
          case 'block-end': {
            const value = chunk as Extract<DshStreamChunk, { type: 'block-end' }>
            if (
              value.block.type === 'text' &&
              !textIndexes.has(value.index) &&
              typeof value.block.text === 'string' &&
              value.block.text !== ''
            ) {
              text += value.block.text
              state.emittedText = text.trim() !== ''
              yield { type: 'text', text: value.block.text }
            }
            break
          }
          case 'usage': {
            const value = chunk as Extract<DshStreamChunk, { type: 'usage' }>
            usage = normalizeUsage(value.usage)
            break
          }
          case 'finish': {
            const value = chunk as Extract<DshStreamChunk, { type: 'finish' }>
            if (value.reason.kind === 'error') {
              throw dshFinishError(value.reason.failure.code, attempt)
            }
            if (value.reason.kind === 'aborted') {
              if (request.signal.aborted) throw abortError()
              throw new ChatModelError(
                timedOut ? 'model_timeout' : 'model_aborted',
                timedOut
                  ? `DSH request exceeded ${this.timeoutMs} ms`
                  : 'DSH model request was aborted',
                attempt,
              )
            }
            if (value.reason.kind === 'tool-calls') {
              throw protocolError(
                'DSH returned tool calls although Kanobot exposes no tools',
                attempt,
              )
            }
            finished = true
            break
          }
          default:
            // reasoning-delta、block-start 和协议扩展块不进入正文。
            break
        }
      }
    } catch (error) {
      if (request.signal.aborted) throw abortError()
      if (timedOut) {
        throw new ChatModelError(
          'model_timeout',
          `DSH request exceeded ${this.timeoutMs} ms`,
          attempt,
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }

    if (!finished) {
      throw protocolError('DSH stream ended without a finish chunk', attempt)
    }
    if (text.trim() === '') {
      throw new ChatModelError(
        'model_empty_response',
        'DSH returned no visible text content',
        attempt,
      )
    }
    return {
      attempts: attempt,
      usage,
      estimatedCost: null,
      pricing: null,
      responseId: null,
    }
  }

  private retryDelay(failedAttempt: number): number {
    return Math.min(
      this.retryBaseDelayMs * 2 ** (failedAttempt - 1),
      MAX_RETRY_DELAY_MS,
    )
  }
}

function normalizeUsage(
  usage: Extract<DshStreamChunk, { type: 'usage' }>['usage'],
): ChatUsage {
  const inputTokens = nonNegative(usage.inputTokens)
  const outputTokens = nonNegative(usage.outputTokens)
  const cacheReadTokens = nonNegative(usage.cacheReadTokens ?? 0)
  const cacheWriteTokens = nonNegative(usage.cacheWriteTokens ?? 0)
  const reasoningTokens = nonNegative(usage.reasoningTokens ?? 0)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: nonNegative(
      usage.totalTokens ?? inputTokens + outputTokens,
    ),
  }
}

function normalizeDshFailure(error: unknown, attempts: number): ChatModelError {
  if (error instanceof ChatModelError) {
    if (error.attempts === attempts) return error
    return new ChatModelError(error.code, error.message, attempts)
  }
  const candidate = error as {
    code?: unknown
    status?: unknown
  }
  const code = typeof candidate.code === 'string'
    ? candidate.code
    : 'model_failed'
  const mapped = mapDshCode(code)
  return new ChatModelError(
    mapped,
    `DSH model request failed (${code})`,
    attempts,
  )
}

function dshFinishError(code: string, attempts: number): ChatModelError {
  const mapped = mapDshCode(code)
  return new ChatModelError(
    mapped,
    `DSH model request failed (${code})`,
    attempts,
  )
}

function mapDshCode(code: string): string {
  switch (code) {
    case 'AUTH':
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
      return 'model_auth_failed'
    case 'RATE_LIMIT':
      return 'model_rate_limited'
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return 'model_quota_exceeded'
    case 'TIMEOUT':
      return 'model_timeout'
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 'model_context_exceeded'
    case 'NO_ADAPTER':
      return 'model_not_found'
    case 'CANCELLED':
    case 'ABORTED':
      return 'model_aborted'
    default:
      return 'model_failed'
  }
}

function isRetryable(code: string): boolean {
  return (
    code === 'model_rate_limited' ||
    code === 'model_timeout' ||
    code === 'model_quota_exceeded' ||
    code === 'model_empty_response' ||
    code === 'model_failed'
  )
}

function protocolError(message: string, attempts: number): ChatModelError {
  return new ChatModelError('model_protocol_error', message, attempts)
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('DSH usage contains a negative or non-finite count')
  }
  return Math.trunc(value)
}

function validateLabel(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty single-line label`)
  }
  return value
}

function validatePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`)
  }
  return value
}

function abortError(): Error {
  const error = new Error('DSH model request aborted')
  error.name = 'AbortError'
  return error
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal.aborted) throw abortError()
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
