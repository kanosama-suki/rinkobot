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
} from '../core/chat/index.ts'
import {
  KanobotMemoryService,
} from '../core/memory/index.ts'
import {
  AuditTimelineService,
  OwnerAuditService,
} from '../core/observability/index.ts'
import {
  InitiativeScheduler,
  KanobotInitiativeService,
  MockInitiativeBrain,
  ModelInitiativeBrain,
} from '../core/initiative/index.ts'
import { KanobotEmergencyService } from '../core/policy/index.ts'
import type { LoadedConfig } from '../core/config/index.ts'
import {
  KanobotStorage,
  StorageError,
} from '../core/storage/index.ts'
import { systemClock } from '../core/state/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
  type ChatConnection,
  type ChatWebServer,
} from '../web/index.ts'
import { createChatModel, createVisionModel } from './models.ts'
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.ts'

export const inject = ['webServer', 'connection']

export interface KanobotPluginConfig {
  configDir?: string
  dataDir?: string
  heartbeatMs?: number
  startupReportPath?: string
  modelMode?: 'mock' | 'magpie'
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

export async function apply(
  ctx: PluginContext,
  config: KanobotPluginConfig = {},
): Promise<void> {
  // 配置错误必须在注册定时器之前暴露，否则插件会留下半初始化资源。
  const configDir = resolveConfigDir(config)
  const loaded = loadConfigFromDirectory(configDir)
  const dataDir = resolveDataDir(config)
  let storage: KanobotStorage | undefined
  let scheduler: InitiativeScheduler | undefined
  let disposeChatSurface: (() => void) | undefined
  const modelMode = config.modelMode ?? 'mock'
  if (modelMode !== 'mock' && modelMode !== 'magpie') {
    throw new Error(`unsupported modelMode "${String(modelMode)}"`)
  }

  try {
    // 聊天、记忆和存储共用同一个真实时钟；测试可替换为手动时钟，
    // 避免提示词里的“现在”和消息/审计时间来自不同时间源。
    const clock = systemClock
    // 真实模型模式必须在打开数据库和注册定时器之前完成精确模型检查。
    // 检查失败时拒绝激活，不自动降级到 mock 或另一个模型。
    const model = await createChatModel(loaded, modelMode)
    // 视觉模型独立配置；未启用时保持为 null，带图请求会在落库前明确失败。
    const visionModel = await createVisionModel(loaded, modelMode)
    // 数据库损坏、schema 不兼容或路径逃逸都会在这里阻止插件继续激活。
    storage = KanobotStorage.openFromConfig(loaded, dataDir, clock)
    // 备份失败也应阻止“看似启动成功”：日备份是 M2 的数据安全边界。
    storage.maybeCreateDailyBackup()
    const memory = new KanobotMemoryService(storage, clock, {
      recall: loaded.memory.recall,
    })
    const audit = new OwnerAuditService(storage)
    const timeline = new AuditTimelineService(storage)
    const emergency = new KanobotEmergencyService(
      storage,
      storage.dataDir,
      loaded.policy.emergency.stopFile,
    )
    const initiative = new KanobotInitiativeService(
      storage,
      modelMode === 'mock'
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
    // 启动时把 STOP 文件同步进数据库；删除文件不会自动恢复。
    const emergencyStatus = emergency.status()
    const chat = new KanobotChatService(storage, model, {
      maxConcurrentModelCalls:
        loaded.system.resources.maxConcurrentModelCalls,
      dailyModelCallLimit: loaded.system.resources.dailyModelCallLimit,
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
      },
      timezone: loaded.system.time.timezone,
      clock,
    })
    disposeChatSurface = registerChatSurface({
      webServer: ctx.webServer,
      connection: ctx.connection,
      chat,
      memory,
      audit,
      timeline,
      emergency,
      initiative,
      logger: ctx.logger,
    })
    scheduler = new InitiativeScheduler({
      service: initiative,
      intervalMs:
        config.heartbeatMs ??
        loaded.initiative.schedule.tickSeconds * 1_000,
      logger: ctx.logger,
    })
    scheduler.start()

    if (config.startupReportPath !== undefined) {
      // 外部启动脚本用这份报告区分“插件真的激活了”和“宿主进程还在运行”。
      writeStartupReport(config.startupReportPath, {
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        startedAt: scheduler.startedAt,
        pid: process.pid,
        configDir,
        dataDir: storage.dataDir,
        database: storage.databasePath,
        tombstones: storage.tombstonePath,
        backupDir: storage.backupDir,
        chatPath: `${CHAT_BASE_PATH}/`,
        modelMode,
        provider: chat.identity().provider,
        model: chat.identity().id,
        configuredProvider: loaded.system.model.provider,
        configuredModel: loaded.system.model.name,
        visionEnabled: visionModel !== null,
        visionProvider: visionModel?.provider ?? null,
        visionModel: visionModel?.id ?? null,
        maxConcurrentModelCalls:
          loaded.system.resources.maxConcurrentModelCalls,
        dailyModelCallLimit: loaded.system.resources.dailyModelCallLimit,
        contextMaxPromptChars: loaded.system.context.maxPromptChars,
        timezone: loaded.system.time.timezone,
        memoryCount: memory.listViews('all').length,
        memoryCandidateCount: memory.listViews('candidate').length,
        ownerAuditCount: audit.count(),
        emergencyStopped: emergencyStatus.stopped,
        stopFilePresent: emergencyStatus.stopFilePresent,
        initiativeEnabled: loaded.initiative.proactive.enabled,
        initiativeTickSeconds: loaded.initiative.schedule.tickSeconds,
        identity: loaded.identity.mode,
      })
    }

    ctx.logger.info(
      `[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} loaded; ` +
        `config=${configDir}; database=${storage.databasePath}; ` +
        `chat=${CHAT_BASE_PATH}/; modelMode=${modelMode}; ` +
        `provider=${chat.identity().provider}; ` +
        `model=${chat.identity().id}; identity=${loaded.identity.mode}; ` +
        `vision=${visionModel === null ? 'disabled' : `${visionModel.provider}:${visionModel.id}`}; ` +
        `emergencyStopped=${emergencyStatus.stopped}`,
    )

    // DSH 卸载插件时会调用这个 disposer，所有需要释放的资源都从这里收口。
    ctx.effect(() => () => {
      disposeChatSurface?.()
      const activeStorage = storage
      const activeScheduler = scheduler
      scheduler = undefined
      if (activeScheduler === undefined) {
        activeStorage?.close()
      } else {
        const idle = activeScheduler.disposeSync()
        if (idle) {
          storage = undefined
          activeStorage?.close()
        } else {
          void activeScheduler.dispose().finally(() => {
            storage = undefined
            activeStorage?.close()
          })
        }
      }
      ctx.logger.info(`[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} unloaded`)
    })
  } catch (error) {
    // 初始化过程中任何一步失败都不能留下定时器或打开的数据库。
    disposeChatSurface?.()
    await scheduler?.dispose()
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
