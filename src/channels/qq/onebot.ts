/**
 * OneBot 11 正向 WebSocket 客户端。
 *
 * 只负责连接、鉴权、动作请求、ping 和重连。发送动作只有在拿到有效
 * message_id 时才算成功；断开或超时则明确标记结果未知，禁止自动重发。
 */

import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import type { ChannelLogger } from '../types.ts'
import type { QqTarget } from './format.ts'
import {
  OneBotActionError,
  type OneBotActionResponse,
  type QqGateway,
  type QqGatewayHandlers,
  type QqGatewayState,
} from './gateway.ts'

export interface OneBotClientOptions {
  url: string
  token: string | null
  connectTimeoutMs: number
  actionTimeoutMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
  pingIntervalMs: number
  logger: ChannelLogger
}

export interface OneBotConnectionTestOptions {
  url: string
  token: string | null
  connectTimeoutMs: number
  actionTimeoutMs: number
}

export interface OneBotConnectionTestResult {
  selfId: string
  durationMs: number
}

export class QqConnectionTestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QqConnectionTestError'
    this.code = code
  }
}

interface PendingAction {
  action: string
  resolve(response: OneBotActionResponse): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  removeAbort(): void
}

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_PENDING_ACTIONS = 128

/**
 * 设置页的一次性连接测试。只完成 WebSocket 握手和 get_login_info，
 * 不启动重连、不注册事件处理器、不发送任何 QQ 消息。
 */
export async function testOneBotConnection(
  options: OneBotConnectionTestOptions,
): Promise<OneBotConnectionTestResult> {
  const startedAt = Date.now()
  return new Promise<OneBotConnectionTestResult>((resolve, reject) => {
    let settled = false
    let socket: WebSocket | null = null
    const finish = (
      outcome:
        | { ok: true; selfId: string }
        | { ok: false; code: string; message: string },
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket !== null) {
        try {
          socket.terminate()
        } catch {
          // 测试结果已经确定；关闭失败不覆盖稳定错误码。
        }
      }
      if (outcome.ok) {
        resolve({
          selfId: outcome.selfId,
          durationMs: Math.max(0, Date.now() - startedAt),
        })
      } else {
        reject(new QqConnectionTestError(outcome.code, outcome.message))
      }
    }
    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: 'qq_test_timeout',
        message: 'QQ 连接测试超时',
      })
    }, options.connectTimeoutMs + options.actionTimeoutMs)
    unrefTimer(timer)

    try {
      socket = new WebSocket(options.url, {
        maxPayload: MAX_FRAME_BYTES,
        ...(options.token === null
          ? {}
          : {
              headers: {
                Authorization: `Bearer ${options.token}`,
              },
            }),
      })
    } catch {
      finish({
        ok: false,
        code: 'qq_test_invalid_url',
        message: 'QQ WebSocket 地址不合法',
      })
      return
    }

    socket.on('unexpected-response', (_request, response) => {
      response.resume()
      finish({
        ok: false,
        code:
          response.statusCode === 401 || response.statusCode === 403
            ? 'qq_test_auth_failed'
            : 'qq_test_connect_failed',
        message:
          response.statusCode === 401 || response.statusCode === 403
            ? 'NapCat 拒绝了当前 access token'
            : 'NapCat 拒绝了 WebSocket 握手',
      })
    })
    socket.on('open', () => {
      if (settled) return
      const echo = `kanobot-test-${randomUUID()}`
      socket.send(
        JSON.stringify({
          action: 'get_login_info',
          params: {},
          echo,
        }),
        error => {
          if (error !== undefined && error !== null) {
            finish({
              ok: false,
              code: 'qq_test_connect_failed',
              message: '无法向 NapCat 发送登录信息请求',
            })
          }
        },
      )
    })
    socket.on('message', data => {
      if (settled) return
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        finish({
          ok: false,
          code: 'qq_test_invalid_response',
          message: 'NapCat 返回了非 JSON 响应',
        })
        return
      }
      if (!isRecord(parsed) || typeof parsed.echo !== 'string') return
      if (!parsed.echo.startsWith('kanobot-test-')) return
      const dataValue = isRecord(parsed.data) ? parsed.data : {}
      const selfId = validMessageId(dataValue.user_id)
      if (
        (parsed.status === 'ok' || Number(parsed.retcode) === 0) &&
        selfId !== null
      ) {
        finish({ ok: true, selfId })
        return
      }
      if (
        Number(parsed.retcode) === 401 ||
        Number(parsed.retcode) === 403
      ) {
        finish({
          ok: false,
          code: 'qq_test_auth_failed',
          message: 'NapCat 拒绝了当前 access token',
        })
        return
      }
      finish({
        ok: false,
        code: 'qq_test_login_info_invalid',
        message: 'NapCat 没有返回有效的 QQ 登录信息',
      })
    })
    socket.on('error', () => {
      finish({
        ok: false,
        code: 'qq_test_connect_failed',
        message: '无法连接 NapCat WebSocket',
      })
    })
    socket.on('close', () => {
      finish({
        ok: false,
        code: 'qq_test_connect_failed',
        message: 'NapCat WebSocket 在测试完成前关闭',
      })
    })
  })
}

export class OneBotClient implements QqGateway {
  private readonly options: OneBotClientOptions
  private handlers: QqGatewayHandlers | null = null
  private socket: WebSocket | null = null
  private stopped = true
  private connectedFlag = false
  private selfId: string | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private alive = false
  private lastState: QqGatewayState | null = null
  private readonly pending = new Map<string, PendingAction>()

  constructor(options: OneBotClientOptions) {
    validateOptions(options)
    this.options = options
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.reconnectAttempt = 0
    this.open()
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearReconnect()
    this.clearConnectionTimers()
    this.connectedFlag = false
    this.rejectPending('onebot_closed', true)
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      try {
        socket.close(1000, 'kanobot shutdown')
      } catch {
        socket.terminate()
      }
    }
    this.emitState({
      connected: false,
      selfId: this.selfId,
      event: 'closed',
      detailCode: 'channel_closed',
    })
  }

  connected(): boolean {
    return this.connectedFlag
  }

  currentSelfId(): string | null {
    return this.selfId
  }

  setHandlers(handlers: QqGatewayHandlers): void {
    this.handlers = handlers
    if (this.lastState !== null) handlers.onState(this.lastState)
  }

  async sendText(
    target: QqTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    const numericId = Number(target.id)
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new OneBotActionError(
        'invalid_target_id',
        'QQ target id is outside the safe integer range',
        false,
      )
    }
    const action = target.kind === 'private'
      ? 'send_private_msg'
      : 'send_group_msg'
    const params = target.kind === 'private'
      ? {
          user_id: numericId,
          message: [{ type: 'text', data: { text } }],
        }
      : {
          group_id: numericId,
          message: [{ type: 'text', data: { text } }],
        }
    const response = await this.callAction(action, params, {
      signal,
      timeoutMs: this.options.actionTimeoutMs,
    })
    const data = isRecord(response.data) ? response.data : {}
    const messageId = validMessageId(data.message_id)
    if (messageId === null) {
      throw new OneBotActionError(
        'missing_message_id',
        'OneBot send response did not contain a usable message_id',
        true,
      )
    }
    return messageId
  }

  async getImage(
    file: string,
    signal?: AbortSignal,
  ): Promise<OneBotActionResponse> {
    return this.callAction('get_image', { file }, { signal })
  }

  async getFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<OneBotActionResponse> {
    return this.callAction('get_file', { file_id: fileId }, { signal })
  }

  async getMsg(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OneBotActionResponse> {
    const numeric = Number(messageId)
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new OneBotActionError(
        'invalid_message_id',
        'QQ message id is outside the safe integer range',
        false,
      )
    }
    return this.callAction(
      'get_msg',
      { message_id: numeric },
      { signal },
    )
  }

  private open(): void {
    if (this.stopped) return
    this.clearReconnect()
    let socket: WebSocket
    try {
      socket = new WebSocket(this.options.url, {
        // 在 ws 完成整帧缓冲前就限制最大帧，避免本机协议端发来超大帧。
        maxPayload: MAX_FRAME_BYTES,
        ...(this.options.token === null
          ? {}
          : {
              headers: {
                Authorization: `Bearer ${this.options.token}`,
              },
            }),
      })
    } catch {
      this.scheduleReconnect('websocket_construct_failed')
      return
    }
    this.socket = socket
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket || this.connectedFlag) return
      this.abortSocket(socket)
      this.emitState({
        connected: false,
        selfId: null,
        event: 'closed',
        detailCode: 'connect_timeout',
      })
      this.scheduleReconnect('connect_timeout')
    }, this.options.connectTimeoutMs)
    unrefTimer(this.connectTimer)

    socket.on('open', () => {
      if (this.socket !== socket) return
      this.clearConnectTimer()
      this.connectedFlag = true
      this.alive = true
      this.reconnectAttempt = 0
      this.startPing(socket)
      void this.finishOpen()
    })
    socket.on('message', data => {
      if (this.socket !== socket) return
      this.handleFrame(data)
    })
    socket.on('pong', () => {
      this.alive = true
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.connectedFlag = false
      this.clearConnectionTimers()
      this.rejectPending('onebot_disconnected', true)
      this.emitState({
        connected: false,
        selfId: this.selfId,
        event: 'closed',
        detailCode: 'socket_closed',
      })
      this.scheduleReconnect('socket_closed')
    })
    socket.on('error', () => {
      // close 事件负责重连；这里不记录可能带 URL 的底层错误文本。
      if (this.connectedFlag) {
        this.emitState({
          connected: false,
          selfId: this.selfId,
          event: 'reconnecting',
          detailCode: 'socket_error',
        })
      }
    })
  }

  private async finishOpen(): Promise<void> {
    try {
      const response = await this.callAction('get_login_info', {})
      const data = isRecord(response.data) ? response.data : {}
      this.selfId = validMessageId(data.user_id)
      this.emitState({
        connected: true,
        selfId: this.selfId,
        event: 'opened',
        ...(this.selfId === null ? { detailCode: 'self_id_unknown' } : {}),
      })
    } catch (error) {
      const detailCode = error instanceof OneBotActionError
        ? error.code
        : 'login_info_failed'
      this.emitState({
        connected: true,
        selfId: null,
        event: 'opened',
        detailCode,
      })
    }
  }

  private callAction(
    action: string,
    params: Record<string, unknown>,
    options: {
      signal?: AbortSignal
      timeoutMs?: number
    } = {},
  ): Promise<OneBotActionResponse> {
    if (this.stopped) {
      return Promise.reject(
        new OneBotActionError('channel_closed', 'OneBot client is closed', false),
      )
    }
    const socket = this.socket
    if (
      socket === null ||
      socket.readyState !== WebSocket.OPEN ||
      !this.connectedFlag
    ) {
      return Promise.reject(
        new OneBotActionError(
          'not_connected',
          'OneBot WebSocket is not connected',
          false,
        ),
      )
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new OneBotActionError('aborted', 'OneBot action was aborted', false),
      )
    }
    if (this.pending.size >= MAX_PENDING_ACTIONS) {
      return Promise.reject(
        new OneBotActionError(
          'too_many_pending_actions',
          'too many pending OneBot actions',
          false,
        ),
      )
    }
    const echo = `kanobot-${randomUUID()}`
    const timeoutMs = options.timeoutMs ?? this.options.actionTimeoutMs
    return new Promise<OneBotActionResponse>((resolve, reject) => {
      const finish = (): boolean => {
        const current = this.pending.get(echo)
        if (current === undefined) return false
        this.pending.delete(echo)
        clearTimeout(current.timer)
        current.removeAbort()
        return true
      }
      const onAbort = (): void => {
        if (!finish()) return
        reject(
          new OneBotActionError(
            'aborted',
            'OneBot action was aborted after dispatch',
            true,
          ),
        )
      }
      const abortListener = (): void => onAbort()
      options.signal?.addEventListener('abort', abortListener, { once: true })
      const removeAbort = (): void => {
        options.signal?.removeEventListener('abort', abortListener)
      }
      const timer = setTimeout(() => {
        if (!finish()) return
        reject(
          new OneBotActionError(
            'action_timeout',
            `OneBot action "${action}" timed out`,
            true,
          ),
        )
      }, timeoutMs)
      unrefTimer(timer)
      this.pending.set(echo, {
        action,
        resolve,
        reject,
        timer,
        removeAbort,
      })
      const payload = JSON.stringify({ action, params, echo })
      socket.send(payload, error => {
        // ws 成功时可能回调 null 而不是 undefined；把 null 当失败会
        // 将已经写出的动作误报为 send_failed。
        if (error === undefined || error === null) return
        if (!finish()) return
        reject(
          new OneBotActionError(
            'send_failed',
            'OneBot action could not be written to the socket',
            true,
          ),
        )
      })
    })
  }

  private handleFrame(data: WebSocket.RawData): void {
    const text = data.toString()
    if (text.length > MAX_FRAME_BYTES) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    const echo = typeof parsed.echo === 'string' ? parsed.echo : null
    if (echo !== null) {
      const pending = this.pending.get(echo)
      if (pending === undefined) return
      this.pending.delete(echo)
      clearTimeout(pending.timer)
      pending.removeAbort()
      if (parsed.status === 'ok' || Number(parsed.retcode) === 0) {
        pending.resolve({
          status: typeof parsed.status === 'string' ? parsed.status : 'ok',
          retcode: Number(parsed.retcode) || 0,
          data: parsed.data,
          ...(typeof parsed.wording === 'string'
            ? { wording: parsed.wording.slice(0, 200) }
            : {}),
        })
      } else {
        pending.reject(
          new OneBotActionError(
            'action_rejected',
            `OneBot action "${pending.action}" was rejected`,
            false,
          ),
        )
      }
      return
    }
    if (this.selfId === null) {
      this.selfId = validMessageId(parsed.self_id)
    }
    this.handlers?.onEvent(parsed)
  }

  private startPing(socket: WebSocket): void {
    this.clearPingTimer()
    if (this.options.pingIntervalMs === 0) return
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket || !this.connectedFlag) return
      if (!this.alive) {
        this.abortSocket(socket)
        return
      }
      this.alive = false
      try {
        socket.ping()
      } catch {
        this.abortSocket(socket)
      }
    }, this.options.pingIntervalMs)
    unrefTimer(this.pingTimer)
  }

  private scheduleReconnect(detailCode: string): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const base = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** this.reconnectAttempt,
    )
    this.reconnectAttempt += 1
    this.emitState({
      connected: false,
      selfId: this.selfId,
      event: 'reconnecting',
      detailCode,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, base)
    unrefTimer(this.reconnectTimer)
  }

  private emitState(state: QqGatewayState): void {
    this.lastState = state
    this.handlers?.onState(state)
  }

  private rejectPending(code: string, mayHaveSent: boolean): void {
    for (const [echo, pending] of this.pending) {
      this.pending.delete(echo)
      clearTimeout(pending.timer)
      pending.removeAbort()
      pending.reject(
        new OneBotActionError(
          code,
          `OneBot action "${pending.action}" lost its connection`,
          mayHaveSent,
        ),
      )
    }
  }

  private abortSocket(socket: WebSocket): void {
    if (this.socket !== socket) return
    try {
      socket.terminate()
    } catch {
      // close 事件仍会负责状态收敛。
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearConnectionTimers(): void {
    this.clearConnectTimer()
    this.clearPingTimer()
  }
}

function validMessageId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) {
    return value
  }
  return null
}

function validateOptions(options: OneBotClientOptions): void {
  for (const [field, value, minimum, maximum] of [
    ['connectTimeoutMs', options.connectTimeoutMs, 1_000, 60_000],
    ['actionTimeoutMs', options.actionTimeoutMs, 1_000, 120_000],
    ['reconnectMinMs', options.reconnectMinMs, 500, 60_000],
    ['reconnectMaxMs', options.reconnectMaxMs, 1_000, 300_000],
    ['pingIntervalMs', options.pingIntervalMs, 0, 300_000],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(
        `${field} must be an integer between ${minimum} and ${maximum}`,
      )
    }
  }
  if (options.reconnectMaxMs < options.reconnectMinMs) {
    throw new RangeError('reconnectMaxMs must be >= reconnectMinMs')
  }
}

function unrefTimer(
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
