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
} from '../storage/index.ts'
import {
  CHAT_CONVERSATION_ID,
  CHAT_HISTORY_LIMIT,
  ChatInputError,
  type ChatModel,
  type ChatModelIdentity,
  type ChatStateView,
  type ChatStreamEvent,
  type ConversationView,
  MAX_CHAT_REPLY_CHARS,
  type ModelMessage,
} from './types.ts'

const PLACEHOLDER_SYSTEM_PROMPT =
  '你是 Kanobot 的 M3.0 测试占位人格。只用虚构内容验证网页聊天和持久化；' +
  '不要声称已经连接真实模型，也不要读取或猜测用户的私人资料。'

export interface ChatServiceOptions {
  conversationId?: string
  historyLimit?: number
  maxReplyChars?: number
  systemPrompt?: string
}

export class KanobotChatService {
  private readonly storage: KanobotStorage
  private readonly model: ChatModel
  private readonly conversationId: string
  private readonly historyLimit: number
  private readonly maxReplyChars: number
  private readonly systemPrompt: string

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
  }

  identity(): ChatModelIdentity {
    return {
      id: this.model.id,
      mode: this.model.mode,
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
    const userMessage = this.storage.appendChatMessage({
      conversationId: this.conversationId,
      role: 'user',
      text,
    })
    const history = this.storage.listChatMessages(
      this.conversationId,
      this.historyLimit,
    )

    yield {
      type: 'ready',
      conversationId: this.conversationId,
      model: this.identity(),
      userMessage,
    }

    let reply = ''
    let replyLength = 0
    for await (const chunk of this.model.stream({
      systemPrompt: this.systemPrompt,
      messages: toModelMessages(history),
      signal,
    })) {
      if (signal.aborted) throw abortError()
      if (typeof chunk !== 'string' || chunk.length === 0) {
        throw new ChatInputError('model_output_invalid', 'model returned an empty chunk')
      }
      replyLength += Array.from(chunk).length
      if (replyLength > this.maxReplyChars) {
        throw new ChatInputError(
          'model_output_too_long',
          `model reply exceeded ${this.maxReplyChars} characters`,
        )
      }
      reply += chunk
      yield { type: 'delta', text: chunk }
    }
    if (reply.trim() === '') {
      throw new ChatInputError('model_output_invalid', 'model returned no text')
    }

    const assistantMessage = this.storage.appendChatMessage({
      conversationId: this.conversationId,
      role: 'assistant',
      text: reply,
    })
    // M3.0 只记录一轮已完成的互动。事件只引用正文 ID，供墓碑抑制和后续
    // 关系策略使用；聊天原文仍然只存在于 bodies 表。
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

function abortError(): Error {
  const error = new Error('chat stream aborted')
  error.name = 'AbortError'
  return error
}
