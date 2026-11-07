/**
 * 外部渠道的领域契约。
 *
 * 平台消息在这里已经被解析成与 QQ 无关的 InboundTurn；核心聊天、记忆和
 * 状态层不接收 OneBot 字段、QQ 号或平台连接状态。
 */

export interface ChannelLogger {
  info(message: string): void
  error?(message: string): void
}

export interface InboundImageReference {
  /** OneBot image 段里的 file，可能是文件名、路径或 URL。 */
  file: string | null
  /** 部分 NapCat 版本通过 file_id 取本机缓存。 */
  fileId: string | null
  messageId: string
  declaredBytes: number | null
}

export interface InboundFragment {
  channel: 'qq'
  /** 稳定的渠道会话键，例如 qq-private-123。 */
  conversationKey: string
  /** 平台发送者键；群里不同成员不会被合成同一轮。 */
  senderKey: string
  /** 回复目标，例如 private:123 或 group:456。 */
  targetKey: string
  text: string
  images: InboundImageReference[]
  messageIds: string[]
  receivedAt: string
}

export interface InboundTurn {
  channel: 'qq'
  conversationKey: string
  senderKey: string
  targetKey: string
  text: string
  images: InboundImageReference[]
  messageIds: string[]
  receivedAt: string
}

export type CoalescerResult =
  | {
      ok: true
      turn: InboundTurn
    }
  | {
      ok: false
      reason: string
      conversationKey: string
      senderKey: string
      targetKey: string
      messageIds: string[]
    }

export type ChannelSendResult =
  | { status: 'delivered'; messageId: string }
  | {
      status: 'failed'
      errorCode: string
      retryable: boolean
    }
  | { status: 'unknown'; errorCode: string }
