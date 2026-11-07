/**
 * Kanobot M3.0 的网页和聊天 HTTP 适配层。
 *
 * 边界：
 * - 页面与接口复用 DSH 已认证的浏览器 Cookie；没有会话时一律 401；
 * - 非流式响应使用有限 JSON 请求体，聊天回复使用 SSE 长连接；
 * - 静态资源、路径和响应头固定，不把用户输入拼进 HTML。
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

import type {
  ChatInputError,
  ChatStreamEvent,
  ConversationView,
  KanobotChatService,
} from '../core/chat/index.ts'
import {
  MemoryInputError,
  type KanobotMemoryService,
} from '../core/memory/index.ts'
import {
  InitiativeError,
  type KanobotInitiativeService,
} from '../core/initiative/index.ts'
import {
  AUDIT_TIMELINE_SOURCES,
  type AuditTimelineFilter,
  type AuditTimelineService,
  type OwnerAuditService,
} from '../core/observability/index.ts'
import type { KanobotEmergencyService } from '../core/policy/index.ts'
import {
  StorageError,
  type OwnerAuditAction,
} from '../core/storage/index.ts'
import {
  ChannelSettingsError,
  ModelSettingsError,
  type ChannelSettingsService,
  type ModelSettingsService,
} from '../settings/index.ts'

export const CHAT_BASE_PATH = '/kanobot'

const MAX_JSON_BODY_BYTES = 64 * 1024
// 单张图片上限 5 MiB；base64 和 JSON 包装会额外膨胀，留出 8 MiB 边界。
const MAX_CHAT_BODY_BYTES = 8 * 1024 * 1024
// QQ 设置包含多个嵌套区间，但仍是纯 JSON；不需要聊天图片级别的大请求体。
const MAX_CHANNEL_SETTINGS_BODY_BYTES = 256 * 1024
const MAX_LIMIT = 100

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

const SSE_HEADERS = {
  ...SECURITY_HEADERS,
  'cache-control': 'no-cache, no-transform',
  'content-type': 'text/event-stream; charset=utf-8',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const

interface WebRoute {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface ChatWebServer {
  register(route: WebRoute): () => void
}

export interface ChatConnection {
  admit(request: {
    headers: IncomingMessage['headers']
  }):
    | { peer: unknown }
    | { rejection: 401 | 403 }
}

export interface ChatLogger {
  info(message: string): void
  error?(message: string): void
}

export interface ChatSurfaceOptions {
  webServer: ChatWebServer
  connection: ChatConnection
  chat: KanobotChatService
  memory?: KanobotMemoryService
  audit?: OwnerAuditService
  timeline?: AuditTimelineService
  emergency?: KanobotEmergencyService
  initiative?: KanobotInitiativeService
  models?: ModelSettingsService
  channels?: ChannelSettingsService
  logger: ChatLogger
  auth?: ChatAuthMessages
}

/**
 * 宿主可以替换未认证提示文案；正式 DSH 默认引导去根页面登录，
 * 本地开发入口则提示使用启动时打印的短期链接。
 */
export interface ChatAuthMessages {
  unauthenticatedMessage?: string
  forbiddenMessage?: string
  showLoginLink?: boolean
}

interface UiAssets {
  html: Buffer
  javaScript: Buffer
  style: Buffer
}

export function registerChatSurface(options: ChatSurfaceOptions): () => void {
  const assets = loadAssets()
  const activeStreams = new Set<ServerResponse>()

  const disposeRoute = options.webServer.register({
    kind: 'prefix',
    path: CHAT_BASE_PATH,
    handler: (req, res) => {
      void handleRequest(req, res, options, assets, activeStreams).catch(error => {
        handleUnexpectedError(req, res, options.logger, error)
      })
    },
  })

  return () => {
    disposeRoute()
    for (const response of activeStreams) {
      if (!response.writableEnded) response.destroy()
    }
    activeStreams.clear()
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ChatSurfaceOptions,
  assets: UiAssets,
  activeStreams: Set<ServerResponse>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://kanobot.invalid')
  const pathname = url.pathname
  const api = pathname.startsWith(`${CHAT_BASE_PATH}/api/`)

  const admission = options.connection.admit({ headers: req.headers })
  if ('rejection' in admission) {
    writeAuthRejection(res, admission.rejection, api, options.auth)
    return
  }

  if (pathname === CHAT_BASE_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeMethodNotAllowed(res, ['GET', 'HEAD'], api)
      return
    }
    res.writeHead(308, {
      ...SECURITY_HEADERS,
      location: `${CHAT_BASE_PATH}/`,
    })
    res.end()
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeMethodNotAllowed(res, ['GET', 'HEAD'], api)
      return
    }
    writeStatic(res, req.method === 'HEAD', 'text/html; charset=utf-8', assets.html)
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/app.js`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeMethodNotAllowed(res, ['GET', 'HEAD'], api)
      return
    }
    writeStatic(
      res,
      req.method === 'HEAD',
      'text/javascript; charset=utf-8',
      assets.javaScript,
    )
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/app.css`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeMethodNotAllowed(res, ['GET', 'HEAD'], api)
      return
    }
    writeStatic(res, req.method === 'HEAD', 'text/css; charset=utf-8', assets.style)
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/api/conversation`) {
    if (req.method !== 'GET') {
      writeMethodNotAllowed(res, ['GET'], true)
      return
    }
    const limit = parseLimit(url.searchParams.get('limit'))
    if (limit === null) {
      writeError(res, 400, 'invalid_limit', `limit 必须是 1 到 ${MAX_LIMIT} 的整数`, true)
      return
    }
    const view = options.chat.conversation(limit)
    writeJson(res, 200, view)
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/api/chat`) {
    if (req.method !== 'POST') {
      writeMethodNotAllowed(res, ['POST'], true)
      return
    }
    await handleChatStream(req, res, options, activeStreams)
    return
  }

  if (
    pathname === `${CHAT_BASE_PATH}/api/memories` ||
    pathname.startsWith(`${CHAT_BASE_PATH}/api/memories/`)
  ) {
    await handleMemoryRequest(req, res, url, options)
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/api/initiative`) {
    if (req.method !== 'GET') {
      writeMethodNotAllowed(res, ['GET'], true)
      return
    }
    if (options.initiative === undefined) {
      writeError(res, 404, 'not_found', '主动性接口未启用', true)
      return
    }
    writeJson(res, 200, options.initiative.view())
    return
  }

  if (pathname.startsWith(`${CHAT_BASE_PATH}/api/initiative/`)) {
    await handleInitiativeAction(req, res, pathname, options)
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/api/control`) {
    await handleControlRequest(req, res, options)
    return
  }

  if (
    pathname === `${CHAT_BASE_PATH}/api/emergency/stop` ||
    pathname === `${CHAT_BASE_PATH}/api/emergency/resume`
  ) {
    await handleEmergencyRequest(req, res, url, options)
    return
  }

  if (pathname === `${CHAT_BASE_PATH}/api/audit`) {
    await handleAuditRequest(req, res, url, options)
    return
  }

  if (
    pathname === `${CHAT_BASE_PATH}/api/settings/models` ||
    pathname === `${CHAT_BASE_PATH}/api/settings/models/test` ||
    pathname === `${CHAT_BASE_PATH}/api/settings/models/discover`
  ) {
    await handleModelSettingsRequest(req, res, pathname, options)
    return
  }

  if (
    pathname === `${CHAT_BASE_PATH}/api/settings/channels` ||
    pathname === `${CHAT_BASE_PATH}/api/settings/channels/test` ||
    pathname === `${CHAT_BASE_PATH}/api/settings/channels/status`
  ) {
    await handleChannelSettingsRequest(req, res, pathname, options)
    return
  }

  writeError(res, 404, 'not_found', '接口不存在', api)
}

async function handleModelSettingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: ChatSurfaceOptions,
): Promise<void> {
  const service = options.models
  if (service === undefined) {
    writeError(res, 404, 'not_found', '模型设置接口未启用', true)
    return
  }
  if (pathname.endsWith('/discover')) {
    if (req.method !== 'POST') {
      writeMethodNotAllowed(res, ['POST'], true)
      return
    }
    try {
      const body = await readJsonBody(req)
      writeJson(res, 200, await service.discover(body))
    } catch (error) {
      handleModelSettingsError(res, options.logger, error)
    }
    return
  }
  if (pathname.endsWith('/test')) {
    if (req.method !== 'POST') {
      writeMethodNotAllowed(res, ['POST'], true)
      return
    }
    try {
      const body = await readJsonBody(req)
      writeJson(res, 200, await service.test(body))
    } catch (error) {
      handleModelSettingsError(res, options.logger, error)
    }
    return
  }
  if (req.method === 'GET') {
    writeJson(res, 200, service.view())
    return
  }
  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req)
      writeJson(res, 200, await service.save(body))
    } catch (error) {
      handleModelSettingsError(res, options.logger, error)
    }
    return
  }
  writeMethodNotAllowed(res, ['GET', 'PUT'], true)
}

function handleModelSettingsError(
  res: ServerResponse,
  logger: ChatLogger,
  error: unknown,
): void {
  if (error instanceof ModelSettingsError) {
    const status =
      error.code === 'settings_read_only' ||
      error.code === 'credential_reuse_refused'
        ? 409
        : error.code.startsWith('model_discovery_')
          ? 422
        : error.code.endsWith('_test_failed')
          ? 422
          : 400
    writeError(res, status, error.code, error.message, true)
    return
  }
  if (error instanceof RequestError) {
    writeError(res, error.status, error.code, error.message, true)
    return
  }
  // 设置请求不记录 body；这里只记录脱敏错误类型，避免密钥误入日志。
  logger.error?.('[kanobot] model settings request failed')
  writeError(res, 500, 'internal_error', '模型设置操作失败', true)
}

async function handleChannelSettingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: ChatSurfaceOptions,
): Promise<void> {
  const service = options.channels
  if (service === undefined) {
    writeError(res, 404, 'not_found', 'QQ 设置接口未启用', true)
    return
  }
  try {
    if (pathname.endsWith('/status')) {
      if (req.method !== 'GET') {
        writeMethodNotAllowed(res, ['GET'], true)
        return
      }
      writeJson(res, 200, { qq: service.status() })
      return
    }
    if (pathname.endsWith('/test')) {
      if (req.method !== 'POST') {
        writeMethodNotAllowed(res, ['POST'], true)
        return
      }
      const body = await readJsonBody(req, MAX_CHANNEL_SETTINGS_BODY_BYTES)
      writeJson(res, 200, {
        ok: true,
        ...(await service.test(body)),
      })
      return
    }
    if (req.method === 'GET') {
      writeJson(res, 200, service.view())
      return
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req, MAX_CHANNEL_SETTINGS_BODY_BYTES)
      writeJson(res, 200, await service.save(body))
      return
    }
    writeMethodNotAllowed(res, ['GET', 'PUT'], true)
  } catch (error) {
    handleChannelSettingsError(res, options.logger, error)
  }
}

function handleChannelSettingsError(
  res: ServerResponse,
  logger: ChatLogger,
  error: unknown,
): void {
  if (error instanceof ChannelSettingsError) {
    const status =
      error.code === 'settings_read_only'
        ? 409
        : error.code.startsWith('qq_test_')
          ? 422
          : 400
    writeError(res, status, error.code, error.message, true)
    return
  }
  if (error instanceof RequestError) {
    writeError(res, error.status, error.code, error.message, true)
    return
  }
  logger.error?.('[kanobot] QQ settings request failed')
  writeError(res, 500, 'internal_error', 'QQ 设置操作失败', true)
}

const INITIATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

async function handleInitiativeAction(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    writeMethodNotAllowed(res, ['POST'], true)
    return
  }
  const initiative = options.initiative
  if (initiative === undefined) {
    writeError(res, 404, 'not_found', '主动性接口未启用', true)
    return
  }
  const body = await readJsonBody(req)
  requireConfirmation(body)
  const relative = pathname.slice(`${CHAT_BASE_PATH}/api/initiative/`.length)
  const parts = relative.split('/').filter(Boolean)
  try {
    if (
      parts.length === 2 &&
      parts[0] === 'circuit' &&
      parts[1] === 'reset'
    ) {
      writeJson(res, 200, { initiative: initiative.resetCircuit() })
      return
    }
    if (
      parts.length === 3 &&
      parts[0] === 'reminder-candidates'
    ) {
      const id = parts[1] ?? ''
      if (!INITIATIVE_ID.test(id)) {
        writeError(res, 400, 'invalid_reminder_id', '提醒候选 ID 不合法', true)
        return
      }
      if (parts[2] === 'confirm') {
        initiative.confirmReminderCandidate(id)
        writeJson(res, 200, { initiative: initiative.view() })
        return
      }
      if (parts[2] === 'reject') {
        initiative.rejectReminderCandidate(id)
        writeJson(res, 200, { initiative: initiative.view() })
        return
      }
    }
    if (parts.length === 2 && parts[0] === 'reminders') {
      const id = parts[1] ?? ''
      if (!INITIATIVE_ID.test(id)) {
        writeError(res, 400, 'invalid_reminder_id', '提醒 ID 不合法', true)
        return
      }
      initiative.cancelReminder(id)
      writeJson(res, 200, { initiative: initiative.view() })
      return
    }
    writeError(res, 404, 'not_found', '主动性操作不存在', true)
  } catch (error) {
    if (error instanceof InitiativeError) {
      writeError(res, 409, error.code, '主动性操作当前不可执行', true)
      return
    }
    if (error instanceof StorageError) {
      writeError(
        res,
        error.code === 'REFERENCE_MISSING' ? 404 : 409,
        error.code.toLowerCase(),
        error.code === 'REFERENCE_MISSING'
          ? '对象不存在'
          : '对象状态不允许这个操作',
        true,
      )
      return
    }
    throw error
  }
}

const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MEMORY_STATUSES = [
  'active',
  'candidate',
  'archived',
  'trash',
  'all',
] as const
type MemoryStatus = typeof MEMORY_STATUSES[number]

/**
 * 所有者记忆接口。认证已经在 handleRequest 统一完成；这里只做
 * 请求形状、状态过滤和领域错误到 HTTP 状态的映射。
 */
async function handleMemoryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ChatSurfaceOptions,
): Promise<void> {
  const memory = options.memory
  if (memory === undefined) {
    writeError(res, 404, 'not_found', '记忆接口未启用', true)
    return
  }

  const relative = url.pathname.slice(`${CHAT_BASE_PATH}/api/memories`.length)
  try {
    if (relative === '') {
      await handleMemoryCollection(req, res, url, memory, options)
      return
    }
    const parts = relative.split('/').filter(Boolean)
    if (parts.length < 1 || parts.length > 2) {
      writeError(res, 404, 'not_found', '接口不存在', true)
      return
    }
    const id = parts[0] ?? ''
    if (!MEMORY_ID.test(id)) {
      writeError(res, 400, 'invalid_memory_id', '记忆 ID 不合法', true)
      return
    }

    if (parts.length === 1) {
      await handleMemoryItem(req, res, memory, id, options)
      return
    }
    await handleMemoryAction(req, res, memory, id, parts[1] ?? '', options)
  } catch (error) {
    handleMemoryError(res, options.logger, error)
  }
}

async function handleMemoryCollection(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  memory: KanobotMemoryService,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method === 'GET') {
    const status = parseMemoryStatus(url.searchParams.get('status'))
    if (status === null) {
      writeError(
        res,
        400,
        'invalid_status',
        'status 只能是 active、candidate、archived、trash 或 all',
        true,
      )
      return
    }
    const query = url.searchParams.get('q')
    if (query !== null && Array.from(query).length > 500) {
      writeError(res, 400, 'invalid_query', '搜索词不能超过 500 字', true)
      return
    }
    const memories = query === null || query.trim() === ''
      ? memory.listViews(status).slice(0, 200)
      : memory.search(query, { limit: 50, markRecalled: false })
          .map(result => memory.view(result.memory))
    writeJson(res, 200, {
      memories,
      counts: memoryCounts(memory),
    })
    return
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req)
    const input = parseOwnerMemoryInput(body)
    const record = memory.addByOwner({
      text: input.text,
      quoteText: input.quoteText,
      kind: input.kind,
      importance: input.importance,
      sensitivity: input.sensitivity,
    })
    recordOwnerAudit(options, 'memory.create', record.id)
    writeJson(res, 201, { memory: memory.view(record) })
    return
  }

  writeMethodNotAllowed(res, ['GET', 'POST'], true)
}

async function handleMemoryItem(
  req: IncomingMessage,
  res: ServerResponse,
  memory: KanobotMemoryService,
  id: string,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method === 'GET') {
    const view = memory.getView(id)
    if (view === null) {
      writeError(res, 404, 'memory_not_found', '记忆不存在', true)
      return
    }
    writeJson(res, 200, { memory: view })
    return
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req)
    const input = parseOwnerMemoryInput(body)
    const record = memory.correct(id, {
      text: input.text,
      quoteText: input.quoteText,
      kind: input.kind,
      importance: input.importance,
      sensitivity: input.sensitivity,
    })
    recordOwnerAudit(options, 'memory.correct', record.id)
    writeJson(res, 200, { memory: memory.view(record) })
    return
  }

  if (req.method === 'DELETE') {
    const record = memory.trash(id)
    recordOwnerAudit(options, 'memory.trash', id)
    writeJson(res, 200, { memory: memory.view(record) })
    return
  }

  writeMethodNotAllowed(res, ['GET', 'PATCH', 'DELETE'], true)
}

async function handleMemoryAction(
  req: IncomingMessage,
  res: ServerResponse,
  memory: KanobotMemoryService,
  id: string,
  action: string,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    writeMethodNotAllowed(res, ['POST'], true)
    return
  }

  if (action === 'promote') {
    const record = memory.promote(id)
    recordOwnerAudit(options, 'memory.promote', id)
    writeJson(res, 200, {
      memory: memory.view(record),
      counts: memoryCounts(memory),
    })
    return
  }
  if (action === 'restore') {
    const record = memory.restore(id)
    recordOwnerAudit(options, 'memory.restore', id)
    writeJson(res, 200, {
      memory: memory.view(record),
      counts: memoryCounts(memory),
    })
    return
  }
  if (action === 'purge') {
    const body = await readJsonBody(req)
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      (body as Record<string, unknown>).confirm !== true
    ) {
      writeError(
        res,
        400,
        'confirmation_required',
        '彻底清除需要 { "confirm": true }',
        true,
      )
      return
    }
    memory.purge(id)
    recordOwnerAudit(options, 'memory.purge', id)
    writeJson(res, 200, { purged: true, id, counts: memoryCounts(memory) })
    return
  }

  writeError(res, 404, 'not_found', '接口不存在', true)
}

function parseMemoryStatus(raw: string | null): MemoryStatus | null {
  if (raw === null) return 'active'
  return MEMORY_STATUSES.includes(raw as MemoryStatus)
    ? raw as MemoryStatus
    : null
}

function memoryCounts(memory: KanobotMemoryService): {
  active: number
  candidate: number
  archived: number
  trash: number
} {
  return {
    active: memory.listViews('active').length,
    candidate: memory.listViews('candidate').length,
    archived: memory.listViews('archived').length,
    trash: memory.listViews('trash').length,
  }
}

interface ParsedOwnerMemoryInput {
  text: string
  quoteText: string | null
  kind: string
  importance: 'normal' | 'important' | 'permanent' | undefined
  sensitivity: 'normal' | 'sensitive' | 'third_party' | undefined
}

function parseOwnerMemoryInput(value: unknown): ParsedOwnerMemoryInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError(400, 'invalid_body', '请求体必须是 JSON 对象')
  }
  const record = value as Record<string, unknown>
  const allowed = ['text', 'quoteText', 'kind', 'importance', 'sensitivity']
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new RequestError(400, 'invalid_body', `不支持字段 ${key}`)
    }
  }
  if (typeof record.text !== 'string') {
    throw new RequestError(400, 'invalid_text', 'text 必须是字符串')
  }
  if (typeof record.kind !== 'string') {
    throw new RequestError(400, 'invalid_kind', 'kind 必须是字符串')
  }
  if (record.quoteText !== undefined && typeof record.quoteText !== 'string') {
    throw new RequestError(400, 'invalid_quote', 'quoteText 必须是字符串')
  }
  const importance = record.importance
  if (
    importance !== undefined &&
    importance !== 'normal' &&
    importance !== 'important' &&
    importance !== 'permanent'
  ) {
    throw new RequestError(400, 'invalid_importance', 'importance 不合法')
  }
  const sensitivity = record.sensitivity
  if (
    sensitivity !== undefined &&
    sensitivity !== 'normal' &&
    sensitivity !== 'sensitive' &&
    sensitivity !== 'third_party'
  ) {
    throw new RequestError(400, 'invalid_sensitivity', 'sensitivity 不合法')
  }
  return {
    text: record.text,
    quoteText: record.quoteText ?? null,
    kind: record.kind,
    importance,
    sensitivity,
  }
}

function handleMemoryError(
  res: ServerResponse,
  logger: ChatLogger,
  error: unknown,
): void {
  if (res.headersSent) {
    if (!res.destroyed) res.destroy()
    return
  }
  if (error instanceof RequestError) {
    writeError(res, error.status, error.code, error.message, true)
    return
  }
  if (error instanceof MemoryInputError) {
    writeError(res, 400, error.code, error.message, true)
    return
  }
  if (error instanceof StorageError) {
    const status = error.code === 'REFERENCE_MISSING' ? 404 : 409
    writeError(
      res,
      status,
      error.code.toLowerCase(),
      status === 404 ? '记忆不存在' : '记忆状态不允许这个操作',
      true,
    )
    return
  }
  logger.error?.(`[kanobot] memory request failed: ${formatError(error)}`)
  writeError(res, 500, 'internal_error', '服务器内部错误', true)
}

async function handleControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    writeMethodNotAllowed(res, ['GET'], true)
    return
  }
  if (options.emergency === undefined) {
    writeError(res, 404, 'not_found', '控制接口未启用', true)
    return
  }
  writeJson(res, 200, {
    emergency: options.emergency.status(),
  })
}

async function handleEmergencyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    writeMethodNotAllowed(res, ['POST'], true)
    return
  }
  if (options.emergency === undefined) {
    writeError(res, 404, 'not_found', '紧急停止接口未启用', true)
    return
  }
  const body = await readJsonBody(req)
  requireConfirmation(body)

  const stopping = url.pathname.endsWith('/stop')
  const emergency = stopping
    ? options.emergency.stop('owner_stop')
    : options.emergency.resume()
  recordOwnerAudit(
    options,
    stopping ? 'emergency.stop' : 'emergency.resume',
    'system',
    'system',
  )
  writeJson(res, 200, { emergency })
}

async function handleAuditRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ChatSurfaceOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    writeMethodNotAllowed(res, ['GET'], true)
    return
  }
  if (options.audit === undefined) {
    writeError(res, 404, 'not_found', '审计接口未启用', true)
    return
  }
  const limit = parseAuditLimit(url.searchParams.get('limit'))
  if (limit === null) {
    writeError(res, 400, 'invalid_limit', 'limit 必须是 1 到 200 的整数', true)
    return
  }
  const source = parseAuditSource(url.searchParams.get('source'))
  if (source === null) {
    writeError(
      res,
      400,
      'invalid_source',
      'source 只能是 all、owner、memory、model、style、chat 或 channel',
      true,
    )
    return
  }
  writeJson(res, 200, {
    // 保留旧字段，避免已经打开的旧页面在升级瞬间失去所有者操作记录。
    events: options.audit.list(limit),
    timeline: options.timeline?.list(limit, source) ?? [],
  })
}

function recordOwnerAudit(
  options: ChatSurfaceOptions,
  action: OwnerAuditAction,
  targetId: string,
  targetType: 'memory' | 'system' = 'memory',
): void {
  options.audit?.record({
    action,
    targetType,
    targetId,
  })
}

function requireConfirmation(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    (value as Record<string, unknown>).confirm !== true
  ) {
    throw new RequestError(
      400,
      'confirmation_required',
      '这次操作需要 { "confirm": true }',
    )
  }
}

async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: ChatSurfaceOptions,
  activeStreams: Set<ServerResponse>,
): Promise<void> {
  const body = await readJsonBody(req, MAX_CHAT_BODY_BYTES)
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  ) {
    throw new RequestError(400, 'invalid_body', '请求体必须是 JSON 对象')
  }
  const keys = Object.keys(body)
  if (
    keys.length === 0 ||
    keys.some(key => key !== 'text' && key !== 'images') ||
    (!Object.hasOwn(body, 'text') && !Object.hasOwn(body, 'images'))
  ) {
    throw new RequestError(
      400,
      'invalid_body',
      '请求体只能包含 text 和可选的 images 字段',
    )
  }

  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  res.on('close', onClose)
  activeStreams.add(res)
  res.writeHead(200, SSE_HEADERS)
  res.flushHeaders()

  try {
    for await (const event of options.chat.streamMessage(
      body,
      controller.signal,
    )) {
      if (res.writableEnded || controller.signal.aborted) break
      writeSse(res, event)
    }
  } catch (error) {
    if (!controller.signal.aborted && !res.writableEnded) {
      writeSse(res, streamError(error))
    }
    if (!isAbortError(error)) {
      options.logger.error?.(`[kanobot] chat stream failed: ${formatError(error)}`)
    }
  } finally {
    activeStreams.delete(res)
    res.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

function writeSse(res: ServerResponse, event: ChatStreamEvent | {
  type: 'error'
  code: string
  message: string
}): void {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function streamError(error: unknown): {
  type: 'error'
  code: string
  message: string
} {
  const candidate = error as Partial<ChatInputError>
  if (candidate.name === 'ChatInputError' && typeof candidate.code === 'string') {
    return {
      type: 'error',
      code: candidate.code,
      message: error instanceof Error ? error.message : '聊天请求失败',
    }
  }
  return {
    type: 'error',
    code: 'chat_failed',
    message: '聊天回复失败，请稍后重试',
  }
}

function writeStatic(
  res: ServerResponse,
  head: boolean,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': contentType,
    'content-length': String(body.byteLength),
  })
  res.end(head ? undefined : body)
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  res.end(body)
}

function writeError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  api: boolean,
): void {
  if (api) {
    writeJson(res, status, { error: { code, message } })
    return
  }
  const body = Buffer.from(`${message}\n`, 'utf8')
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  res.end(body)
}

function writeAuthRejection(
  res: ServerResponse,
  rejection: 401 | 403,
  api: boolean,
  messages: ChatAuthMessages | undefined,
): void {
  const showLoginLink = messages?.showLoginLink !== false
  const unauthenticatedMessage =
    messages?.unauthenticatedMessage ??
    '需要先登录 DSH。请先打开 DSH 根页面完成登录'
  const forbiddenMessage =
    messages?.forbiddenMessage ?? '请求来源不被允许'
  if (api) {
    writeJson(res, rejection, {
      error: {
        code: rejection === 401 ? 'unauthenticated' : 'forbidden',
        message:
          rejection === 401
            ? unauthenticatedMessage
            : forbiddenMessage,
      },
    })
    return
  }
  const pageMessage =
    rejection === 401 ? unauthenticatedMessage : forbiddenMessage
  const html =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<title>Kanobot 需要登录</title><body>' +
    `<h1>${rejection === 401 ? '需要先登录' : forbiddenMessage}</h1>` +
    `<p>${pageMessage}。` +
    (rejection === 401 && showLoginLink
      ? '请先打开 <a href="/">DSH 根页面</a> 完成浏览器登录，然后重新访问'
      : '请重新打开带有效凭据的页面地址，然后访问') +
    ' <code>/kanobot/</code>。</p></body></html>'
  res.writeHead(rejection, {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
  })
  res.end(html)
}

function writeMethodNotAllowed(
  res: ServerResponse,
  methods: string[],
  api: boolean,
): void {
  res.setHeader('allow', methods.join(', '))
  writeError(res, 405, 'method_not_allowed', '请求方法不被允许', api)
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    throw new RequestError(415, 'unsupported_media_type', 'Content-Type 必须是 application/json')
  }
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestError(413, 'body_too_large', '请求体过大')
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) {
      throw new RequestError(413, 'body_too_large', '请求体过大')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) {
    throw new RequestError(400, 'invalid_body', '请求体不能为空')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'invalid_json', '请求体不是合法 JSON')
  }
}

function parseLimit(raw: string | null): number | undefined | null {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : null
}

function parseAuditLimit(raw: string | null): number | undefined | null {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : null
}

function parseAuditSource(
  raw: string | null,
): AuditTimelineFilter | null {
  if (raw === null) return 'all'
  if (raw === 'all') return 'all'
  return AUDIT_TIMELINE_SOURCES.includes(
    raw as (typeof AUDIT_TIMELINE_SOURCES)[number],
  )
    ? raw as AuditTimelineFilter
    : null
}

function loadAssets(): UiAssets {
  return {
    html: readFileSync(fileURLToPath(new URL('./assets/index.html', import.meta.url))),
    javaScript: readFileSync(
      fileURLToPath(new URL('./assets/app.js', import.meta.url)),
    ),
    style: readFileSync(fileURLToPath(new URL('./assets/app.css', import.meta.url))),
  }
}

function handleUnexpectedError(
  req: IncomingMessage,
  res: ServerResponse,
  logger: ChatLogger,
  error: unknown,
): void {
  if (res.headersSent) {
    if (!res.destroyed) res.destroy()
    return
  }
  if (error instanceof RequestError) {
    writeError(
      res,
      error.status,
      error.code,
      error.message,
      new URL(req.url ?? '/', 'http://kanobot.invalid').pathname.includes('/api/'),
    )
    return
  }
  logger.error?.(`[kanobot] chat HTTP request failed: ${formatError(error)}`)
  writeError(res, 500, 'internal_error', '服务器内部错误', true)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class RequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

export type { ConversationView }
