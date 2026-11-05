/**
 * M2 配置的严格加载器。
 *
 * 设计原则：
 * - 未知字段、错误类型、越界值和非法路径都拒绝，不做静默兜底；
 * - 先收集所有文件和字段的问题，再统一抛出，避免每次只暴露一个错误；
 * - identity 的校验依赖 system.environment，因此跨文件规则在这里收口；
 * - M2 新增文件是必需文件，缺失时不能悄悄用旧的一文件配置继续启动。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

import { ConfigError, ConfigFieldError } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import type {
  IdentityConfig,
  LifeStateConfig,
  LoadedConfig,
  MemoryConfig,
  PolicyConfig,
  SystemConfig,
} from './types.ts'
import {
  asTable,
  fail,
  joinField,
  knownKeys,
  requireQuietTime,
  requireSafeFileName,
  requireSafeRelativePath,
  requireSchemaVersion,
  requireTimezone,
  requiredBoolean,
  requiredInteger,
  requiredNumber,
  requiredString,
  requiredStringArray,
  requiredTable,
  type TomlTable,
} from './validation.ts'
import { CONFIG_SCHEMA_VERSION } from './types.ts'

const CONFIG_FILES = {
  system: 'system.toml',
  identity: 'identity.toml',
  lifeState: 'life-state.toml',
  memory: 'memory.toml',
  policy: 'policy.toml',
} as const

type ConfigKind = keyof typeof CONFIG_FILES

interface ParsedFiles {
  system?: TomlTable
  identity?: TomlTable
  lifeState?: TomlTable
  memory?: TomlTable
  policy?: TomlTable
}

export function loadConfigFromDirectory(configDir: string): LoadedConfig {
  const issues: ConfigIssue[] = []
  const parsed: ParsedFiles = {}

  let directoryOk = false
  try {
    const info = statSync(configDir)
    directoryOk = info.isDirectory()
  } catch {
    directoryOk = false
  }
  // 目录不存在时没有可继续校验的文件，立即失败并保留路径信息。
  if (!directoryOk) {
    throw new ConfigError([
      {
        file: configDir,
        field: '$',
        message: 'configuration directory does not exist or is not a directory',
      },
    ])
  }

  // 逐文件读取，暂时保留成功解析的表；单个文件失败只记录 issue。
  for (const kind of Object.keys(CONFIG_FILES) as ConfigKind[]) {
    const file = join(configDir, CONFIG_FILES[kind])
    const result = readConfigFile(file)
    if (result.issue) {
      issues.push(result.issue)
    } else {
      parsed[kind] = result.table
    }
  }

  let system: SystemConfig | undefined
  if (parsed.system) {
    try {
      system = validateSystem(parsed.system, join(configDir, CONFIG_FILES.system))
    } catch (error) {
      issues.push(toIssue(error, join(configDir, CONFIG_FILES.system)))
    }
  }

  let identity: IdentityConfig | undefined
  if (parsed.identity) {
    try {
      // 生产环境必须使用 private identity，这条规则需要同时看 system 和 identity。
      identity = validateIdentity(
        parsed.identity,
        join(configDir, CONFIG_FILES.identity),
        system,
      )
    } catch (error) {
      issues.push(toIssue(error, join(configDir, CONFIG_FILES.identity)))
    }
  }

  let lifeState: LifeStateConfig | undefined
  if (parsed.lifeState) {
    try {
      lifeState = validateLifeState(
        parsed.lifeState,
        join(configDir, CONFIG_FILES.lifeState),
      )
    } catch (error) {
      issues.push(toIssue(error, join(configDir, CONFIG_FILES.lifeState)))
    }
  }

  let memory: MemoryConfig | undefined
  if (parsed.memory) {
    try {
      memory = validateMemory(parsed.memory, join(configDir, CONFIG_FILES.memory))
    } catch (error) {
      issues.push(toIssue(error, join(configDir, CONFIG_FILES.memory)))
    }
  }

  let policy: PolicyConfig | undefined
  if (parsed.policy) {
    try {
      policy = validatePolicy(parsed.policy, join(configDir, CONFIG_FILES.policy))
    } catch (error) {
      issues.push(toIssue(error, join(configDir, CONFIG_FILES.policy)))
    }
  }

  // 缺失文件和字段错误都会走这里；错误列表为空时才算加载成功。
  if (issues.length > 0 || !system || !identity || !lifeState || !memory || !policy) {
    throw new ConfigError(issues)
  }

  return { system, identity, lifeState, memory, policy }
}

function readConfigFile(file: string): { table?: TomlTable; issue?: ConfigIssue } {
  let text: string
  try {
    // 所有文件问题都转换成带文件名的 issue，不让原始异常泄漏到调用方。
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      issue: {
        file,
        field: '$',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  try {
    return { table: asTable(parse(text), '$') }
  } catch (error) {
    if (error instanceof ConfigFieldError) {
      return { issue: { file, field: error.field, message: error.message } }
    }
    return {
      issue: {
        file,
        field: '$',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function validateSystem(table: TomlTable, file: string): SystemConfig {
  knownKeys(
    table,
    [
      'schema_version',
      'environment',
      'time',
      'context',
      'model',
      'resources',
      'storage',
    ],
    '',
  )
  requireSchemaVersion(table, CONFIG_SCHEMA_VERSION)

  const environment = requiredString(table, 'environment', 'environment', 1, 32)
  if (environment !== 'development' && environment !== 'production') {
    fail('environment', 'expected "development" or "production"')
  }

  const time = requiredTable(table, 'time', 'time')
  knownKeys(
    time,
    ['timezone', 'quiet_hours_start', 'quiet_hours_end'],
    'time',
  )
  const timezone = requiredString(time, 'timezone', 'time.timezone', 1, 64)
  requireTimezone(timezone, 'time.timezone')
  const quietHoursStart = requiredString(
    time,
    'quiet_hours_start',
    'time.quiet_hours_start',
    5,
    5,
  )
  const quietHoursEnd = requiredString(
    time,
    'quiet_hours_end',
    'time.quiet_hours_end',
    5,
    5,
  )
  requireQuietTime(quietHoursStart, 'time.quiet_hours_start')
  requireQuietTime(quietHoursEnd, 'time.quiet_hours_end')
  // 当前模型只支持一个连续安静时段，起止相同视为配置错误。
  if (quietHoursStart === quietHoursEnd) {
    fail('time.quiet_hours_end', 'quiet hours must have a non-zero duration')
  }

  const context = requiredTable(table, 'context', 'context')
  knownKeys(
    context,
    [
      'max_prompt_chars',
      'max_state_chars',
      'max_memory_items',
      'max_memory_item_chars',
      'max_memory_chars',
      'max_history_messages',
      'max_history_chars',
      'max_message_chars',
    ],
    'context',
  )
  const maxPromptChars = requiredInteger(
    context,
    'max_prompt_chars',
    'context.max_prompt_chars',
    2_000,
    200_000,
  )
  const maxMessageChars = requiredInteger(
    context,
    'max_message_chars',
    'context.max_message_chars',
    1,
    4_000,
  )
  if (maxMessageChars > maxPromptChars) {
    fail(
      'context.max_message_chars',
      'must not exceed context.max_prompt_chars',
    )
  }

  const model = requiredTable(table, 'model', 'model')
  knownKeys(
    model,
    [
      'provider',
      'name',
      'base_url',
      'api_key_env',
      'timeout_ms',
      'max_retries',
      'max_output_tokens',
    ],
    'model',
  )
  const provider = requiredString(model, 'provider', 'model.provider', 1, 128)
  const name = requiredString(model, 'name', 'model.name', 1, 128)
  const rawBaseUrl = optionalString(model, 'base_url', 'model.base_url', 1, 512)
  const baseUrl = rawBaseUrl === null ? null : requireLoopbackBaseUrl(rawBaseUrl, 'model.base_url')
  const apiKeyEnv = optionalString(model, 'api_key_env', 'model.api_key_env', 1, 128)
  if (apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    fail('model.api_key_env', 'expected an environment variable name')
  }
  const timeoutMs = requiredInteger(
    model,
    'timeout_ms',
    'model.timeout_ms',
    1_000,
    600_000,
  )
  const maxRetries = requiredInteger(
    model,
    'max_retries',
    'model.max_retries',
    0,
    5,
  )
  const maxOutputTokens = optionalInteger(
    model,
    'max_output_tokens',
    'model.max_output_tokens',
    1,
    65_536,
  )
  if (provider === 'magpie') {
    if (baseUrl === null) {
      fail('model.base_url', 'required when provider is "magpie"')
    }
    if (maxOutputTokens === null) {
      fail('model.max_output_tokens', 'required when provider is "magpie"')
    }
  }

  const resources = requiredTable(table, 'resources', 'resources')
  knownKeys(
    resources,
    ['max_concurrent_model_calls', 'daily_model_call_limit'],
    'resources',
  )
  const maxConcurrentModelCalls = requiredInteger(
    resources,
    'max_concurrent_model_calls',
    'resources.max_concurrent_model_calls',
    1,
    8,
  )
  const dailyModelCallLimit = requiredInteger(
    resources,
    'daily_model_call_limit',
    'resources.daily_model_call_limit',
    1,
    1_000_000,
  )

  const storage = requiredTable(table, 'storage', 'storage')
  knownKeys(
    storage,
    [
      'database',
      'tombstones',
      'backup_dir',
      'snapshot_every_events',
      'snapshot_interval_hours',
      'backup_retention',
    ],
    'storage',
  )
  const database = requiredString(storage, 'database', 'storage.database', 1, 512)
  const tombstones = requiredString(
    storage,
    'tombstones',
    'storage.tombstones',
    1,
    512,
  )
  const backupDir = requiredString(
    storage,
    'backup_dir',
    'storage.backup_dir',
    1,
    512,
  )
  requireSafeRelativePath(database, 'storage.database')
  requireSafeRelativePath(tombstones, 'storage.tombstones')
  requireSafeRelativePath(backupDir, 'storage.backup_dir')
  // 主库和独立墓碑库必须分开；否则从旧主库备份恢复时会把墓碑一起回滚。
  if (normalizePathForComparison(database) === normalizePathForComparison(tombstones)) {
    fail('storage.tombstones', 'tombstone database must differ from the main database')
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    environment,
    time: {
      timezone,
      quietHoursStart,
      quietHoursEnd,
    },
    context: {
      maxPromptChars,
      maxStateChars: requiredInteger(
        context,
        'max_state_chars',
        'context.max_state_chars',
        240,
        4_000,
      ),
      maxMemoryItems: requiredInteger(
        context,
        'max_memory_items',
        'context.max_memory_items',
        1,
        10,
      ),
      maxMemoryItemChars: requiredInteger(
        context,
        'max_memory_item_chars',
        'context.max_memory_item_chars',
        20,
        2_000,
      ),
      maxMemoryChars: requiredInteger(
        context,
        'max_memory_chars',
        'context.max_memory_chars',
        200,
        50_000,
      ),
      maxHistoryMessages: requiredInteger(
        context,
        'max_history_messages',
        'context.max_history_messages',
        0,
        99,
      ),
      maxHistoryChars: requiredInteger(
        context,
        'max_history_chars',
        'context.max_history_chars',
        0,
        100_000,
      ),
      maxMessageChars,
    },
    model: {
      provider,
      name,
      baseUrl,
      apiKeyEnv,
      timeoutMs,
      maxRetries,
      maxOutputTokens,
    },
    resources: {
      maxConcurrentModelCalls,
      dailyModelCallLimit,
    },
    storage: {
      database,
      tombstones,
      backupDir,
      snapshotEveryEvents: requiredInteger(
        storage,
        'snapshot_every_events',
        'storage.snapshot_every_events',
        1,
        1_000_000,
      ),
      snapshotIntervalHours: requiredInteger(
        storage,
        'snapshot_interval_hours',
        'storage.snapshot_interval_hours',
        1,
        720,
      ),
      backupRetention: requiredInteger(
        storage,
        'backup_retention',
        'storage.backup_retention',
        1,
        30,
      ),
    },
  }
}

function optionalString(
  parent: TomlTable,
  key: string,
  field: string,
  minLength = 1,
  maxLength = 512,
): string | null {
  if (!(key in parent)) return null
  return requiredString(parent, key, field, minLength, maxLength)
}

function optionalInteger(
  parent: TomlTable,
  key: string,
  field: string,
  min: number,
  max: number,
): number | null {
  if (!(key in parent)) return null
  return requiredInteger(parent, key, field, min, max)
}

function requireLoopbackBaseUrl(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(field, 'expected a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(field, 'only http and https are allowed')
  }
  if (url.username !== '' || url.password !== '') {
    fail(field, 'credentials must not be embedded in the URL')
  }
  if (url.search !== '' || url.hash !== '') {
    fail(field, 'query strings and fragments are not allowed')
  }
  if (!isLoopbackHostname(url.hostname)) {
    fail(field, 'model base URL must use a loopback host')
  }
  if (url.pathname !== '/v1' && url.pathname !== '/v1/') {
    fail(field, 'model base URL must end with /v1')
  }
  return `${url.origin}/v1`
}

// Node 的 URL.hostname 对 IPv6 保留方括号，校验前必须先规范化。
function isLoopbackHostname(hostname: string): boolean {
  const normalized =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
  return ['127.0.0.1', '::1', 'localhost'].includes(normalized.toLowerCase())
}

function validateLifeState(table: TomlTable, file: string): LifeStateConfig {
  knownKeys(
    table,
    ['schema_version', 'initial', 'decay_per_hour', 'limits'],
    '',
  )
  requireSchemaVersion(table, CONFIG_SCHEMA_VERSION)

  const initial = requiredTable(table, 'initial', 'initial')
  knownKeys(
    initial,
    ['valence', 'arousal', 'energy', 'social_battery', 'closeness'],
    'initial',
  )
  const initialValence = requiredNumber(initial, 'valence', 'initial.valence', -1, 1)
  const initialArousal = requiredNumber(initial, 'arousal', 'initial.arousal', 0, 1)
  const initialEnergy = requiredNumber(initial, 'energy', 'initial.energy', 0, 1)
  const initialSocialBattery = requiredNumber(
    initial,
    'social_battery',
    'initial.social_battery',
    0,
    1,
  )
  const initialCloseness = requiredNumber(
    initial,
    'closeness',
    'initial.closeness',
    0,
    1,
  )

  const decay = requiredTable(table, 'decay_per_hour', 'decay_per_hour')
  knownKeys(
    decay,
    [
      'valence',
      'arousal',
      'energy_awake',
      'energy_asleep_recovery',
      'social_battery_awake',
      'social_battery_asleep_recovery',
    ],
    'decay_per_hour',
  )
  const decayValence = requiredNumber(
    decay,
    'valence',
    'decay_per_hour.valence',
    0,
    10,
  )
  const decayArousal = requiredNumber(
    decay,
    'arousal',
    'decay_per_hour.arousal',
    0,
    10,
  )
  const energyAwake = requiredNumber(
    decay,
    'energy_awake',
    'decay_per_hour.energy_awake',
    0,
    10,
  )
  const energyAsleepRecovery = requiredNumber(
    decay,
    'energy_asleep_recovery',
    'decay_per_hour.energy_asleep_recovery',
    0,
    10,
  )
  const socialBatteryAwake = requiredNumber(
    decay,
    'social_battery_awake',
    'decay_per_hour.social_battery_awake',
    0,
    10,
  )
  const socialBatteryAsleepRecovery = requiredNumber(
    decay,
    'social_battery_asleep_recovery',
    'decay_per_hour.social_battery_asleep_recovery',
    0,
    10,
  )

  const limits = requiredTable(table, 'limits', 'limits')
  knownKeys(
    limits,
    ['max_relationship_delta_per_event', 'max_commitments'],
    'limits',
  )
  const maxRelationshipDelta = requiredNumber(
    limits,
    'max_relationship_delta_per_event',
    'limits.max_relationship_delta_per_event',
    0.001,
    0.25,
  )
  const maxCommitments = requiredInteger(
    limits,
    'max_commitments',
    'limits.max_commitments',
    1,
    256,
  )

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    initial: {
      valence: initialValence,
      arousal: initialArousal,
      energy: initialEnergy,
      socialBattery: initialSocialBattery,
      closeness: initialCloseness,
    },
    decayPerHour: {
      valence: decayValence,
      arousal: decayArousal,
      energyAwake,
      energyAsleepRecovery,
      socialBatteryAwake,
      socialBatteryAsleepRecovery,
    },
    limits: {
      maxRelationshipDeltaPerEvent: maxRelationshipDelta,
      maxCommitments,
    },
  }
}

function validateMemory(table: TomlTable, file: string): MemoryConfig {
  knownKeys(table, ['schema_version', 'trash'], '')
  requireSchemaVersion(table, CONFIG_SCHEMA_VERSION)

  const trash = requiredTable(table, 'trash', 'trash')
  knownKeys(trash, ['retention_days'], 'trash')

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    trash: {
      retentionDays: requiredInteger(
        trash,
        'retention_days',
        'trash.retention_days',
        1,
        3650,
      ),
    },
  }
}

function normalizePathForComparison(value: string): string {
  // 只用于发现明显的重复路径；真正的目录边界检查在存储层用 dataDir 做。
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
  // Windows 路径大小写不敏感；Linux 迁移后不能把两个合法路径误判成同一个。
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function validateIdentity(
  table: TomlTable,
  file: string,
  system: SystemConfig | undefined,
): IdentityConfig {
  knownKeys(
    table,
    ['schema_version', 'mode', 'display_name', 'owner_name', 'persona_file'],
    '',
  )
  requireSchemaVersion(table, CONFIG_SCHEMA_VERSION)

  const mode = requiredString(table, 'mode', 'mode', 1, 32)
  if (mode !== 'placeholder' && mode !== 'private') {
    fail('mode', 'expected "placeholder" or "private"')
  }
  const displayName = requiredString(table, 'display_name', 'display_name', 1, 80)
  const ownerName = requiredString(table, 'owner_name', 'owner_name', 1, 80)

  let personaFile: string | undefined
  if ('persona_file' in table) {
    personaFile = requiredString(table, 'persona_file', 'persona_file', 1, 512)
    // 人格文件路径必须是数据目录内的相对路径，禁止绝对路径和 .. 穿越。
    requireSafeRelativePath(personaFile, 'persona_file')
  }

  // 占位身份不能偷偷加载真实人格；正式身份必须显式提供文件。
  if (mode === 'placeholder' && personaFile !== undefined) {
    fail('persona_file', 'placeholder identity must not reference a persona file')
  }
  if (mode === 'private' && personaFile === undefined) {
    fail('persona_file', 'private identity requires persona_file')
  }
  if (system?.environment === 'production' && mode === 'placeholder') {
    fail('mode', 'production must not use the placeholder identity')
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode,
    displayName,
    ownerName,
    ...(personaFile === undefined ? {} : { personaFile }),
  }
}

function validatePolicy(table: TomlTable, file: string): PolicyConfig {
  knownKeys(
    table,
    ['schema_version', 'tools', 'permissions', 'limits', 'emergency'],
    '',
  )
  requireSchemaVersion(table, CONFIG_SCHEMA_VERSION)

  const tools = requiredTable(table, 'tools', 'tools')
  knownKeys(tools, ['allow'], 'tools')
  const allowedTools = requiredStringArray(tools, 'allow', 'tools.allow')
  // 第一版工具白名单必须为空；后续接入工具时再逐个设计权限和审计。
  if (allowedTools.length > 0) {
    fail('tools.allow', 'the first version must not expose model tools')
  }

  const permissions = requiredTable(table, 'permissions', 'permissions')
  knownKeys(
    permissions,
    [
      'allow_shell',
      'allow_file_write',
      'allow_network',
      'allow_public_posting',
    ],
    'permissions',
  )
  const permissionFields = [
    ['allow_shell', 'allowShell'],
    ['allow_file_write', 'allowFileWrite'],
    ['allow_network', 'allowNetwork'],
    ['allow_public_posting', 'allowPublicPosting'],
  ] as const
  const parsedPermissions: Record<string, boolean> = {}
  for (const [tomlName] of permissionFields) {
    const enabled = requiredBoolean(
      permissions,
      tomlName,
      `permissions.${tomlName}`,
    )
    if (enabled) {
      // 权限提升不能靠配置“顺手打开”，必须等到对应里程碑单独验收。
      fail(`permissions.${tomlName}`, 'must remain false in the first version')
    }
    parsedPermissions[tomlName] = enabled
  }

  const limits = requiredTable(table, 'limits', 'limits')
  knownKeys(limits, ['max_reply_chars', 'max_steps_per_turn'], 'limits')
  const maxReplyChars = requiredInteger(
    limits,
    'max_reply_chars',
    'limits.max_reply_chars',
    1,
    10_000,
  )
  const maxStepsPerTurn = requiredInteger(
    limits,
    'max_steps_per_turn',
    'limits.max_steps_per_turn',
    1,
    10,
  )

  const emergency = requiredTable(table, 'emergency', 'emergency')
  knownKeys(emergency, ['stop_file'], 'emergency')
  const stopFile = requiredString(emergency, 'stop_file', 'emergency.stop_file', 1, 64)
  requireSafeFileName(stopFile, 'emergency.stop_file')

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    tools: {
      allow: allowedTools,
    },
    permissions: {
      allowShell: false,
      allowFileWrite: false,
      allowNetwork: false,
      allowPublicPosting: false,
    },
    limits: {
      maxReplyChars,
      maxStepsPerTurn,
    },
    emergency: {
      stopFile,
    },
  }
}

function toIssue(error: unknown, file: string): ConfigIssue {
  // 只有字段错误能给出精确路径；其他异常归到文件级 $ 字段。
  if (error instanceof ConfigFieldError) {
    return { file, field: error.field, message: error.message }
  }
  return {
    file,
    field: '$',
    message: error instanceof Error ? error.message : String(error),
  }
}
