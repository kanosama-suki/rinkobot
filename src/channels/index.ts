/**
 * 渠道适配层公开入口。
 *
 * 核心和正式程序只从适配层注入 QQ 能力；核心不导入 OneBot
 * 或 WebSocket 实现。
 */

export { InboundCoalescer, fragmentKey } from './coalescer.ts'
export type {
  CoalescerOptions,
  CoalescerPushResult,
} from './coalescer.ts'
export type {
  ChannelLogger,
  ChannelSendResult,
  CoalescerResult,
  InboundFragment,
  InboundImageReference,
  InboundTurn,
} from './types.ts'
export { QqChannel } from './qq/channel.ts'
export type { QqChannelOptions } from './qq/channel.ts'
export {
  QqCredentialError,
  resolveQqAccessToken,
} from './qq/credentials.ts'
export type { LocalSecretReader } from './qq/credentials.ts'
export {
  parseQqMessageEvent,
  shouldAcceptGroupMessage,
} from './qq/events.ts'
export type {
  ParsedQqEvent,
  ParsedQqMessage,
  QqEventPolicy,
} from './qq/events.ts'
export {
  outboxTarget,
  parseOutboxTarget,
  parseQqTargetKey,
  splitQqText,
  targetAllowed,
  targetKey,
  QqFormatError,
} from './qq/format.ts'
export type { QqTarget } from './qq/format.ts'
export {
  OneBotActionError,
} from './qq/gateway.ts'
export type {
  OneBotActionResponse,
  QqGateway,
  QqGatewayHandlers,
  QqGatewayState,
} from './qq/gateway.ts'
export {
  detectImageMime,
  isAllowedQqImageUrl,
  resolveQqImages,
  QqMediaError,
} from './qq/media.ts'
export type { ResolvedQqImage } from './qq/media.ts'
export {
  OneBotClient,
  QqConnectionTestError,
  testOneBotConnection,
} from './qq/onebot.ts'
export type {
  OneBotClientOptions,
  OneBotConnectionTestOptions,
  OneBotConnectionTestResult,
} from './qq/onebot.ts'
