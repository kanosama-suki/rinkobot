/**
 * M3.0 聊天领域契约。
 *
 * 模型网关只接收角色和文本，不接触 SQLite；聊天服务负责把已完成的消息
 * 写入正文表。当前只有 mock 实现，真实 DeepSeek/Gemini 驱动在后续切片接入。
 */

import type {
  ChatMessageRecord,
  ChatRole,
} from '../storage/index.ts'

export const CHAT_CONVERSATION_ID = 'main'
export const CHAT_HISTORY_LIMIT = 40
export const MAX_CHAT_REPLY_CHARS = 4_000

export interface ModelMessage {
  role: ChatRole
  text: string
}

export interface ChatModelRequest {
  systemPrompt: string
  messages: readonly ModelMessage[]
  signal: AbortSignal
}

export interface ChatModel {
  readonly id: string
  readonly mode: string
  stream(request: ChatModelRequest): AsyncIterable<string>
}

export interface ChatModelIdentity {
  id: string
  mode: string
}

export interface ChatStateView {
  lastSequence: number
  eventCount: number
  messageCount: number
}

export interface ConversationView {
  conversationId: string
  model: ChatModelIdentity
  state: ChatStateView
  messages: ChatMessageRecord[]
}

export type ChatStreamEvent =
  | {
      type: 'ready'
      conversationId: string
      model: ChatModelIdentity
      userMessage: ChatMessageRecord
    }
  | {
      type: 'delta'
      text: string
    }
  | {
      type: 'done'
      message: ChatMessageRecord
      state: ChatStateView
    }

export class ChatInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChatInputError'
    this.code = code
  }
}
