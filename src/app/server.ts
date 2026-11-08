/**
 * Kanobot 正式独立程序入口。
 *
 * 与 src/dev 的开发服务器语义分开：调用方必须显式提供配置目录和数据目录；
 * 页面与 API 只监听 127.0.0.1，并用本进程生成的一次性 bootstrap token
 * 换取短期 HttpOnly Cookie。运行时只复用 core、存储迁移、备份和 Web 表面，
 * 不依赖 DSH 宿主，也不默认使用仓库示例或临时目录。
 */

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_CONVERSATION_ID,
  ChatModelBudget,
  KanobotChatService,
  mergeOwnerConversationHistory,
  type ChatServiceOptions,
} from '../core/chat/index.ts'
import {
  OneBotClient,
  QqChannel,
  resolveQqAccessToken,
} from '../channels/index.ts'
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
} from '../web/index.ts'
import {
  LocalSecretStore,
  createModelRuntime,
} from '../model-providers/index.ts'
import {
  ChannelSettingsService,
  ModelSettingsService,
} from '../settings/index.ts'

const APP_COOKIE = 'kanobot_app_session'
const DEFAULT_PORT = 4200
const DEFAULT_BOOTSTRAP_TTL_MS = 10 * 60 * 1000
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000

const APP_SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export interface AppServerOptions {
  /** 正式运行配置目录；没有默认值，避免误用仓库示例。 */
  configDir: string
  /** 正式数据目录；没有默认值，避免误用临时数据。 */
  dataDir: string
  port?: number
  clock?: Clock
  bootstrapTtlMs?: number
  sessionTtlMs?: number
  logger?: ChatLogger
}

export interface AppServer {
  baseUrl: string
  /** 只应出现在启动终端或本机受保护日志中。 */
  bootstrapUrl: string
  port: number
  close(): Promise<void>
}

interface AppAuthState {
  bootstrapTokenHash: Buffer
  bootstrapExpiresAt: number
  bootstrapUsed: boolean
  sessionTtlMs: number
  sessions: Map<string, number>
}

interface AppRequestContext {
  request: IncomingMessage
  response: ServerResponse
  expectedHost: () => string
  auth: AppAuthState
  clock: Clock
  routeHandler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>
}

export async function createAppServer(
  options: AppServerOptions,
): Promise<AppServer> {
  const logger = options.logger ?? console
  const clock = options.clock ?? systemClock
  const configDir = requireDirectoryOption(options.configDir, 'configDir')
  const dataDir = requireDirectoryOption(options.dataDir, 'dataDir')
  if (configDir === dataDir) {
    throw new Error('configDir and dataDir must be different directories')
  }
  const port = validatePort(options.port ?? DEFAULT_PORT)
  const bootstrapTtlMs = validateTtl(
    options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS,
    'bootstrapTtlMs',
  )
  const sessionTtlMs = validateTtl(
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    'sessionTtlMs',
  )

  const loaded = loadConfigFromDirectory(configDir)
  const runtime = await createModelRuntime(loaded, { configDir })
  const secretStore = new LocalSecretStore(configDir)
  const model = runtime.chat
  const visionModel = runtime.vision
  const models = new ModelSettingsService({
    configDir,
    loaded,
    readOnly: configDir === bundledExamplesDir(),
  })

  let storage: KanobotStorage | undefined
  let server: Server | undefined
  let disposeSurface: (() => void) | undefined
  let scheduler: InitiativeScheduler | undefined
  let qqChannel: QqChannel | undefined
  let closed = false

  try {
    storage = KanobotStorage.openFromConfig(loaded, dataDir, clock)
    // 先做当日备份，再做历史归属迁移；这样首次回填前仍保留一份可恢复
    // 的当日快照，备份失败也会在修改数据前阻止启动。
    storage.maybeCreateDailyBackup()
    // 所有者 QQ 的配置可能晚于首条私聊到达数据库。启动时做一次幂等
    // 归属迁移，把已有 qq-private-<owner> 历史并入唯一主会话；消息正文、
    // seq 和 model_calls 都不复制，只移动 conversation_id。
    const ownerQqId = loaded.channels.qq.ownerQqId
    if (ownerQqId !== null) {
      mergeOwnerConversationHistory(storage, ownerQqId)
    }
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
    // 网页和所有 QQ 会话共享同一份并发与每日预留，避免渠道分叉后
    // 各自维护计数器而绕过 system.toml 的资源上限。
    const chatModelBudget = new ChatModelBudget({
      maxConcurrentModelCalls:
        loaded.system.resources.maxConcurrentModelCalls,
      dailyModelCallLimit: loaded.system.resources.dailyModelCallLimit,
    })
    const baseChatOptions: ChatServiceOptions = {
      modelBudget: chatModelBudget,
      memory,
      context: loaded.system.context,
      vision: visionModel === null
        ? undefined
        : {
            model: visionModel,
            maxImageBytes: loaded.system.vision.maxImageBytes,
            maxDescriptionChars: loaded.system.vision.maxDescriptionChars,
          },
      initiative: {
        remindersEnabled: loaded.initiative.reminders.enabled,
        maxReminderDaysAhead: loaded.initiative.reminders.maxDaysAhead,
        followUpsEnabled: loaded.initiative.proactive.followUpsEnabled,
        followUpWindowHours:
          loaded.initiative.proactive.followUpWindowHours,
        followUpMaxDaysAhead:
          loaded.initiative.proactive.followUpMaxDaysAhead,
        isAutonomousAllowed: () => !emergency.status().stopped,
      },
      timezone: loaded.system.time.timezone,
      clock,
    }
    const chat = new KanobotChatService(storage, model, baseChatOptions)
    // 状态接口必须报告“正在运行的”QQ 渠道配置，而不是刚保存但尚未
    // 重启的 overlay，否则页面会误以为 owner_qq 已经生效。
    const activeOwnerQqId = loaded.channels.qq.ownerQqId
    if (loaded.channels.qq.enabled) {
      const qqConfig = loaded.channels.qq
      qqChannel = new QqChannel({
        config: qqConfig,
        storage,
        emergency,
        gateway: new OneBotClient({
          url: qqConfig.wsUrl,
          token: resolveQqAccessToken(qqConfig, secretStore),
          connectTimeoutMs: qqConfig.connectTimeoutMs,
          actionTimeoutMs: qqConfig.actionTimeoutMs,
          reconnectMinMs: qqConfig.reconnectMinMs,
          reconnectMaxMs: qqConfig.reconnectMaxMs,
          pingIntervalMs: qqConfig.pingIntervalMs,
          logger,
        }),
        createChat: conversationId => {
          // 所有者 QQ 私聊复用网页主会话，确保上下文和记忆连续；
          // 其他私聊/群聊不读取也不写入所有者记忆，也不能创建面向
          // 所有者的提醒或后续关心候选。
          if (conversationId === CHAT_CONVERSATION_ID) return chat
          return new KanobotChatService(
            storage as KanobotStorage,
            model,
            {
              modelBudget: chatModelBudget,
              context: loaded.system.context,
              vision: visionModel === null
                ? undefined
                : {
                    model: visionModel,
                    maxImageBytes: loaded.system.vision.maxImageBytes,
                    maxDescriptionChars:
                      loaded.system.vision.maxDescriptionChars,
                    maxImages: qqConfig.coalesce.maxImages,
                  },
              timezone: loaded.system.time.timezone,
              clock,
              conversationId,
            },
          )
        },
        maxImageBytes: loaded.system.vision.maxImageBytes,
        logger,
        clock,
      })
    }
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
        outboxTarget: qqChannel?.outboxTarget ?? 'web:owner',
        externalOutbox: qqChannel,
        clock,
      },
    )
    const channels = new ChannelSettingsService({
      configDir,
      loaded,
      secretStore,
      readOnly: configDir === bundledExamplesDir(),
      runtimeStatus: () => ({
        enabled: qqChannel !== undefined,
        ownerQqConfigured: activeOwnerQqId !== null,
        connection: qqChannel?.connection() ?? null,
      }),
    })

    const rawBootstrapToken = randomBytes(32).toString('base64url')
    const auth: AppAuthState = {
      bootstrapTokenHash: hashSecret(rawBootstrapToken),
      bootstrapExpiresAt: clock.now().getTime() + bootstrapTtlMs,
      bootstrapUsed: false,
      sessionTtlMs,
      sessions: new Map(),
    }

    let routeHandler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void> = () => {
      throw new Error('Kanobot app route was not registered')
    }
    disposeSurface = registerChatSurface({
      webServer: {
        register(route): () => void {
          if (route.path !== CHAT_BASE_PATH) {
            throw new Error(`unexpected app route path "${route.path}"`)
          }
          routeHandler = route.handler
          return () => {
            routeHandler = () => {
              throw new Error('Kanobot app route has been disposed')
            }
          }
        },
      },
      connection: {
        admit(request) {
          return admitAppSession(request.headers.cookie, auth, clock)
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
          '独立程序会话无效或已过期；请使用启动终端打印的一次性地址重新打开',
        forbiddenMessage: '独立程序拒绝了这次请求来源',
        showLoginLink: false,
      },
    })

    let expectedHost = ''
    server = createServer((request, response) => {
      void handleAppRequest({
        request,
        response,
        expectedHost: () => expectedHost,
        auth,
        clock,
        routeHandler: (req, res) => routeHandler(req, res),
      }).catch(error => {
        logger.error?.(`[kanobot-app] request failed: ${formatError(error)}`)
        if (!response.headersSent) {
          writeAppError(response, 500, '服务器内部错误')
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
      throw new Error('app server did not expose a listening address')
    }
    expectedHost = `127.0.0.1:${address.port}`
    const baseUrl = `http://${expectedHost}`
    scheduler = new InitiativeScheduler({
      service: initiative,
      intervalMs: loaded.initiative.schedule.tickSeconds * 1_000,
      logger,
    })
    scheduler.start()
    qqChannel?.start()

    logger.info(
      `[kanobot-app] listening on ${baseUrl}${CHAT_BASE_PATH}/; ` +
        `config=${configDir}; data=${storage.dataDir}; ` +
        `provider=${model.provider}; model=${model.id}; ` +
        `qq=${loaded.channels.qq.enabled ? 'enabled' : 'disabled'}`,
    )
    logger.info(
      `[kanobot-app] one-time login: ${baseUrl}${CHAT_BASE_PATH}/` +
        `?token=${rawBootstrapToken}`,
    )

    const appServer: AppServer = {
      baseUrl,
      bootstrapUrl:
        `${baseUrl}${CHAT_BASE_PATH}/?token=` +
        encodeURIComponent(rawBootstrapToken),
      port: address.port,
      async close(): Promise<void> {
        if (closed) return
        closed = true
        disposeSurface?.()
        disposeSurface = undefined
        await scheduler?.dispose()
        scheduler = undefined
        await qqChannel?.close()
        qqChannel = undefined
        const activeServer = server
        server = undefined
        if (activeServer !== undefined) {
          await closeHttpServer(activeServer)
        }
        storage?.close()
        storage = undefined
      },
    }
    return appServer
  } catch (error) {
    disposeSurface?.()
    await scheduler?.dispose().catch(() => {})
    await qqChannel?.close().catch(() => {})
    qqChannel = undefined
    if (server !== undefined) {
      await closeHttpServer(server).catch(() => {})
    }
    try {
      storage?.close()
    } catch (closeError) {
      throw new StorageError(
        'IO',
        `${formatError(error)}; additionally failed to close app storage: ` +
          formatError(closeError),
        { cause: error },
      )
    }
    throw error
  }
}

async function handleAppRequest(context: AppRequestContext): Promise<void> {
  const { request, response, auth, clock } = context
  const host = context.expectedHost()
  if (request.headers.host !== host) {
    writeAppError(response, 403, 'Host 不被允许')
    return
  }
  const origin = request.headers.origin
  if (origin !== undefined && origin !== `http://${host}`) {
    writeAppError(response, 403, '请求来源不被允许')
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
      writeAppError(response, 405, '登录链接只允许 GET')
      return
    }
    exchangeBootstrapToken(
      url.searchParams.get('token') ?? '',
      auth,
      clock,
      response,
    )
    return
  }

  if (url.pathname === '/' && request.method === 'GET') {
    response.writeHead(303, {
      ...APP_SECURITY_HEADERS,
      location: `${CHAT_BASE_PATH}/`,
    })
    response.end()
    return
  }

  await context.routeHandler(request, response)
}

function exchangeBootstrapToken(
  token: string,
  auth: AppAuthState,
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
    writeAppError(
      response,
      401,
      '独立程序登录链接无效或已过期；请重新启动独立程序',
    )
    return
  }

  auth.bootstrapUsed = true
  const session = randomBytes(32).toString('base64url')
  const expiresAt = now + auth.sessionTtlMs
  auth.sessions.set(hashSecret(session).toString('hex'), expiresAt)
  purgeExpiredSessions(auth, now)
  response.writeHead(303, {
    ...APP_SECURITY_HEADERS,
    location: `${CHAT_BASE_PATH}/`,
    'set-cookie':
      `${APP_COOKIE}=${session}; Path=${CHAT_BASE_PATH}; ` +
      `HttpOnly; SameSite=Strict; Max-Age=` +
      `${Math.floor(auth.sessionTtlMs / 1000)}`,
  })
  response.end()
}

function admitAppSession(
  cookieHeader: string | undefined,
  auth: AppAuthState,
  clock: Clock,
): { peer: unknown } | { rejection: 401 } {
  const session = parseCookie(cookieHeader, APP_COOKIE)
  if (session === null) return { rejection: 401 }
  const key = hashSecret(session).toString('hex')
  const now = clock.now().getTime()
  purgeExpiredSessions(auth, now)
  const expiresAt = auth.sessions.get(key)
  if (expiresAt === undefined || now > expiresAt) {
    auth.sessions.delete(key)
    return { rejection: 401 }
  }
  return { peer: { kind: 'app-owner' } }
}

function purgeExpiredSessions(auth: AppAuthState, now: number): void {
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

function writeAppError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  if (response.headersSent || response.destroyed) return
  const body = Buffer.from(`${message}\n`, 'utf8')
  response.writeHead(status, {
    ...APP_SECURITY_HEADERS,
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

function requireDirectoryOption(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be provided explicitly`)
  }
  return resolve(value)
}

function bundledExamplesDir(): string {
  return resolve(
    fileURLToPath(new URL('../../config/examples', import.meta.url)),
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
