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
import type { VisionModelIdentity } from '../vision/types.ts'
import type { StyleCheckResult, StyleViolationCode } from './style.ts'

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
  /**
   * 可选的 JSON 助手预填。支持的适配器会把它作为最后一条 assistant
   * 消息发送，迫使模型从完整的 JSON 开头继续；正文仍由上层严格解析。
   * 适配器必须保证返回文本包含该前缀，不能静默伪造后续内容。
   */
  responsePrefill?: string
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

/**
 * 视觉能力只暴露可用性与模型身份；未配置时不显示任何伪装的成功状态。
 */
export interface ChatVisionView {
  enabled: boolean
  model: VisionModelIdentity | null
  maxImages: number
  maxImageBytes: number
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
  vision: ChatVisionView
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
  reminderCandidatesCreated: number
  reminderCandidatesSkipped: number
  careItemsCreated: number
  careItemsSkipped: number
}

/**
 * 第一版回复因风格检查被丢弃时，保留足够信息供页面和重启后的审计解释，
 * 不携带第一版正文。
 */
export interface ChatStyleRetryView {
  attempted: boolean
  reason: 'style_check' | 'daily_model_call_limit' | null
  initialViolationCodes: StyleViolationCode[]
  discardedModelCall: ModelCallView | null
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
      // 只在真的调用独立视觉模型时出现；提醒页面等待图片转述，而不是误以为聊天模型卡住。
      type: 'vision'
      phase: 'started'
      model: VisionModelIdentity
    }
  | {
      type: 'delta'
      text: string
    }
  | {
      // 页面可以先清空临时气泡，再继续逐字显示第二版；数据库只保存最终版。
      type: 'retry'
      attempt: 2
      reason: 'style_check'
      initialViolationCodes: StyleViolationCode[]
    }
  | {
      type: 'done'
      message: ChatMessageRecord
      state: ChatStateView
      modelCall: ModelCallView
      modelUsage: ChatModelUsageView
      memory: MemoryExtractionSummary | null
      styleCheck: StyleCheckResult
      styleRetry: ChatStyleRetryView
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
