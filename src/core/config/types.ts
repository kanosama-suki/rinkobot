/**
 * M2 必需配置文件的运行时类型。
 *
 * TOML 的 snake_case 字段由 loader 转成 camelCase；进入这些类型的值
 * 必须已经通过 schema、范围和跨文件校验。存储路径仍是相对数据目录的
 * 文本路径，绝对路径解析和目录逃逸检查由存储层在拿到 dataDir 后再做。
 */

export const CONFIG_SCHEMA_VERSION = 1

export type Environment = 'development' | 'production'

export interface VisionConfig {
  enabled: boolean
  provider: string | null
  name: string | null
  baseUrl: string | null
  apiKeyEnv: string | null
  timeoutMs: number
  maxRetries: number
  maxOutputTokens: number | null
  maxImageBytes: number
  maxDescriptionChars: number
}

export interface SystemConfig {
  schemaVersion: 1
  environment: Environment
  time: {
    timezone: string
    quietHoursStart: string
    quietHoursEnd: string
  }
  context: {
    maxPromptChars: number
    maxStateChars: number
    maxMemoryItems: number
    maxMemoryItemChars: number
    maxMemoryChars: number
    maxHistoryMessages: number
    maxHistoryChars: number
    maxMessageChars: number
  }
  model: {
    provider: string
    name: string
    baseUrl: string | null
    apiKeyEnv: string | null
    timeoutMs: number
    maxRetries: number
    maxOutputTokens: number | null
  }
  /**
   * 视觉模型完全独立于聊天模型。`enabled=false` 时只允许纯文字聊天；
   * 一旦接入图片就必须调用这个模型，不静默退回主模型或丢弃图片。
   */
  vision: VisionConfig
  resources: {
    maxConcurrentModelCalls: number
    dailyModelCallLimit: number
  }
  storage: {
    database: string
    tombstones: string
    backupDir: string
    snapshotEveryEvents: number
    snapshotIntervalHours: number
    backupRetention: number
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

export interface LifeStateConfig {
  schemaVersion: 1
  initial: {
    valence: number
    arousal: number
    energy: number
    socialBattery: number
    closeness: number
  }
  decayPerHour: {
    valence: number
    arousal: number
    energyAwake: number
    energyAsleepRecovery: number
    socialBatteryAwake: number
    socialBatteryAsleepRecovery: number
  }
  limits: {
    maxRelationshipDeltaPerEvent: number
    maxCommitments: number
  }
}

export interface MemoryConfig {
  schemaVersion: 1
  trash: {
    retentionDays: number
  }
  recall: {
    minRelevance: number
    candidateLimit: number
  }
}

export interface InitiativeConfig {
  schemaVersion: 1
  schedule: {
    tickSeconds: number
    dailyPlanAt: string
    dailyReviewAt: string
  }
  proactive: {
    enabled: boolean
    minIntervalMinutes: number
    maxIntervalMinutes: number
    chatCooldownMinutes: number
    circuitWindowMinutes: number
    circuitMaxMessages: number
    morningGreeting: boolean
    longSilenceHours: number
    unansweredSlowdownMultiplier: number
    followUpsEnabled: boolean
    followUpWindowHours: number
    followUpMaxDaysAhead: number
  }
  reminders: {
    enabled: boolean
    maxDaysAhead: number
  }
  outbox: {
    maxAttempts: number
    retryBackoffMinutes: number
    expireAfterMinutes: number
  }
  life: {
    enabled: boolean
    maxPlanItems: number
    dayStartAt: string
    dayEndAt: string
    itemGapMinutes: number
  }
  review: {
    enabled: boolean
    maxMessages: number
    maxAttemptsPerDay: number
  }
}

export interface LoadedConfig {
  system: SystemConfig
  identity: IdentityConfig
  lifeState: LifeStateConfig
  memory: MemoryConfig
  initiative: InitiativeConfig
  policy: PolicyConfig
}
