/**
 * 不经过 DSH 的本地开发入口。
 *
 * 边界：
 * - 只监听 127.0.0.1；拒绝非预期 Host 和跨源请求；
 * - 页面和 API 共用短期会话 Cookie，首次访问必须使用一次性 token 换取；
 * - 默认 mock 模型和仓库内 `tmp/dev-data`，避免误连真实模型或正式数据；
 * - 这是开发调试入口，不替代 DSH 的正式鉴权和产品形态。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KanobotChatService } from '../core/chat/index.ts'
import { loadConfigFromDirectory } from '../core/config/index.ts'
import {
  InitiativeScheduler,
  KanobotInitiativeService,
  MockInitiativeBrain,
  ModelInitiativeBrain,
} from '../core/initiative/index.ts'
import { KanobotMemoryService } from '../core/memory/index.ts'
import {
  AuditTimelineService,
  OwnerAuditService,
} from '../core/observability/index.ts'
import { KanobotEmergencyService } from '../core/policy/index.ts'
import {
  KanobotStorage,
  StorageError,
} from '../core/storage/index.ts'
import { systemClock, type Clock } from '../core/state/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
  type ChatLogger,
  type ChatSurfaceOptions,
} from '../web/index.ts'
import {
  LocalSecretStore,
  createModelRuntime,
  type ModelProviderMode,
} from '../model-providers/index.ts'
import {
  ChannelSettingsService,
  ModelSettingsService,
} from '../settings/index.ts'

const DEV_COOKIE = 'kanobot_dev_session'
const DEFAULT_PORT = 4101
const DEFAULT_BOOTSTRAP_TTL_MS = 10 * 60 * 1000
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000

const DEV_SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export interface DevServerOptions {
  configDir?: string
  dataDir?: string
  modelMode?: ModelProviderMode
  port?: number
  clock?: Clock
  bootstrapTtlMs?: number
  sessionTtlMs?: number
  logger?: ChatLogger
}

export interface DevServer {
  baseUrl: string
  /**
   * 只应打印到启动终端。使用一次换取 HttpOnly + SameSite=Strict Cookie，
   * 随后重定向到不包含 token 的页面地址。
   */
  bootstrapUrl: string
  port: number
  close(): Promise<void>
}

interface DevAuthState {
  bootstrapTokenHash: Buffer
  bootstrapExpiresAt: number
  bootstrapUsed: boolean
  sessionTtlMs: number
  sessions: Map<string, number>
}

/**
 * 启动一个隔离的本地开发实例。调用方负责在退出时 close()。
 */
export async function createDevServer(
  options: DevServerOptions = {},
): Promise<DevServer> {
  const logger = options.logger ?? console
  const clock = options.clock ?? systemClock
  const port = validatePort(options.port ?? DEFAULT_PORT)
  const bootstrapTtlMs = validateTtl(
    options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS,
    'bootstrapTtlMs',
  )
  const sessionTtlMs = validateTtl(
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    'sessionTtlMs',
  )
  const configDir = resolve(
    options.configDir ?? fileURLToPath(new URL('../../config/examples', import.meta.url)),
  )
  const dataDir = resolve(
    options.dataDir ?? fileURLToPath(new URL('../../tmp/dev-data', import.meta.url)),
  )
  if (configDir === dataDir) {
    throw new Error('configDir and dataDir must be different directories')
  }

  const loaded = loadConfigFromDirectory(configDir)
  const modelMode = options.modelMode ?? 'mock'
  const runtime = await createModelRuntime(loaded, {
    configDir,
    mode: modelMode,
  })
  const model = runtime.chat
  const visionModel = runtime.vision
  const readOnly =
    configDir ===
    fileURLToPath(new URL('../../config/examples', import.meta.url))
  const models = new ModelSettingsService({
    configDir,
    loaded,
    readOnly,
  })
  const channels = new ChannelSettingsService({
    configDir,
    loaded,
    secretStore: new LocalSecretStore(configDir),
    readOnly,
    runtimeStatus: () => ({
      enabled: false,
      ownerQqConfigured: false,
      connection: null,
    }),
  })

  let storage: KanobotStorage | undefined
  let server: Server | undefined
  let disposeSurface: (() => void) | undefined
  let scheduler: InitiativeScheduler | undefined
  try {
    storage = KanobotStorage.openFromConfig(loaded, dataDir, clock)
    storage.maybeCreateDailyBackup()
    const memory = new KanobotMemoryService(storage, clock, {
      recall: loaded.memory.recall,
      candidateArchiveDays: loaded.memory.candidateArchiveDays,
    })
    const audit = new OwnerAuditService(storage, clock)
    const timeline = new AuditTimelineService(storage)
    const emergency = new KanobotEmergencyService(
      storage,
      storage.dataDir,
      loaded.policy.emergency.stopFile,
    )
    const initiative = new KanobotInitiativeService(
      storage,
      model.mode === 'mock'
        ? new MockInitiativeBrain()
        : new ModelInitiativeBrain({
            model,
            storage,
            clock,
            dailyModelCallLimit:
              loaded.system.resources.dailyModelCallLimit,
            maxConcurrentModelCalls:
              loaded.system.resources.maxConcurrentModelCalls,
          }),
      {
        config: loaded.initiative,
        timezone: loaded.system.time.timezone,
        quietHoursStart: loaded.system.time.quietHoursStart,
        quietHoursEnd: loaded.system.time.quietHoursEnd,
        emergency,
        memory,
        clock,
      },
    )
    const chat = new KanobotChatService(storage, model, {
      maxConcurrentModelCalls:
        loaded.system.resources.maxConcurrentModelCalls,
      dailyModelCallLimit:
        loaded.system.resources.dailyModelCallLimit,
      memory,
      context: loaded.system.context,
      vision: visionModel === null
        ? undefined
        : {
            model: visionModel,
            maxImageBytes: loaded.system.vision.maxImageBytes,
            maxDescriptionChars:
              loaded.system.vision.maxDescriptionChars,
          },
      initiative: {
        remindersEnabled: loaded.initiative.reminders.enabled,
        maxReminderDaysAhead: loaded.initiative.reminders.maxDaysAhead,
        followUpsEnabled: loaded.initiative.proactive.followUpsEnabled,
        followUpWindowHours:
          loaded.initiative.proactive.followUpWindowHours,
        followUpMaxDaysAhead:
          loaded.initiative.proactive.followUpMaxDaysAhead,
      },
      timezone: loaded.system.time.timezone,
      clock,
    })

    const rawBootstrapToken = randomBytes(32).toString('base64url')
    const auth: DevAuthState = {
      bootstrapTokenHash: hashSecret(rawBootstrapToken),
      bootstrapExpiresAt: clock.now().getTime() + bootstrapTtlMs,
      bootstrapUsed: false,
      sessionTtlMs,
      sessions: new Map<string, number>(),
    }

    let routeHandler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void> = () => {
      throw new Error('Kanobot dev route was not registered')
    }
    disposeSurface = registerChatSurface({
      webServer: {
        register(route): () => void {
          if (route.path !== CHAT_BASE_PATH) {
            throw new Error(`unexpected dev route path "${route.path}"`)
          }
          routeHandler = route.handler
          return () => {
            routeHandler = () => {
              throw new Error('Kanobot dev route has been disposed')
            }
          }
        },
      },
      connection: {
        admit(request) {
          return admitDevSession(request.headers.cookie, auth, clock)
        },
      },
      chat,
      memory,
      audit,
      timeline,
      emergency,
      initiative,
      models,
      channels,
      logger,
      auth: {
        unauthenticatedMessage:
          '本地开发会话无效或已过期；请使用启动终端打印的一次性地址重新打开',
        forbiddenMessage: '本地开发入口拒绝了这次请求来源',
        showLoginLink: false,
      },
    })

    let expectedHost = ''
    server = createServer((request, response) => {
      void handleDevRequest({
        request,
        response,
        expectedHost: () => expectedHost,
        auth,
        clock,
        routeHandler: (req, res) => routeHandler(req, res),
      }).catch(error => {
        logger.error?.(`[kanobot-dev] request failed: ${formatError(error)}`)
        if (!response.headersSent) {
          writeDevError(response, 500, '服务器内部错误')
        } else if (!response.destroyed) {
          response.destroy()
        }
      })
    })

    await new Promise<void>((resolveListen, rejectListen) => {
      server?.once('error', rejectListen)
      server?.listen(port, '127.0.0.1', () => {
        server?.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address() as AddressInfo | null
    if (address === null) {
      throw new Error('dev server did not expose a listening address')
    }
    expectedHost = `127.0.0.1:${address.port}`
    const baseUrl = `http://${expectedHost}`
    scheduler = new InitiativeScheduler({
      service: initiative,
      intervalMs: loaded.initiative.schedule.tickSeconds * 1_000,
      logger,
    })
    scheduler.start()

    logger.info(
      `[kanobot-dev] listening on ${baseUrl}${CHAT_BASE_PATH}/; ` +
        `config=${configDir}; data=${storage.dataDir}; modelMode=${modelMode}`,
    )
    logger.info(
      `[kanobot-dev] one-time login: ${baseUrl}${CHAT_BASE_PATH}/` +
        `?token=${rawBootstrapToken}`,
    )

    const devServer: DevServer = {
      baseUrl,
      bootstrapUrl:
        `${baseUrl}${CHAT_BASE_PATH}/?token=${encodeURIComponent(rawBootstrapToken)}`,
      port: address.port,
      async close(): Promise<void> {
        disposeSurface?.()
        disposeSurface = undefined
        await scheduler?.dispose()
        scheduler = undefined
        const activeServer = server
        server = undefined
        if (activeServer !== undefined) {
          await closeHttpServer(activeServer)
        }
        storage?.close()
        storage = undefined
      },
    }
    return devServer
  } catch (error) {
    disposeSurface?.()
    await scheduler?.dispose().catch(() => {})
    if (server !== undefined) {
      await closeHttpServer(server).catch(() => {})
    }
    try {
      storage?.close()
    } catch (closeError) {
      throw new StorageError(
        'IO',
        `${formatError(error)}; additionally failed to close dev storage: ${formatError(closeError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

interface DevRequestContext {
  request: IncomingMessage
  response: ServerResponse
  expectedHost: () => string
  auth: DevAuthState
  clock: Clock
  routeHandler: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void | Promise<void>
}

async function handleDevRequest(context: DevRequestContext): Promise<void> {
  const { request, response, auth, clock } = context
  const host = context.expectedHost()
  if (request.headers.host !== host) {
    writeDevError(response, 403, 'Host 不被允许')
    return
  }
  const origin = request.headers.origin
  if (origin !== undefined && origin !== `http://${host}`) {
    writeDevError(response, 403, '请求来源不被允许')
    return
  }

  const url = new URL(request.url ?? '/', `http://${host}`)
  if (
    (url.pathname === CHAT_BASE_PATH ||
      url.pathname === `${CHAT_BASE_PATH}/`) &&
    url.searchParams.has('token')
  ) {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET')
      writeDevError(response, 405, '登录链接只允许 GET')
      return
    }
    exchangeBootstrapToken(url.searchParams.get('token') ?? '', auth, clock, response)
    return
  }

  await context.routeHandler(request, response)
}

function exchangeBootstrapToken(
  token: string,
  auth: DevAuthState,
  clock: Clock,
  response: ServerResponse,
): void {
  const now = clock.now().getTime()
  const candidate = hashSecret(token)
  const matches =
    candidate.length === auth.bootstrapTokenHash.length &&
    timingSafeEqual(candidate, auth.bootstrapTokenHash)
  if (
    !matches ||
    auth.bootstrapUsed ||
    now > auth.bootstrapExpiresAt
  ) {
    writeDevError(
      response,
      401,
      '本地开发登录链接无效或已过期；请重新启动开发服务器',
    )
    return
  }

  auth.bootstrapUsed = true
  const session = randomBytes(32).toString('base64url')
  const expiresAt = now + auth.sessionTtlMs
  auth.sessions.set(hashSecret(session).toString('hex'), expiresAt)
  purgeExpiredSessions(auth, now)
  response.writeHead(303, {
    ...DEV_SECURITY_HEADERS,
    location: `${CHAT_BASE_PATH}/`,
    'set-cookie':
      `${DEV_COOKIE}=${session}; Path=${CHAT_BASE_PATH}; ` +
      `HttpOnly; SameSite=Strict; Max-Age=${Math.floor(auth.sessionTtlMs / 1000)}`,
  })
  response.end()
}

function admitDevSession(
  cookieHeader: string | undefined,
  auth: DevAuthState,
  clock: Clock,
): { peer: unknown } | { rejection: 401 } {
  const session = parseCookie(cookieHeader, DEV_COOKIE)
  if (session === null) return { rejection: 401 }
  const key = hashSecret(session).toString('hex')
  const now = clock.now().getTime()
  purgeExpiredSessions(auth, now)
  const expiresAt = auth.sessions.get(key)
  if (expiresAt === undefined || now > expiresAt) {
    auth.sessions.delete(key)
    return { rejection: 401 }
  }
  return { peer: { kind: 'dev-owner' } }
}

function purgeExpiredSessions(auth: DevAuthState, now: number): void {
  for (const [key, expiresAt] of auth.sessions) {
    if (now > expiresAt) auth.sessions.delete(key)
  }
}

function parseCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value === '' ? null : value
  }
  return null
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function writeDevError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  if (response.headersSent || response.destroyed) return
  const body = Buffer.from(`${message}\n`, 'utf8')
  response.writeHead(status, {
    ...DEV_SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  response.end(body)
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => {
      if (error) rejectClose(error)
      else resolveClose()
    })
    server.closeAllConnections()
  })
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError('port must be an integer between 0 and 65535')
  }
  return value
}

function validateTtl(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_MS) {
    throw new RangeError(
      `${field} must be an integer between 1 and ${MAX_TTL_MS}`,
    )
  }
  return value
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
