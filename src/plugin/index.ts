/**
 * Kanobot 的 DSH Host 入口。
 *
 * 这一层只负责宿主适配：定位配置、校验配置、打开存储、创建生命周期和
 * 报告启动结果。任何配置或数据库错误都发生在注册定时器之前；存储关闭
 * 与定时器清理统一由 disposer 收口。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { loadConfigFromDirectory } from '../core/config/index.ts'
import {
  KanobotChatService,
  MockChatModel,
} from '../core/chat/index.ts'
import {
  KanobotStorage,
  StorageError,
} from '../core/storage/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
  type ChatConnection,
  type ChatWebServer,
} from '../web/index.ts'
import { createPluginLifecycle } from './lifecycle.ts'
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.ts'

export const inject = ['webServer', 'connection']

export interface KanobotPluginConfig {
  configDir?: string
  dataDir?: string
  heartbeatMs?: number
  startupReportPath?: string
  modelMode?: 'mock'
}

interface PluginLogger {
  info(message: string): void
  error?(message: string): void
}

interface PluginContext {
  logger: PluginLogger
  effect(callback: () => () => void): () => void
  webServer: ChatWebServer
  connection: ChatConnection
}

export function apply(
  ctx: PluginContext,
  config: KanobotPluginConfig = {},
): void {
  // 配置错误必须在注册定时器之前暴露，否则插件会留下半初始化资源。
  const configDir = resolveConfigDir(config)
  const loaded = loadConfigFromDirectory(configDir)
  const dataDir = resolveDataDir(config)
  let storage: KanobotStorage | undefined
  let lifecycle: ReturnType<typeof createPluginLifecycle> | undefined
  let disposeChatSurface: (() => void) | undefined
  const modelMode = config.modelMode ?? 'mock'
  if (modelMode !== 'mock') {
    throw new Error(`unsupported modelMode "${String(modelMode)}"; M3.0 only supports mock`)
  }

  try {
    // 数据库损坏、schema 不兼容或路径逃逸都会在这里阻止插件继续激活。
    storage = KanobotStorage.openFromConfig(loaded, dataDir)
    // 备份失败也应阻止“看似启动成功”：日备份是 M2 的数据安全边界。
    storage.maybeCreateDailyBackup()
    const chat = new KanobotChatService(storage, new MockChatModel())
    disposeChatSurface = registerChatSurface({
      webServer: ctx.webServer,
      connection: ctx.connection,
      chat,
      logger: ctx.logger,
    })
    lifecycle = createPluginLifecycle({
      heartbeatMs: config.heartbeatMs,
      onHeartbeat: () => {
        if (storage === undefined) return
        try {
          storage.maybeCreateDailyBackup()
        } catch (error) {
          // 后台备份失败不能静默；记录后保留下一次重试机会。
          const message = `[kanobot] daily backup failed: ${formatError(error)}`
          if (ctx.logger.error) {
            ctx.logger.error(message)
          } else {
            ctx.logger.info(message)
          }
        }
      },
    })

    if (config.startupReportPath !== undefined) {
      // 外部启动脚本用这份报告区分“插件真的激活了”和“宿主进程还在运行”。
      writeStartupReport(config.startupReportPath, {
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        startedAt: lifecycle.startedAt,
        pid: process.pid,
        configDir,
        dataDir: storage.dataDir,
        database: storage.databasePath,
        tombstones: storage.tombstonePath,
        backupDir: storage.backupDir,
        chatPath: `${CHAT_BASE_PATH}/`,
        modelMode,
        provider: loaded.system.model.provider,
        model: loaded.system.model.name,
        identity: loaded.identity.mode,
      })
    }

    ctx.logger.info(
      `[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} loaded; ` +
        `config=${configDir}; database=${storage.databasePath}; ` +
        `chat=${CHAT_BASE_PATH}/; modelMode=${modelMode}; ` +
        `provider=${loaded.system.model.provider}; ` +
        `model=${loaded.system.model.name}; identity=${loaded.identity.mode}`,
    )

    // DSH 卸载插件时会调用这个 disposer，所有需要释放的资源都从这里收口。
    ctx.effect(() => () => {
      disposeChatSurface?.()
      lifecycle?.dispose()
      storage?.close()
      ctx.logger.info(`[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} unloaded`)
    })
  } catch (error) {
    // 初始化过程中任何一步失败都不能留下定时器或打开的数据库。
    disposeChatSurface?.()
    lifecycle?.dispose()
    try {
      storage?.close()
    } catch (closeError) {
      throw new StorageError(
        'IO',
        `${formatError(error)}; additionally failed to close storage: ${formatError(closeError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

function resolveConfigDir(config: KanobotPluginConfig): string {
  // 显式配置优先；否则跟随 DSH_HOME，最后才回退到用户目录下的 ~/.dsh。
  if (config.configDir !== undefined) {
    if (config.configDir.trim() === '') {
      throw new Error('configDir must not be empty')
    }
    return resolve(config.configDir)
  }

  const configuredHome = process.env.DSH_HOME?.trim()
  const dshHome = configuredHome ? configuredHome : resolve(homedir(), '.dsh')
  return resolve(dshHome, 'kanobot', 'config')
}

function resolveDataDir(config: KanobotPluginConfig): string {
  // 数据目录单独配置，默认与配置目录同级，但这些目录不进入源码仓库。
  if (config.dataDir !== undefined) {
    if (config.dataDir.trim() === '') {
      throw new Error('dataDir must not be empty')
    }
    return resolve(config.dataDir)
  }
  const configuredHome = process.env.DSH_HOME?.trim()
  const dshHome = configuredHome ? configuredHome : resolve(homedir(), '.dsh')
  return resolve(dshHome, 'kanobot', 'data')
}

function writeStartupReport(path: string, report: Record<string, unknown>): void {
  // 首次启动时报告目录可能尚不存在，先创建父目录。
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { PLUGIN_NAME, PLUGIN_VERSION }
