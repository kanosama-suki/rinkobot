/**
 * M3.1 聊天领域契约。
 *
 * 模型网关只接收角色和文本，不接触 SQLite；聊天服务负责把已完成的消息
 * 写入正文表，并把模型返回的 usage 写入独立的调用审计表。推理内容和
 * 上游错误正文都不穿过这一层。
 */

import type {
  ChatMessageRecord,
  ChatRole,
  ModelCallPurpose,
} from '../storage/index.ts'
import type { MemoryExtractionSummary } from '../memory/index.ts'
import type { StyleCheckResult } from './style.ts'

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
  // 本地 mock 可以忽略；Magpie 驱动会把 true 转成 OpenAI-compatible
  // response_format=json_object，但最终结构仍由服务端严格校验。
  jsonMode?: boolean
  signal: AbortSignal
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
}

/**
 * 计价字段保持与 Magpie 路由返回的含义一致；本项目不替上游声明币种。
 */
export interface ChatModelPricing {
  prompt: number | null
  completion: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface ChatModelResult {
  attempts: number
  usage: ChatUsage | null
  estimatedCost: number | null
  pricing: ChatModelPricing | null
  responseId: string | null
}

export type ChatModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'result'; result: ChatModelResult }

export interface ChatModel {
  readonly id: string
  readonly mode: string
  readonly provider: string
  stream(request: ChatModelRequest): AsyncIterable<ChatModelStreamEvent>
}

export interface ChatModelIdentity {
  id: string
  mode: string
  provider: string
}

export interface ChatStateView {
  lastSequence: number
  eventCount: number
  messageCount: number
  affect: {
    valence: number
    arousal: number
  }
  relationship: {
    closeness: number
    hurt: number
    repairNeeded: boolean
  }
  commitments: {
    total: number
    open: number
  }
}

export interface ConversationView {
  conversationId: string
  model: ChatModelIdentity
  state: ChatStateView
  modelUsage: ChatModelUsageView
  messages: ChatMessageRecord[]
}

export interface ModelCallView {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'aborted'
  purpose: ModelCallPurpose
  provider: string
  model: string
  startedAt: string
  completedAt: string | null
  attempts: number
  usage: ChatUsage | null
  estimatedCost: number | null
  errorCode: string | null
}

export interface ChatModelUsageView {
  lastCall: ModelCallView | null
  todayCallCount: number
  dailyCallLimit: number
}

export interface ChatEnvelopeView {
  // ok 只在信封本身和所有声明字段都有效时为 true；部分字段被门禁丢弃时，
  // errorCode 为 null，但 issueCodes 会列出降级原因。
  ok: boolean
  issueCodes: string[]
  errorCode: string | null
  commitmentsCreated: number
  commitmentsSkipped: number
}

export type ChatStreamEvent =
  | {
      type: 'ready'
      conversationId: string
      model: ChatModelIdentity
      userMessage: ChatMessageRecord
      recalledMemoryCount: number
    }
  | {
      type: 'delta'
      text: string
    }
  | {
      type: 'done'
      message: ChatMessageRecord
      state: ChatStateView
      modelCall: ModelCallView
      modelUsage: ChatModelUsageView
      memory: MemoryExtractionSummary | null
      styleCheck: StyleCheckResult
      envelope: ChatEnvelopeView
    }

export class ChatInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChatInputError'
    this.code = code
  }
}

/**
 * 模型网关错误只暴露机器可读分类和尝试次数，不携带上游响应正文。
 */
export class ChatModelError extends Error {
  readonly code: string
  readonly attempts: number

  constructor(code: string, message: string, attempts: number) {
    super(message)
    this.name = 'ChatModelError'
    this.code = code
    this.attempts = attempts
  }
}
