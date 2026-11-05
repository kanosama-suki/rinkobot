/**
 * 聊天主链路的最小服务层。
 *
 * 一条消息的顺序是：校验输入、持久化用户正文、读取最近历史、调用模型、
 * 持久化完整回复、发布完成状态。模型失败时用户消息保留，助手消息不落库。
 */

import { STATE_EVENT_SCHEMA_VERSION } from '../state/index.ts'
import {
  MAX_CHAT_MESSAGE_CHARS,
  normalizeChatText,
  type ChatMessageRecord,
  type KanobotStorage,
  type ModelCallRecord,
} from '../storage/index.ts'
import { StorageError } from '../storage/index.ts'
import {
  CHAT_CONVERSATION_ID,
  CHAT_HISTORY_LIMIT,
  ChatInputError,
  ChatModelError,
  type ChatModel,
  type ChatModelPricing,
  type ChatModelResult,
  type ChatModelUsageView,
  type ChatModelIdentity,
  type ChatStateView,
  type ChatStreamEvent,
  type ConversationView,
  type ChatUsage,
  MAX_CHAT_REPLY_CHARS,
  type ModelCallView,
  type ModelMessage,
} from './types.ts'

const PLACEHOLDER_SYSTEM_PROMPT =
  '你是 Kanobot 的 M3.1 测试占位人格。模型可能由本地 Magpie 路由或 mock 提供，' +
  '但仍不是燐子的正式人格。只做虚构测试，不要读取或猜测用户的私人资料。'

export interface ChatServiceOptions {
  conversationId?: string
  historyLimit?: number
  maxReplyChars?: number
  systemPrompt?: string
  maxConcurrentModelCalls?: number
  dailyModelCallLimit?: number
}

export class KanobotChatService {
  private readonly storage: KanobotStorage
  private readonly model: ChatModel
  private readonly conversationId: string
  private readonly historyLimit: number
  private readonly maxReplyChars: number
  private readonly systemPrompt: string
  private readonly maxConcurrentModelCalls: number
  private readonly dailyModelCallLimit: number
  private activeModelCalls = 0

  constructor(
    storage: KanobotStorage,
    model: ChatModel,
    options: ChatServiceOptions = {},
  ) {
    this.storage = storage
    this.model = model
    this.conversationId = options.conversationId ?? CHAT_CONVERSATION_ID
    this.historyLimit = options.historyLimit ?? CHAT_HISTORY_LIMIT
    this.maxReplyChars = options.maxReplyChars ?? MAX_CHAT_REPLY_CHARS
    this.systemPrompt = options.systemPrompt ?? PLACEHOLDER_SYSTEM_PROMPT
    this.maxConcurrentModelCalls = options.maxConcurrentModelCalls ?? 2
    this.dailyModelCallLimit = options.dailyModelCallLimit ?? 2_000
    if (
      !Number.isInteger(this.historyLimit) ||
      this.historyLimit < 1 ||
      this.historyLimit > 100
    ) {
      throw new RangeError('historyLimit must be an integer between 1 and 100')
    }
    if (!Number.isInteger(this.maxReplyChars) || this.maxReplyChars < 1) {
      throw new RangeError('maxReplyChars must be a positive integer')
    }
    if (
      !Number.isInteger(this.maxConcurrentModelCalls) ||
      this.maxConcurrentModelCalls < 1 ||
      this.maxConcurrentModelCalls > 8
    ) {
      throw new RangeError(
        'maxConcurrentModelCalls must be an integer between 1 and 8',
      )
    }
    if (
      !Number.isInteger(this.dailyModelCallLimit) ||
      this.dailyModelCallLimit < 1
    ) {
      throw new RangeError('dailyModelCallLimit must be a positive integer')
    }
  }

  identity(): ChatModelIdentity {
    return {
      id: this.model.id,
      mode: this.model.mode,
      provider: this.model.provider,
    }
  }

  conversation(limit = this.historyLimit): ConversationView {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('conversation limit must be an integer between 1 and 100')
    }
    return {
      conversationId: this.conversationId,
      model: this.identity(),
      state: this.state(),
      modelUsage: this.modelUsage(),
      messages: this.storage.listChatMessages(
        this.conversationId,
        limit,
      ),
    }
  }

  async *streamMessage(
    input: unknown,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamEvent> {
    if (signal.aborted) throw abortError()
    const text = validateInput(input)
    this.assertCanStartCall()
    this.activeModelCalls += 1
    let call: ModelCallRecord | undefined
    let auditAttempted = false

    try {
      const userMessage = this.storage.appendChatMessage({
        conversationId: this.conversationId,
        role: 'user',
        text,
      })
      const history = this.storage.listChatMessages(
        this.conversationId,
        this.historyLimit,
      )
      call = this.storage.beginModelCall({
        conversationId: this.conversationId,
        userMessageId: userMessage.id,
        provider: this.model.provider,
        model: this.model.id,
      })

      yield {
        type: 'ready',
        conversationId: this.conversationId,
        model: this.identity(),
        userMessage,
      }

      let reply = ''
      let replyLength = 0
      let result: ChatModelResult | null = null
      for await (const event of this.model.stream({
        systemPrompt: this.systemPrompt,
        messages: toModelMessages(history),
        signal,
      })) {
        if (signal.aborted) throw abortError()
        if (event.type === 'result') {
          if (result !== null) {
            throw new ChatModelError(
              'model_protocol_error',
              'model emitted more than one result event',
              1,
            )
          }
          result = validateModelResult(event.result)
          continue
        }
        if (event.type !== 'text' || typeof event.text !== 'string') {
          throw new ChatModelError(
            'model_protocol_error',
            'model emitted an unsupported stream event',
            1,
          )
        }
        if (result !== null) {
          throw new ChatModelError(
            'model_protocol_error',
            'model emitted text after its result event',
            result.attempts,
          )
        }
        if (event.text.length === 0) {
          throw new ChatModelError(
            'model_protocol_error',
            'model returned an empty chunk',
            1,
          )
        }
        replyLength += Array.from(event.text).length
        if (replyLength > this.maxReplyChars) {
          throw new ChatInputError(
            'model_output_too_long',
            `model reply exceeded ${this.maxReplyChars} characters`,
          )
        }
        reply += event.text
        yield { type: 'delta', text: event.text }
      }
      if (result === null) {
        throw new ChatModelError(
          'model_protocol_error',
          'model stream ended without a result event',
          1,
        )
      }
      if (reply.trim() === '') {
        throw new ChatInputError('model_output_invalid', 'model returned no text')
      }

      const assistantMessage = this.storage.appendChatMessage({
        conversationId: this.conversationId,
        role: 'assistant',
        text: reply,
      })
      const completed = this.storage.finishModelCall(call.id, {
        status: 'succeeded',
        completedAt: assistantMessage.createdAt,
        assistantMessageId: assistantMessage.id,
        attempts: result.attempts,
        usage: result.usage,
        estimatedCost: result.estimatedCost,
        pricing: result.pricing,
        responseId: result.responseId,
      })
      auditAttempted = true

      // 事件只引用正文 ID；模型 usage 和费用留在独立审计表。
      this.storage.appendEvent({
        eventId: `interaction-${assistantMessage.id}`,
        schemaVersion: STATE_EVENT_SCHEMA_VERSION,
        occurredAt: assistantMessage.createdAt,
        source: 'user',
        type: 'interaction.recorded',
        payload: {
          kind: 'conversation',
          intensity: 1,
        },
        evidenceRefs: [userMessage.bodyId, assistantMessage.bodyId],
        confidence: 1,
      })
      yield {
        type: 'done',
        message: assistantMessage,
        state: this.state(),
        modelCall: modelCallView(completed),
        modelUsage: this.modelUsage(),
      }
    } catch (error) {
      const normalized = normalizeChatError(error)
      if (call !== undefined && !auditAttempted) {
        auditAttempted = true
        try {
          this.storage.finishModelCall(call.id, {
            status:
              signal.aborted || normalized.name === 'AbortError'
                ? 'aborted'
                : 'failed',
            attempts: attemptsFrom(error),
            errorCode: errorCodeFrom(error, signal.aborted),
          })
        } catch (auditError) {
          throw new StorageError(
            'IO',
            `chat failed and its model call audit could not be completed: ${errorMessage(auditError)}`,
            { cause: error },
          )
        }
      }
      throw normalized
    } finally {
      if (call !== undefined && !auditAttempted) {
        // 客户端在 ready 后断开时异步生成器会直接进入 finally，没有 catch。
        try {
          this.storage.finishModelCall(call.id, {
            status: 'aborted',
            attempts: 0,
            errorCode: 'aborted',
          })
        } catch (auditError) {
          throw new StorageError(
            'IO',
            `aborted chat could not finalize its model call audit: ${errorMessage(auditError)}`,
            { cause: auditError },
          )
        }
      }
      this.activeModelCalls -= 1
    }
  }

  private assertCanStartCall(): void {
    if (this.activeModelCalls >= this.maxConcurrentModelCalls) {
      throw new ChatInputError(
        'model_capacity_reached',
        '当前模型并发额度已满，请等待上一轮回复结束',
      )
    }
    if (this.storage.modelCallCountToday() >= this.dailyModelCallLimit) {
      throw new ChatInputError(
        'daily_model_call_limit_reached',
        '今天的模型调用额度已用完',
      )
    }
  }

  private modelUsage(): ChatModelUsageView {
    const latest = this.storage.latestModelCall(this.conversationId)
    return {
      lastCall: latest === null ? null : modelCallView(latest),
      todayCallCount: this.storage.modelCallCountToday(),
      dailyCallLimit: this.dailyModelCallLimit,
    }
  }

  private state(): ChatStateView {
    return {
      lastSequence: this.storage.lastSequence,
      eventCount: this.storage.eventCount(),
      messageCount: this.storage.chatMessageCount(this.conversationId),
    }
  }
}

function validateInput(input: unknown): string {
  return normalizeInputText(input)
}

function normalizeInputText(input: unknown): string {
  try {
    return normalizeChatText(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new ChatInputError(
      'invalid_message',
      message.includes(String(MAX_CHAT_MESSAGE_CHARS))
        ? `消息长度必须在 1 到 ${MAX_CHAT_MESSAGE_CHARS} 个字符之间`
        : '消息不能为空，且必须是文本',
    )
  }
}

function toModelMessages(history: ChatMessageRecord[]): ModelMessage[] {
  return history.map(message => ({
    role: message.role,
    text: message.text,
  }))
}

function modelCallView(call: ModelCallRecord): ModelCallView {
  const usage: ChatUsage | null =
    call.inputTokens === null ||
    call.outputTokens === null ||
    call.cacheReadTokens === null ||
    call.cacheWriteTokens === null ||
    call.reasoningTokens === null ||
    call.totalTokens === null
      ? null
      : {
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          cacheReadTokens: call.cacheReadTokens,
          cacheWriteTokens: call.cacheWriteTokens,
          reasoningTokens: call.reasoningTokens,
          totalTokens: call.totalTokens,
        }
  return {
    id: call.id,
    status: call.status,
    provider: call.provider,
    model: call.model,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    attempts: call.attempts,
    usage,
    estimatedCost: call.estimatedCost,
    errorCode: call.errorCode,
  }
}

function validateModelResult(value: ChatModelResult): ChatModelResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 1 ||
    value.attempts > 100
  ) {
    throw new ChatModelError(
      'model_protocol_error',
      'model returned invalid attempt metadata',
      1,
    )
  }
  const usage = value.usage === null ? null : validateUsage(value.usage)
  const pricing =
    value.pricing === null ? null : validatePricing(value.pricing)
  if (
    value.estimatedCost !== null &&
    (typeof value.estimatedCost !== 'number' ||
      !Number.isFinite(value.estimatedCost) ||
      value.estimatedCost < 0)
  ) {
    throw new ChatModelError(
      'model_protocol_error',
      'model returned an invalid estimated cost',
      value.attempts,
    )
  }
  if (
    value.responseId !== null &&
    (typeof value.responseId !== 'string' ||
      value.responseId.length === 0 ||
      value.responseId.length > 512)
  ) {
    throw new ChatModelError(
      'model_protocol_error',
      'model returned an invalid response id',
      value.attempts,
    )
  }
  return {
    attempts: value.attempts,
    usage,
    estimatedCost: value.estimatedCost,
    pricing,
    responseId: value.responseId,
  }
}

function validateUsage(value: ChatUsage): ChatUsage {
  const keys: Array<keyof ChatUsage> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]
  for (const key of keys) {
    const count = value[key]
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ChatModelError(
        'model_protocol_error',
        `model returned an invalid usage.${key}`,
        1,
      )
    }
  }
  return { ...value }
}

function validatePricing(value: ChatModelPricing): ChatModelPricing {
  for (const [key, price] of Object.entries(value)) {
    if (
      price !== null &&
      (typeof price !== 'number' || !Number.isFinite(price) || price < 0)
    ) {
      throw new ChatModelError(
        'model_protocol_error',
        `model returned an invalid pricing.${key}`,
        1,
      )
    }
  }
  return {
    prompt: value.prompt,
    completion: value.completion,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  }
}

function normalizeChatError(error: unknown): Error {
  if (error instanceof ChatInputError) return error
  if (error instanceof StorageError) return error
  if (error instanceof ChatModelError) {
    return new ChatInputError(error.code, publicModelErrorMessage(error.code))
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return error
  }
  return new ChatInputError('model_failed', '模型回复失败，请稍后重试')
}

function publicModelErrorMessage(code: string): string {
  switch (code) {
    case 'model_timeout':
      return '模型响应超时，请稍后重试'
    case 'model_rate_limited':
      return '模型路由限流，请稍后重试'
    case 'model_auth_failed':
      return '模型路由凭据无效或没有权限'
    case 'model_not_found':
      return '配置的精确模型不存在，请检查模型路由'
    case 'model_unavailable':
      return '本地模型路由不可用，请检查 Magpie 是否运行'
    case 'model_upstream_error':
      return '模型上游暂时失败，请稍后重试'
    case 'model_protocol_error':
      return '模型返回了无法解析的响应'
    case 'model_request_rejected':
      return '模型路由拒绝了这次请求'
    default:
      return '模型回复失败，请稍后重试'
  }
}

function attemptsFrom(error: unknown): number {
  if (error instanceof ChatModelError) return error.attempts
  if (error instanceof Error && error.name === 'AbortError') return 0
  return 1
}

function errorCodeFrom(error: unknown, aborted: boolean): string {
  if (aborted || (error instanceof Error && error.name === 'AbortError')) {
    return 'aborted'
  }
  if (error instanceof ChatModelError || error instanceof ChatInputError) {
    return /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code)
      ? error.code
      : 'model_failed'
  }
  return 'model_failed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  const error = new Error('chat stream aborted')
  error.name = 'AbortError'
  return error
}
