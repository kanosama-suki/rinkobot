/**
 * Kanobot 的 DSH Host 入口。
 *
 * 这一层只负责宿主适配：定位配置、校验配置、创建生命周期和报告启动结果。
 * 陪伴核心不依赖 DSH；后续业务模块由这里装配，而不是直接耦合宿主 API。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { loadConfigFromDirectory } from '../core/config/index.ts'
import { createPluginLifecycle } from './lifecycle.ts'
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.ts'

export interface KanobotPluginConfig {
  configDir?: string
  heartbeatMs?: number
  startupReportPath?: string
}

interface PluginLogger {
  info(message: string): void
}

interface PluginContext {
  logger: PluginLogger
  effect(callback: () => () => void): () => void
}

export function apply(
  ctx: PluginContext,
  config: KanobotPluginConfig = {},
): void {
  // 配置错误必须在注册定时器之前暴露，否则插件会留下半初始化资源。
  const configDir = resolveConfigDir(config)
  const loaded = loadConfigFromDirectory(configDir)
  const lifecycle = createPluginLifecycle({ heartbeatMs: config.heartbeatMs })

  if (config.startupReportPath !== undefined) {
    // 外部启动脚本用这份报告区分“插件真的激活了”和“宿主进程还在运行”。
    writeStartupReport(config.startupReportPath, {
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      startedAt: lifecycle.startedAt,
      pid: process.pid,
      configDir,
      provider: loaded.system.model.provider,
      model: loaded.system.model.name,
      identity: loaded.identity.mode,
    })
  }

  ctx.logger.info(
    `[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} loaded; ` +
      `config=${configDir}; provider=${loaded.system.model.provider}; ` +
      `model=${loaded.system.model.name}; identity=${loaded.identity.mode}`,
  )

  // DSH 卸载插件时会调用这个 disposer，所有需要释放的资源都从这里收口。
  ctx.effect(() => () => {
    lifecycle.dispose()
    ctx.logger.info(`[kanobot] ${PLUGIN_NAME} ${PLUGIN_VERSION} unloaded`)
  })
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

function writeStartupReport(path: string, report: Record<string, unknown>): void {
  // 首次启动时报告目录可能尚不存在，先创建父目录。
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export { PLUGIN_NAME, PLUGIN_VERSION }
