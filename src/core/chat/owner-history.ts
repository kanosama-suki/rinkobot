/**
 * 所有者 QQ 历史回填。
 *
 * owner_qq 可能在已有私聊之后才配置。这里把旧 qq-private-<owner> 的
 * conversation_id 归属迁移到网页 main，但不复制正文、不重排 seq。
 */

import type { KanobotStorage } from '../storage/index.ts'
import { CHAT_CONVERSATION_ID } from './types.ts'

export function mergeOwnerConversationHistory(
  storage: KanobotStorage,
  ownerQqId: string,
): {
  movedMessages: number
  movedModelCalls: number
  removedConversation: boolean
} {
  return storage.mergeConversationHistory(
    `qq-private-${ownerQqId}`,
    CHAT_CONVERSATION_ID,
  )
}
