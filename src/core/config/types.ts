/**
 * system、identity、policy 三个配置文件的运行时类型。
 *
 * TOML 的 snake_case 字段由 loader 转成 camelCase；进入这些类型的值
 * 必须已经通过 schema、范围和跨文件校验。
 */

export const CONFIG_SCHEMA_VERSION = 1

export type Environment = 'development' | 'production'

export interface SystemConfig {
  schemaVersion: 1
  environment: Environment
  time: {
    timezone: string
    quietHoursStart: string
    quietHoursEnd: string
  }
  model: {
    provider: string
    name: string
    timeoutMs: number
    maxRetries: number
  }
  resources: {
    maxConcurrentModelCalls: number
    dailyModelCallLimit: number
  }
}

export type IdentityMode = 'placeholder' | 'private'

export interface IdentityConfig {
  schemaVersion: 1
  mode: IdentityMode
  displayName: string
  ownerName: string
  // 只有 private 模式需要人格文件，路径相对于 DSH 数据目录。
  personaFile?: string
}

export interface PolicyConfig {
  schemaVersion: 1
  tools: {
    allow: string[]
  }
  permissions: {
    allowShell: false
    allowFileWrite: false
    allowNetwork: false
    allowPublicPosting: false
  }
  limits: {
    maxReplyChars: number
    maxStepsPerTurn: number
  }
  emergency: {
    stopFile: string
  }
}

export interface LoadedConfig {
  system: SystemConfig
  identity: IdentityConfig
  policy: PolicyConfig
}
