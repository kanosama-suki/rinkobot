/**
 * Magpie 本地模型路由的 OpenAI-compatible chat/completions 驱动。
 *
 * 边界：
 * - 只连接配置校验过的回环地址，并在启动时确认精确模型存在；
 * - 解析 SSE 的文本、usage 和 [DONE]，不转发 reasoning 内容；
 * - 超时、取消、重试都在网关层收口，已有正文输出后绝不重试；
 * - 错误只暴露分类和尝试次数，不保留上游响应正文或凭据。
 */

import {
  ChatModelError,
  type ChatModel,
  type ChatModelPricing,
  type ChatModelRequest,
  type ChatModelResult,
  type ChatModelStreamEvent,
  type ChatUsage,
} from './types.ts'

const DEFAULT_RETRY_BASE_MS = 250
const MAX_RETRY_DELAY_MS = 4_000
const MODEL_CHECK_TIMEOUT_MS = 10_000
const SESSION_HEADER = 'X-Magpie-Session'

export interface MagpieChatModelOptions {
  baseUrl: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
  maxRetries: number
  apiKey?: string | null
  retryBaseDelayMs?: number
  sessionId?: string
}

interface MagpieModelDescriptor {
  pricing: ChatModelPricing | null
  maxOutputTokens: number | null
}

interface AttemptState {
  emittedText: boolean
}

/**
 * 启动检查成功后，pricing 固定为启动时看到的模型价格；运行中不静默换模型。
 */
export class MagpieChatModel implements ChatModel {
  readonly id: string
  readonly mode = 'magpie'
  readonly provider = 'magpie'

  private readonly baseUrl: string
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly apiKey: string | null
  private readonly retryBaseDelayMs: number
  private readonly sessionId: string
  private pricing: ChatModelPricing | null = null
  private checked = false

  constructor(options: MagpieChatModelOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
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
    this.retryBaseDelayMs =
      options.retryBaseDelayMs === undefined
        ? DEFAULT_RETRY_BASE_MS
        : validateNonNegativeInteger(
            options.retryBaseDelayMs,
            'retryBaseDelayMs',
          )
    this.sessionId = validateLabel(
      options.sessionId ?? 'kanobot',
      'sessionId',
    )
    this.apiKey =
      options.apiKey === undefined || options.apiKey === null
        ? null
        : validateSecret(options.apiKey)
  }

  /**
   * 只接受精确模型 ID。`auto/*` 路由组必须由用户明确改配置才会启用。
   */
  async checkAvailable(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Math.min(this.timeoutMs, MODEL_CHECK_TIMEOUT_MS))
    const combined = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal])

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers('application/json'),
        signal: combined,
      })
      if (!response.ok) {
        await cancelBody(response)
        throw httpStatusError(response.status, 1)
      }
      const payload = await readJson(response)
      const models = modelList(payload)
      const descriptor = models.get(this.id)
      if (descriptor === undefined) {
        throw new ChatModelError(
          'model_not_found',
          `Magpie model list does not contain exact model "${this.id}"`,
          1,
        )
      }
      if (
        descriptor.maxOutputTokens !== null &&
        this.maxOutputTokens > descriptor.maxOutputTokens
      ) {
        throw new ChatModelError(
          'model_request_rejected',
          `max_output_tokens ${this.maxOutputTokens} exceeds upstream model limit ${descriptor.maxOutputTokens}`,
          1,
        )
      }
      this.pricing = descriptor.pricing
      this.checked = true
    } catch (error) {
      if (signal?.aborted === true) throw abortError()
      if (timedOut) {
        throw new ChatModelError(
          'model_timeout',
          'timed out while checking the Magpie model list',
          1,
        )
      }
      throw normalizeAvailabilityError(error)
    } finally {
      clearTimeout(timeout)
    }
  }

  async *stream(
    request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    if (!this.checked) {
      throw new ChatModelError(
        'model_check_required',
        'Magpie model availability must be checked before streaming',
        0,
      )
    }

    let lastError: ChatModelError | null = null
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      if (request.signal.aborted) throw abortError()
      const attemptState: AttemptState = { emittedText: false }
      try {
        const result = yield* this.streamAttempt(request, attempt, attemptState)
        yield { type: 'result', result }
        return
      } catch (error) {
        if (request.signal.aborted) throw abortError()
        const normalized = normalizeStreamError(error, attempt)
        lastError = normalized
        if (
          attemptState.emittedText ||
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
      'Magpie request failed without a diagnostic',
      this.maxRetries + 1,
    )
  }

  private async *streamAttempt(
    request: ChatModelRequest,
    attempt: number,
    state: AttemptState,
  ): AsyncGenerator<ChatModelStreamEvent, ChatModelResult> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const combined = AbortSignal.any([request.signal, controller.signal])
    const readerRef: { current: ReadableStreamDefaultReader<Uint8Array> | null } = {
      current: null,
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.headers('text/event-stream'),
          'content-type': 'application/json',
        },
        signal: combined,
        body: JSON.stringify({
          model: this.id,
          messages: [
            { role: 'system', content: request.systemPrompt },
            ...request.messages.map(message => ({
              role: message.role,
              content: message.text,
            })),
          ],
          max_tokens: this.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
      })
      if (!response.ok) {
        await cancelBody(response)
        throw httpStatusError(response.status, attempt)
      }
      if (response.body === null) {
        throw new ChatModelError(
          'model_protocol_error',
          'Magpie returned an empty streaming body',
          attempt,
        )
      }

      const reader = response.body.getReader()
      readerRef.current = reader
      let responseId: string | null = null
      let usage: ChatUsage | null = null

      for await (const data of readSseData(reader)) {
        if (data === '[DONE]') break
        const chunk = parseOpenAiChunk(data, attempt)
        if (typeof chunk.id === 'string' && chunk.id !== '') {
          responseId = chunk.id
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          usage = parseUsage(chunk.usage, attempt)
        }
        if (chunk.choices === undefined) continue
        if (!Array.isArray(chunk.choices)) {
          throw new ChatModelError(
            'model_protocol_error',
            'Magpie response choices is not an array',
            attempt,
          )
        }
        for (const choice of chunk.choices) {
          if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
            throw new ChatModelError(
              'model_protocol_error',
              'Magpie response contains a malformed choice',
              attempt,
            )
          }
          const delta = (choice as Record<string, unknown>).delta
          if (delta === undefined || delta === null) continue
          if (typeof delta !== 'object' || Array.isArray(delta)) {
            throw new ChatModelError(
              'model_protocol_error',
              'Magpie response contains a malformed delta',
              attempt,
            )
          }
          const content = (delta as Record<string, unknown>).content
          if (content === undefined || content === null || content === '') continue
          if (typeof content !== 'string') {
            throw new ChatModelError(
              'model_protocol_error',
              'Magpie response content is not text',
              attempt,
            )
          }
          state.emittedText = true
          yield { type: 'text', text: content }
        }
      }

      return {
        attempts: attempt,
        usage,
        estimatedCost:
          usage === null ? null : estimateCost(usage, this.pricing),
        pricing: this.pricing,
        responseId,
      }
    } catch (error) {
      if (request.signal.aborted) throw abortError()
      if (timedOut) {
        throw new ChatModelError(
          'model_timeout',
          `Magpie request exceeded ${this.timeoutMs} ms`,
          attempt,
        )
      }
      throw normalizeStreamError(error, attempt)
    } finally {
      clearTimeout(timeout)
      controller.abort()
      if (readerRef.current !== null) {
        try {
          await readerRef.current.cancel()
        } catch {
          // 读取器的取消只用于释放连接；原始请求结果不应被它覆盖。
        }
      }
    }
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept,
      [SESSION_HEADER]: this.sessionId,
    }
    if (this.apiKey !== null) {
      headers.authorization = `Bearer ${this.apiKey}`
    }
    return headers
  }

  private retryDelay(failedAttempt: number): number {
    return Math.min(
      this.retryBaseDelayMs * 2 ** (failedAttempt - 1),
      MAX_RETRY_DELAY_MS,
    )
  }
}

async function* readSseData(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false

  const takeFrame = (): string | null => {
    const boundary = buffer.indexOf('\n\n')
    if (boundary < 0) return null
    const frame = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    return frame
  }

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        done = true
        break
      }
      buffer += decoder.decode(result.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let frame = takeFrame()
      while (frame !== null) {
        const data = parseSseFrame(frame)
        if (data !== null) yield data
        frame = takeFrame()
      }
    }
    buffer += decoder.decode()
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    let frame = takeFrame()
    while (frame !== null) {
      const data = parseSseFrame(frame)
      if (data !== null) yield data
      frame = takeFrame()
    }
    if (buffer.trim() !== '') {
      const data = parseSseFrame(buffer)
      if (data !== null) yield data
    }
  } finally {
    if (!done) {
      try {
        await reader.cancel()
      } catch {
        // 调用方已停止消费；取消失败不改变已选择的错误处理路径。
      }
    }
  }
}

function parseSseFrame(frame: string): string | null {
  const lines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    lines.push(line.slice(5).replace(/^ /, ''))
  }
  return lines.length === 0 ? null : lines.join('\n')
}

function parseOpenAiChunk(data: string, attempt: number): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new ChatModelError(
      'model_protocol_error',
      'Magpie returned malformed SSE JSON',
      attempt,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ChatModelError(
      'model_protocol_error',
      'Magpie returned a non-object SSE payload',
      attempt,
    )
  }
  return parsed as Record<string, unknown>
}

function parseUsage(value: unknown, attempt: number): ChatUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChatModelError(
      'model_protocol_error',
      'Magpie usage is not an object',
      attempt,
    )
  }
  const usage = value as Record<string, unknown>
  const promptDetails = objectOrEmpty(usage.prompt_tokens_details)
  const completionDetails = objectOrEmpty(usage.completion_tokens_details)
  return {
    inputTokens: tokenCount(usage.prompt_tokens, 'prompt_tokens', attempt),
    outputTokens: tokenCount(
      usage.completion_tokens,
      'completion_tokens',
      attempt,
    ),
    cacheReadTokens: optionalTokenCount(
      promptDetails.cached_tokens,
      'prompt_tokens_details.cached_tokens',
      attempt,
    ),
    cacheWriteTokens: optionalTokenCount(
      promptDetails.cache_write_tokens,
      'prompt_tokens_details.cache_write_tokens',
      attempt,
    ),
    reasoningTokens: optionalTokenCount(
      completionDetails.reasoning_tokens,
      'completion_tokens_details.reasoning_tokens',
      attempt,
    ),
    totalTokens: tokenCount(usage.total_tokens, 'total_tokens', attempt),
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function tokenCount(value: unknown, field: string, attempt: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChatModelError(
      'model_protocol_error',
      `Magpie usage.${field} is invalid`,
      attempt,
    )
  }
  return value as number
}

function optionalTokenCount(
  value: unknown,
  field: string,
  attempt: number,
): number {
  return value === undefined || value === null
    ? 0
    : tokenCount(value, field, attempt)
}

function modelList(payload: unknown): Map<string, MagpieModelDescriptor> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ChatModelError(
      'model_protocol_error',
      'Magpie model list is not an object',
      1,
    )
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) {
    throw new ChatModelError(
      'model_protocol_error',
      'Magpie model list has no data array',
      1,
    )
  }
  const result = new Map<string, MagpieModelDescriptor>()
  for (const value of data) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const model = value as Record<string, unknown>
    if (typeof model.id !== 'string' || model.id === '') continue
    const maxOutput =
      Number.isSafeInteger(model.max_output_tokens) &&
      (model.max_output_tokens as number) > 0
        ? model.max_output_tokens as number
        : null
    result.set(model.id, {
      pricing: parsePricing(model.pricing),
      maxOutputTokens: maxOutput,
    })
  }
  return result
}

function parsePricing(value: unknown): ChatModelPricing | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const pricing = value as Record<string, unknown>
  return {
    prompt: parsePrice(pricing.prompt),
    completion: parsePrice(pricing.completion),
    cacheRead: parsePrice(pricing.input_cache_read),
    cacheWrite: parsePrice(pricing.input_cache_write),
  }
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const price = Number(value)
  return Number.isFinite(price) && price >= 0 ? price : null
}

/**
 * 依据 Magpie 返回的单价计算估算值。prompt_tokens 按“已包含缓存 token”
 * 处理；若上游对缓存写入采用不同计量口径，结果会标为估算而不是账单。
 */
function estimateCost(
  usage: ChatUsage,
  pricing: ChatModelPricing | null,
): number | null {
  if (
    pricing === null ||
    pricing.prompt === null ||
    pricing.completion === null ||
    (usage.cacheReadTokens > 0 && pricing.cacheRead === null) ||
    (usage.cacheWriteTokens > 0 && pricing.cacheWrite === null)
  ) {
    return null
  }
  const nonCachedInput = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  )
  const cost =
    nonCachedInput * pricing.prompt +
    usage.cacheReadTokens * (pricing.cacheRead ?? 0) +
    usage.cacheWriteTokens * (pricing.cacheWrite ?? 0) +
    usage.outputTokens * pricing.completion
  return Math.round(cost * 1e12) / 1e12
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new ChatModelError(
      'model_protocol_error',
      'Magpie model list is not valid JSON',
      1,
    )
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 丢弃上游错误正文；不把它写入日志或返回给页面。
  }
}

function httpStatusError(status: number, attempt: number): ChatModelError {
  if (status === 401 || status === 403) {
    return new ChatModelError(
      'model_auth_failed',
      'Magpie rejected the configured credentials',
      attempt,
    )
  }
  if (status === 404) {
    return new ChatModelError(
      'model_not_found',
      'Magpie could not find the requested model or endpoint',
      attempt,
    )
  }
  if (status === 408) {
    return new ChatModelError(
      'model_timeout',
      'Magpie reported a request timeout',
      attempt,
    )
  }
  if (status === 429) {
    return new ChatModelError(
      'model_rate_limited',
      'Magpie rate limited the request',
      attempt,
    )
  }
  if (status >= 500) {
    return new ChatModelError(
      'model_upstream_error',
      'Magpie upstream returned a server error',
      attempt,
    )
  }
  return new ChatModelError(
    'model_request_rejected',
    `Magpie rejected the request with HTTP ${status}`,
    attempt,
  )
}

function normalizeAvailabilityError(error: unknown): ChatModelError {
  if (error instanceof ChatModelError) return error
  return new ChatModelError(
    'model_unavailable',
    'cannot reach the local Magpie model router',
    1,
  )
}

function normalizeStreamError(
  error: unknown,
  attempt: number,
): ChatModelError {
  if (error instanceof ChatModelError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new ChatModelError('model_aborted', 'Magpie request was aborted', attempt)
  }
  return new ChatModelError(
    'model_unavailable',
    'cannot read the local Magpie response stream',
    attempt,
  )
}

function isRetryable(code: string): boolean {
  return (
    code === 'model_unavailable' ||
    code === 'model_timeout' ||
    code === 'model_rate_limited' ||
    code === 'model_upstream_error'
  )
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
    if (signal.aborted) onAbort()
  })
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RangeError('baseUrl must be a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RangeError('baseUrl must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new RangeError('baseUrl must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new RangeError('baseUrl must not contain a query or fragment')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new RangeError('baseUrl must use a loopback host')
  }
  if (url.pathname !== '/v1' && url.pathname !== '/v1/') {
    throw new RangeError('baseUrl must end with /v1')
  }
  return `${url.origin}/v1`
}

// Node 的 URL.hostname 对 IPv6 保留方括号，校验前必须先规范化。
function isLoopbackHostname(hostname: string): boolean {
  const normalized =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
  return ['127.0.0.1', '::1', 'localhost'].includes(normalized.toLowerCase())
}

function validateLabel(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RangeError(`${field} must be 1..200 printable characters`)
  }
  return value
}

function validateSecret(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new RangeError('apiKey must be a non-empty single-line secret')
  }
  return value
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${field} must be a positive integer`)
  }
  return value as number
}

function validateNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} must be a non-negative integer`)
  }
  return value as number
}

function abortError(): Error {
  const error = new Error('chat model stream aborted')
  error.name = 'AbortError'
  return error
}
