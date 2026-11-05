/**
 * system、identity、policy 的严格配置加载器。
 *
 * 设计原则：
 * - 未知字段、错误类型、越界值和非法路径都拒绝，不做静默兜底；
 * - 先收集所有文件和字段的问题，再统一抛出，避免每次只暴露一个错误；
 * - identity 的校验依赖 system.environment，因此跨文件规则在这里收口。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

import { ConfigError, ConfigFieldError } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import type {
  IdentityConfig,
  LoadedConfig,
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
  requiredString,
  requiredStringArray,
  requiredTable,
  type TomlTable,
} from './validation.ts'
import { CONFIG_SCHEMA_VERSION } from './types.ts'

const CONFIG_FILES = {
  system: 'system.toml',
  identity: 'identity.toml',
  policy: 'policy.toml',
} as const

type ConfigKind = keyof typeof CONFIG_FILES

interface ParsedFiles {
  system?: TomlTable
  identity?: TomlTable
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

  let policy: PolicyConfig | undefined
  if (parsed.policy) {
    try {
      policy = validatePolicy(parsed.policy, join(configDir, CONFIG_FILES.policy))
    } catch (error) {
      issues.push(toIssue(error, join(configDir, CONFIG_FILES.policy)))
    }
  }

  // 缺失文件和字段错误都会走这里；错误列表为空时才算加载成功。
  if (issues.length > 0 || !system || !identity || !policy) {
    throw new ConfigError(issues)
  }

  return { system, identity, policy }
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
  knownKeys(table, ['schema_version', 'environment', 'time', 'model', 'resources'], '')
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

  const model = requiredTable(table, 'model', 'model')
  knownKeys(model, ['provider', 'name', 'timeout_ms', 'max_retries'], 'model')
  const provider = requiredString(model, 'provider', 'model.provider', 1, 128)
  const name = requiredString(model, 'name', 'model.name', 1, 128)
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

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    environment,
    time: {
      timezone,
      quietHoursStart,
      quietHoursEnd,
    },
    model: {
      provider,
      name,
      timeoutMs,
      maxRetries,
    },
    resources: {
      maxConcurrentModelCalls,
      dailyModelCallLimit,
    },
  }
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
