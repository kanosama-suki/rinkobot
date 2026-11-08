/**
 * 聊天领域模块公开入口。
 */

export { MagpieChatModel } from './magpie-model.ts'
export type { MagpieChatModelOptions } from './magpie-model.ts'
export {
  ModelCatalogError,
  modelCatalogMap,
  parseOpenAIModelCatalog,
} from './model-catalog.ts'
export type {
  ModelCatalogEntry,
  ModelImageInput,
} from './model-catalog.ts'
export { MockChatModel, MOCK_MODEL_ID } from './mock-model.ts'
export {
  ChatModelBudget,
  DEFAULT_DAILY_MODEL_CALL_LIMIT,
  DEFAULT_MAX_CONCURRENT_MODEL_CALLS,
} from './budget.ts'
export type {
  ChatModelBudgetOptions,
  ChatModelBudgetSnapshot,
  ModelBudgetFailure,
} from './budget.ts'
export { KanobotChatService } from './service.ts'
export type { ChatInitiativeOptions, ChatServiceOptions } from './service.ts'
export { mergeOwnerConversationHistory } from './owner-history.ts'
export {
  EMPTY_IMAGE_MESSAGE_TEXT,
  EMPTY_MULTI_IMAGE_MESSAGE_TEXT,
  parseChatTurnInput,
} from './input.ts'
export type { ChatTurn, ChatTurnLimits } from './input.ts'
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
  MAX_ENVELOPE_CARE_CANDIDATES,
  MAX_ENVELOPE_COMMITMENTS,
  MAX_ENVELOPE_MEMORY_CANDIDATES,
  MAX_ENVELOPE_REMINDER_CANDIDATES,
  ReplyEnvelopeStream,
  parseChatEnvelope,
} from './envelope.ts'
export type {
  ChatEnvelopeAppraisal,
  ChatEnvelopeCareCandidate,
  ChatEnvelopeCommitment,
  ChatEnvelopeReminderCandidate,
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
  ChatVisionView,
  ChatEnvelopeView,
  ConversationDirectoryView,
  ConversationKind,
  ConversationMessageView,
  ConversationPageView,
  ConversationSummaryView,
  ConversationTimelineView,
  ConversationView,
  ModelCallView,
  ModelMessage,
} from './types.ts'
