/**
 * 宿主 Web 适配层公开入口。
 */

export {
  CHAT_BASE_PATH,
  registerChatSurface,
} from './chat-http.ts'
export type {
  ChatConnection,
  ChatLogger,
  ChatSurfaceOptions,
  ChatWebServer,
} from './chat-http.ts'
