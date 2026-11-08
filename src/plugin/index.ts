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
import { fileURLToPath } from 'node:url'

import { loadConfigFromDirectory } from '../core/config/index.ts'
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
import {
  LocalSecretStore,
  createModelRuntime,
  type DshLlmBridge,
  type ModelProviderMode,
} from '../model-providers/index.ts'
import {
  ChannelSettingsService,
  ModelSettingsService,
} from '../settings/index.ts'
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.ts'

// `llm` 只在 provider = "dsh" 时需要；mock、Magpie 和第三方 HTTP provider
// 不应因为宿主没有挂载 DSH 模型服务而拒绝启动。缺少 ctx.llm 时由 provider
// 工厂在真正选择 dsh 后 fail-closed。
export const inject = ['webServer', 'connection']

export interface KanobotPluginConfig {
  configDir?: string
  dataDir?: string
  heartbeatMs?: number
  startupReportPath?: string
  /**
   * 仅用于测试强制 mock 的旧 Profile 兼容字段。
   * 真实 provider 必须由配置和设置页决定，不能再被旧 Profile 的值遮蔽。
   */
  modelMode?: ModelProviderMode
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
  /**
   * Cordis 只允许通过 reflect 读取未在 inject 中声明为必需的服务。
   * `llm` 不是所有宿主都必须提供的能力，因此不能直接读取 `ctx.llm`。
   */
  reflect: {
    get(name: string): unknown
  }
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
  let qqChannel: QqChannel | undefined
  let disposeChatSurface: (() => void) | undefined
  const modelMode = config.modelMode
  if (
    modelMode !== undefined &&
    modelMode !== 'mock' &&
    modelMode !== 'magpie' &&
    modelMode !== 'dsh' &&
    modelMode !== 'openai-compatible'
  ) {
    throw new Error(`unsupported modelMode "${String(modelMode)}"`)
  }

  try {
    // 聊天、记忆和存储共用同一个真实时钟；测试可替换为手动时钟，
    // 避免提示词里的“现在”和消息/审计时间来自不同时间源。
    const clock = systemClock
    const llm = resolveOptionalLlm(ctx)
    // 真实模型模式必须在打开数据库和注册定时器之前完成精确模型检查。
    // 检查失败时拒绝激活，不自动降级到 mock 或另一个模型。
    const runtime = await createModelRuntime(loaded, {
      configDir,
      llm,
      // 旧 Profile 的 `modelMode: magpie` 是历史默认值，不应覆盖设置页
      // 保存的真实 provider；只有测试需要的强制 mock 继续保留。
      ...(modelMode === 'mock' ? { mode: 'mock' as const } : {}),
    })
    const secretStore = new LocalSecretStore(configDir)
    const model = runtime.chat
    // 视觉模型独立配置；未启用时保持为 null，带图请求会在落库前明确失败。
    const visionModel = runtime.vision
    const models = new ModelSettingsService({
      configDir,
      loaded,
      llm,
      readOnly: configDir === bundledExamplesDir(),
    })
    // 数据库损坏、schema 不兼容或路径逃逸都会在这里阻止插件继续激活。
    storage = KanobotStorage.openFromConfig(loaded, dataDir, clock)
    // 备份失败也必须阻止“看似启动成功”：日备份是 M2 的数据安全边界。
    // 先备份再回填，确保首次迁移既有历史前仍有一份当日快照。
    storage.maybeCreateDailyBackup()
    // 所有者 QQ 可能是在已有私聊之后才配置的；启动时幂等迁移旧归属，
    // 让网页 main 与后续 QQ 所有者消息共享同一段连续历史。
    const ownerQqId = loaded.channels.qq.ownerQqId
    if (ownerQqId !== null) {
      mergeOwnerConversationHistory(storage, ownerQqId)
    }
    const memory = new KanobotMemoryService(storage, clock, {
      recall: loaded.memory.recall,
      candidateArchiveDays: loaded.memory.candidateArchiveDays,
    })
    const audit = new OwnerAuditService(storage)
    const timeline = new AuditTimelineService(storage)
    const emergency = new KanobotEmergencyService(
      storage,
      storage.dataDir,
      loaded.policy.emergency.stopFile,
    )
    // 插件宿主里的网页和 QQ 会话也必须共用一个预算对象；不能因为
    // QqChannel 懒创建 chat 服务就各自拿走一份每日额度。
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
    // owner_qq 只有在实例重启后才会进入 QQ 路由；状态接口据此显示
    // “保存后待重启”，不能让页面把磁盘配置误当成运行时状态。
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
          logger: ctx.logger,
        }),
        createChat: conversationId => {
          // 只有显式 owner_qq 的私聊会映射到 main 并复用网页会话。
          // 其他会话不读写所有者记忆，也不提交提醒/关心候选。
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
        logger: ctx.logger,
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
    // 启动时把 STOP 文件同步进数据库；删除文件不会自动恢复。
    const emergencyStatus = emergency.status()
    disposeChatSurface = registerChatSurface({
      webServer: ctx.webServer,
      connection: ctx.connection,
      chat,
      memory,
      audit,
      timeline,
      emergency,
      initiative,
      models,
      channels,
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
    qqChannel?.start()

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
        modelMode: model.mode,
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
        qqEnabled: loaded.channels.qq.enabled,
        qqAutonomousTarget: qqChannel?.outboxTarget ?? null,
      })
    }

    ctx.logger.info(
      `[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} loaded; ` +
        `config=${configDir}; database=${storage.databasePath}; ` +
        `chat=${CHAT_BASE_PATH}/; modelMode=${model.mode}; ` +
        `provider=${chat.identity().provider}; ` +
        `model=${chat.identity().id}; identity=${loaded.identity.mode}; ` +
        `vision=${visionModel === null ? 'disabled' : `${visionModel.provider}:${visionModel.id}`}; ` +
        `qq=${loaded.channels.qq.enabled ? 'enabled' : 'disabled'}; ` +
        `emergencyStopped=${emergencyStatus.stopped}`,
    )

    // DSH 卸载插件时会调用这个 disposer，所有需要释放的资源都从这里收口。
    ctx.effect(() => () => {
      disposeChatSurface?.()
      const activeStorage = storage
      const activeScheduler = scheduler
      const activeQq = qqChannel
      scheduler = undefined
      qqChannel = undefined
      const closeStorage = (): void => {
        storage = undefined
        activeStorage?.close()
      }
      if (activeQq !== undefined) {
        void (async () => {
          await activeScheduler?.dispose()
          await activeQq.close()
          closeStorage()
        })().catch(error => {
          ctx.logger.error?.(
            `[kanobot] unload cleanup failed: ${formatError(error)}`,
          )
        })
      } else if (activeScheduler === undefined) {
        closeStorage()
      } else {
        const idle = activeScheduler.disposeSync()
        if (idle) {
          closeStorage()
        } else {
          void activeScheduler.dispose().finally(() => {
            closeStorage()
          })
        }
      }
      ctx.logger.info(`[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} unloaded`)
    })
  } catch (error) {
    // 初始化过程中任何一步失败都不能留下定时器或打开的数据库。
    disposeChatSurface?.()
    await scheduler?.dispose()
    await qqChannel?.close().catch(() => {})
    qqChannel = undefined
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

function resolveOptionalLlm(
  ctx: PluginContext,
): DshLlmBridge | undefined {
  // 用 reflect.get 读取可选服务：Cordis 对未 inject 的 ctx.llm 会直接拒绝，
  // 即便宿主的其他服务已经就绪。
  const candidate = ctx.reflect.get('llm')
  if (candidate === undefined || candidate === null) return undefined
  if (
    typeof candidate !== 'object' ||
    typeof (candidate as DshLlmBridge).listProviders !== 'function' ||
    typeof (candidate as DshLlmBridge).resolveModelInfo !== 'function' ||
    typeof (candidate as DshLlmBridge).prepareCall !== 'function'
  ) {
    throw new Error('host llm service is present but does not expose the DSH bridge')
  }
  return candidate as DshLlmBridge
}

function bundledExamplesDir(): string {
  return resolve(
    fileURLToPath(new URL('../../config/examples', import.meta.url)),
  )
}

export { PLUGIN_NAME, PLUGIN_VERSION }
