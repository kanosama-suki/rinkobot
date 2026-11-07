/**
 * QQ 渠道依赖的最小 OneBot 网关接口。
 *
 * 生产实现走 WebSocket；测试可以注入内存实现。上层只依赖这些动作，
 * 不读取 socket、pending action 或重连细节。
 */

import type { QqTarget } from './format.ts'

export interface OneBotActionResponse {
  status: string
  retcode: number
  data: unknown
  wording?: string
}

export interface QqGatewayState {
  connected: boolean
  selfId: string | null
  event: 'opened' | 'closed' | 'reconnecting'
  detailCode?: string
}

export interface QqGatewayHandlers {
  onEvent(event: unknown): void
  onState(state: QqGatewayState): void
}

export interface QqGateway {
  start(): void
  close(): Promise<void>
  connected(): boolean
  currentSelfId(): string | null
  setHandlers(handlers: QqGatewayHandlers): void
  sendText(
    target: QqTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<string>
  getImage(file: string, signal?: AbortSignal): Promise<OneBotActionResponse>
  getFile(fileId: string, signal?: AbortSignal): Promise<OneBotActionResponse>
  getMsg(messageId: string, signal?: AbortSignal): Promise<OneBotActionResponse>
}

export class OneBotActionError extends Error {
  readonly code: string
  /** true 表示请求可能已经到达 NapCat，不能盲目重发。 */
  readonly mayHaveSent: boolean

  constructor(code: string, message: string, mayHaveSent: boolean) {
    super(message)
    this.name = 'OneBotActionError'
    this.code = code
    this.mayHaveSent = mayHaveSent
  }
}
