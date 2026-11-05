/**
 * 聊天领域模块公开入口。
 */

export { MagpieChatModel } from './magpie-model.ts'
export type { MagpieChatModelOptions } from './magpie-model.ts'
export { MockChatModel, MOCK_MODEL_ID } from './mock-model.ts'
export { KanobotChatService } from './service.ts'
export type { ChatServiceOptions } from './service.ts'
export {
  assembleChatContext,
  ChatContextError,
  DEFAULT_CHAT_CONTEXT_BUDGET,
  validateChatContextBudget,
} from './context.ts'
export type {
  AssembledChatContext,
  AssembleChatContextInput,
  ChatContextBudget,
  ChatContextStats,
} from './context.ts'
export {
  CHAT_ENVELOPE_SCHEMA_VERSION,
  ChatEnvelopeError,
  MAX_ENVELOPE_COMMITMENTS,
  MAX_ENVELOPE_MEMORY_CANDIDATES,
  ReplyEnvelopeStream,
  parseChatEnvelope,
} from './envelope.ts'
export type {
  ChatEnvelopeAppraisal,
  ChatEnvelopeCommitment,
  ParsedChatEnvelope,
} from './envelope.ts'
export { checkReplyStyle } from './style.ts'
export type {
  StyleCheckOptions,
  StyleCheckResult,
  StyleViolation,
  StyleViolationCode,
} from './style.ts'
export {
  CHAT_CONVERSATION_ID,
  CHAT_HISTORY_LIMIT,
  ChatInputError,
  ChatModelError,
  MAX_CHAT_REPLY_CHARS,
} from './types.ts'
export type {
  ChatModel,
  ChatModelIdentity,
  ChatModelPricing,
  ChatModelRequest,
  ChatModelResult,
  ChatModelStreamEvent,
  ChatModelUsageView,
  ChatStateView,
  ChatStreamEvent,
  ChatUsage,
  ChatEnvelopeView,
  ConversationView,
  ModelCallView,
  ModelMessage,
} from './types.ts'
