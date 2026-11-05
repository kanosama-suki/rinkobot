/**
 * 聊天领域模块公开入口。
 */

export { MockChatModel, MOCK_MODEL_ID } from './mock-model.ts'
export { KanobotChatService } from './service.ts'
export type { ChatServiceOptions } from './service.ts'
export {
  CHAT_CONVERSATION_ID,
  CHAT_HISTORY_LIMIT,
  ChatInputError,
  MAX_CHAT_REPLY_CHARS,
} from './types.ts'
export type {
  ChatModel,
  ChatModelIdentity,
  ChatModelRequest,
  ChatStateView,
  ChatStreamEvent,
  ConversationView,
  ModelMessage,
} from './types.ts'
