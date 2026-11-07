/**
 * QQ 渠道设置服务。
 *
 * `channels.toml` 是手写基础配置，设置页只写 `channel-settings.json`
 * 运行时覆盖，二者最终都经过同一个 `validateChannels`。页面只看到
 * 凭据来源和掩码状态，token 与 secret 引用都不会出现在响应中。
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  CONFIG_SCHEMA_VERSION,
  RUNTIME_CHANNEL_SETTINGS_FILENAME,
  loadConfigFromDirectory,
  validateChannels,
  type ChannelsConfig,
  type LoadedConfig,
  type QqChannelConfig,
  type QqTargetConfig,
} from '../core/config/index.ts'
import {
  QqConnectionTestError,
  QqCredentialError,
  resolveQqAccessToken,
  testOneBotConnection,
  type LocalSecretReader,
  type QqGatewayState,
} from '../channels/index.ts'
import { LocalSecretStore } from '../model-providers/index.ts'

export type ChannelCredentialMode = 'keep' | 'none' | 'environment' | 'new'

export interface ChannelCredentialDraft {
  mode: ChannelCredentialMode
  environmentName?: string
  value?: string
}

export interface QqChannelSettingsDraft {
  enabled: boolean
  wsUrl: string
  allowRemote: boolean
  credential: ChannelCredentialDraft
  privateAllow: string[]
  groupAllow: string[]
  groupRequireMention: boolean
  autonomousTarget: string | null
  connectTimeoutMs: number
  actionTimeoutMs: number
  turnTimeoutMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
  pingIntervalMs: number
  dedupeRetentionHours: number
  coalesce: {
    quietMs: number
    maxWaitMs: number
    maxImages: number
    maxTotalImageBytes: number
  }
  images: {
    downloadTimeoutMs: number
  }
  outbound: {
    splitChars: number
    maxParts: number
    minIntervalMs: number
  }
  limits: {
    maxInboundTurnsPerMinute: number
    maxOutboundPartsPerMinute: number
  }
}

export interface ChannelSettingsDraft {
  qq: QqChannelSettingsDraft
}

export interface ChannelCredentialView {
  mode: 'none' | 'environment' | 'local-secret'
  environmentName: string | null
  label: string | null
  configured: boolean
}

export interface QqChannelSettingsView
  extends Omit<QqChannelSettingsDraft, 'credential' | 'autonomousTarget'> {
  configured: boolean
  autonomousTarget: string | null
  credential: ChannelCredentialView
}

export interface ChannelSettingsView {
  configFile: string
  restartRequiredOnSave: true
  readOnly: boolean
  qq: QqChannelSettingsView
}

export type QqRuntimeState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped'
  | 'error'

export interface QqChannelStatusView {
  state: QqRuntimeState
  label: string
  configured: boolean
  enabled: boolean
  selfId: string | null
}

export interface QqConnectionTestResult {
  ok: true
  selfId: string
  durationMs: number
}

export interface QqRuntimeSnapshot {
  enabled: boolean
  connection: QqGatewayState | null
}

export class ChannelSettingsError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChannelSettingsError'
    this.code = code
  }
}

export interface ChannelSettingsServiceOptions {
  configDir: string
  loaded: LoadedConfig
  readOnly?: boolean
  secretStore?: LocalSecretStore
  runtimeStatus?: () => QqRuntimeSnapshot
  testConnection?: typeof testOneBotConnection
}

export class ChannelSettingsService {
  private readonly configDir: string
  private readonly secretStore: LocalSecretStore
  private readonly readOnly: boolean
  private readonly runtimeStatus: () => QqRuntimeSnapshot
  private readonly testConnection: typeof testOneBotConnection
  private loaded: LoadedConfig

  constructor(options: ChannelSettingsServiceOptions) {
    this.configDir = options.configDir
    this.loaded = options.loaded
    this.readOnly = options.readOnly ?? false
    this.secretStore =
      options.secretStore ?? new LocalSecretStore(options.configDir)
    this.runtimeStatus =
      options.runtimeStatus ?? (() => ({ enabled: false, connection: null }))
    this.testConnection = options.testConnection ?? testOneBotConnection
  }

  view(): ChannelSettingsView {
    const qq = this.loaded.channels.qq
    return {
      configFile: RUNTIME_CHANNEL_SETTINGS_FILENAME,
      restartRequiredOnSave: true,
      readOnly: this.readOnly,
      qq: {
        configured: this.hasChannelConfig(),
        enabled: qq.enabled,
        wsUrl: qq.wsUrl,
        allowRemote: qq.allowRemote,
        credential: this.credentialView(qq),
        privateAllow: [...qq.privateAllow],
        groupAllow: [...qq.groupAllow],
        groupRequireMention: qq.groupRequireMention,
        autonomousTarget: formatTarget(qq.autonomousTarget),
        connectTimeoutMs: qq.connectTimeoutMs,
        actionTimeoutMs: qq.actionTimeoutMs,
        turnTimeoutMs: qq.turnTimeoutMs,
        reconnectMinMs: qq.reconnectMinMs,
        reconnectMaxMs: qq.reconnectMaxMs,
        pingIntervalMs: qq.pingIntervalMs,
        dedupeRetentionHours: qq.dedupeRetentionHours,
        coalesce: { ...qq.coalesce },
        images: { ...qq.images },
        outbound: { ...qq.outbound },
        limits: { ...qq.limits },
      },
    }
  }

  status(): QqChannelStatusView {
    const configured = this.hasChannelConfig()
    const runtime = this.runtimeStatus()
    const connection = runtime.connection
    const selfId = connection?.selfId ?? null
    if (!configured) {
      return {
        state: 'disabled',
        label: 'QQ 未配置',
        configured: false,
        enabled: false,
        selfId: null,
      }
    }
    if (!runtime.enabled) {
      return {
        state: 'disabled',
        label: 'QQ 未启用',
        configured: true,
        enabled: false,
        selfId: null,
      }
    }
    if (connection === null) {
      return {
        state: 'connecting',
        label: 'QQ 连接中',
        configured: true,
        enabled: true,
        selfId: null,
      }
    }
    if (connection.event === 'reconnecting') {
      return {
        state: 'reconnecting',
        label: 'QQ 重连中',
        configured: true,
        enabled: true,
        selfId,
      }
    }
    if (connection.event === 'closed') {
      const stopped = connection.detailCode === 'channel_closed'
      return {
        state: stopped ? 'stopped' : 'error',
        label: stopped ? 'QQ 已停止' : 'QQ 连接错误',
        configured: true,
        enabled: true,
        selfId,
      }
    }
    if (!connection.connected) {
      return {
        state: 'connecting',
        label: 'QQ 连接中',
        configured: true,
        enabled: true,
        selfId,
      }
    }
    if (selfId === null) {
      const loginFailed = connection.detailCode === 'login_info_failed'
      return {
        state: loginFailed ? 'error' : 'connecting',
        label: loginFailed ? 'QQ 登录信息读取失败' : 'QQ 登录确认中',
        configured: true,
        enabled: true,
        selfId: null,
      }
    }
    return {
      state: 'connected',
      label: `QQ 已连接 · ${selfId}`,
      configured: true,
      enabled: true,
      selfId,
    }
  }

  async test(input: unknown): Promise<QqConnectionTestResult> {
    const parsed = parseDraft(input)
    const table = draftToChannelTable(parsed, this.loaded.channels.qq, true)
    let qq: QqChannelConfig
    try {
      qq = validateChannels(table, RUNTIME_CHANNEL_SETTINGS_FILENAME).qq
    } catch (error) {
      throw invalidConfigError(error)
    }

    let token: string | null
    try {
      token = this.resolveDraftToken(parsed.qq.credential, qq)
    } catch (error) {
      if (error instanceof QqCredentialError) {
        throw new ChannelSettingsError(error.code, error.message)
      }
      throw error
    }

    try {
      return await this.testConnection({
        url: qq.wsUrl,
        token,
        connectTimeoutMs: qq.connectTimeoutMs,
        actionTimeoutMs: qq.actionTimeoutMs,
      })
    } catch (error) {
      if (error instanceof QqConnectionTestError) {
        throw new ChannelSettingsError(error.code, error.message)
      }
      throw new ChannelSettingsError(
        'qq_test_failed',
        'QQ 连接测试失败',
      )
    }
  }

  async save(input: unknown): Promise<ChannelSettingsView> {
    if (this.readOnly) {
      throw new ChannelSettingsError(
        'settings_read_only',
        '仓库示例配置是只读的；请使用独立运行时配置目录',
      )
    }
    const parsed = parseDraft(input)
    const previous = this.loaded.channels.qq
    const table = draftToChannelTable(parsed, previous, true)
    let normalized: ChannelsConfig
    try {
      normalized = validateChannels(table, RUNTIME_CHANNEL_SETTINGS_FILENAME)
    } catch (error) {
      throw invalidConfigError(error)
    }

    let createdSecret: string | null = null
    if (parsed.qq.credential.mode === 'new') {
      try {
        createdSecret = this.secretStore.put(
          parsed.qq.credential.value ?? '',
          'kanobot-qq',
        )
      } catch {
        throw new ChannelSettingsError(
          'qq_secret_save_failed',
          'QQ 本地密钥保存失败',
        )
      }
      normalized = {
        ...normalized,
        qq: {
          ...normalized.qq,
          accessTokenEnv: null,
          accessTokenSecret: createdSecret,
        },
      }
    }

    const overlayFile = join(
      this.configDir,
      RUNTIME_CHANNEL_SETTINGS_FILENAME,
    )
    const previousOverlay = existsSync(overlayFile)
      ? readFileSync(overlayFile)
      : null
    try {
      writeJsonAtomic(overlayFile, buildOverlay(normalized.qq))
      this.loaded = loadConfigFromDirectory(this.configDir)
    } catch (error) {
      if (createdSecret !== null) {
        this.removeSecretBestEffort(createdSecret)
      }
      restoreOverlay(overlayFile, previousOverlay)
      if (error instanceof ChannelSettingsError) throw error
      throw invalidConfigError(error)
    }

    const next = this.loaded.channels.qq
    if (
      previous.accessTokenSecret !== null &&
      parsed.qq.credential.mode !== 'keep' &&
      previous.accessTokenSecret !== next.accessTokenSecret
    ) {
      this.removeSecretBestEffort(previous.accessTokenSecret)
    }
    return this.view()
  }

  private resolveDraftToken(
    credential: ParsedCredential,
    qq: QqChannelConfig,
  ): string | null {
    if (credential.mode === 'new') {
      return credential.value
    }
    if (credential.mode === 'none') {
      return null
    }
    return resolveQqAccessToken(qq, this.secretStore)
  }

  private credentialView(qq: QqChannelConfig): ChannelCredentialView {
    if (qq.accessTokenEnv !== null) {
      return {
        mode: 'environment',
        environmentName: qq.accessTokenEnv,
        label: null,
        configured: true,
      }
    }
    if (qq.accessTokenSecret !== null) {
      return {
        mode: 'local-secret',
        environmentName: null,
        label: this.secretStore.describe(qq.accessTokenSecret),
        configured: this.secretStore.has(qq.accessTokenSecret),
      }
    }
    return {
      mode: 'none',
      environmentName: null,
      label: null,
      configured: false,
    }
  }

  private hasChannelConfig(): boolean {
    return (
      existsSync(join(this.configDir, 'channels.toml')) ||
      existsSync(join(this.configDir, RUNTIME_CHANNEL_SETTINGS_FILENAME))
    )
  }

  private removeSecretBestEffort(ref: string): void {
    try {
      this.secretStore.delete(ref)
    } catch {
      // 清理旧条目不改变已经成功的配置；残留密文不会进入配置或页面。
    }
  }
}

interface ParsedCredential {
  mode: ChannelCredentialMode
  environmentName: string | null
  value: string | null
}

interface ParsedQqDraft extends Omit<QqChannelSettingsDraft, 'credential'> {
  credential: ParsedCredential
}

interface ParsedDraft {
  qq: ParsedQqDraft
}

function parseDraft(value: unknown): ParsedDraft {
  const root = asObject(value, 'QQ 设置请求')
  assertOnlyKeys(root, ['qq'], 'QQ 设置请求')
  const qq = asObject(root.qq, 'qq')
  assertOnlyKeys(
    qq,
    [
      'enabled',
      'wsUrl',
      'allowRemote',
      'credential',
      'privateAllow',
      'groupAllow',
      'groupRequireMention',
      'autonomousTarget',
      'connectTimeoutMs',
      'actionTimeoutMs',
      'turnTimeoutMs',
      'reconnectMinMs',
      'reconnectMaxMs',
      'pingIntervalMs',
      'dedupeRetentionHours',
      'coalesce',
      'images',
      'outbound',
      'limits',
    ],
    'qq',
  )
  const coalesce = asObject(qq.coalesce, 'qq.coalesce')
  assertOnlyKeys(
    coalesce,
    ['quietMs', 'maxWaitMs', 'maxImages', 'maxTotalImageBytes'],
    'qq.coalesce',
  )
  const images = asObject(qq.images, 'qq.images')
  assertOnlyKeys(
    images,
    ['downloadTimeoutMs'],
    'qq.images',
  )
  const outbound = asObject(qq.outbound, 'qq.outbound')
  assertOnlyKeys(
    outbound,
    ['splitChars', 'maxParts', 'minIntervalMs'],
    'qq.outbound',
  )
  const limits = asObject(qq.limits, 'qq.limits')
  assertOnlyKeys(
    limits,
    ['maxInboundTurnsPerMinute', 'maxOutboundPartsPerMinute'],
    'qq.limits',
  )
  return {
    qq: {
      enabled: qq.enabled as boolean,
      wsUrl: qq.wsUrl as string,
      allowRemote: qq.allowRemote as boolean,
      credential: parseCredential(qq.credential),
      privateAllow: qq.privateAllow as string[],
      groupAllow: qq.groupAllow as string[],
      groupRequireMention: qq.groupRequireMention as boolean,
      autonomousTarget: qq.autonomousTarget as string | null,
      connectTimeoutMs: qq.connectTimeoutMs as number,
      actionTimeoutMs: qq.actionTimeoutMs as number,
      turnTimeoutMs: qq.turnTimeoutMs as number,
      reconnectMinMs: qq.reconnectMinMs as number,
      reconnectMaxMs: qq.reconnectMaxMs as number,
      pingIntervalMs: qq.pingIntervalMs as number,
      dedupeRetentionHours: qq.dedupeRetentionHours as number,
      coalesce: coalesce as QqChannelSettingsDraft['coalesce'],
      images: images as QqChannelSettingsDraft['images'],
      outbound: outbound as QqChannelSettingsDraft['outbound'],
      limits: limits as QqChannelSettingsDraft['limits'],
    },
  }
}

function parseCredential(value: unknown): ParsedCredential {
  const input = asObject(value, 'qq.credential')
  const mode = input.mode
  if (
    mode !== 'keep' &&
    mode !== 'none' &&
    mode !== 'environment' &&
    mode !== 'new'
  ) {
    throw new ChannelSettingsError(
      'invalid_credential_mode',
      'QQ 凭据来源必须是 keep、none、environment 或 new',
    )
  }
  if (mode === 'environment') {
    assertOnlyKeys(input, ['mode', 'environmentName'], 'qq.credential')
    const environmentName = input.environmentName
    if (
      typeof environmentName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)
    ) {
      throw new ChannelSettingsError(
        'invalid_environment_name',
        'QQ 环境变量名不合法',
      )
    }
    return { mode, environmentName, value: null }
  }
  if (mode === 'new') {
    assertOnlyKeys(input, ['mode', 'value'], 'qq.credential')
    const secret = input.value
    if (
      typeof secret !== 'string' ||
      secret.trim() === '' ||
      secret.length > 8_192 ||
      /[\u0000-\u001f\u007f]/.test(secret)
    ) {
      throw new ChannelSettingsError(
        'invalid_secret',
        'QQ 本地密钥不能为空、不能包含控制字符，且不能超过 8192 字',
      )
    }
    return { mode, environmentName: null, value: secret.trim() }
  }
  assertOnlyKeys(input, ['mode'], 'qq.credential')
  return { mode, environmentName: null, value: null }
}

function draftToChannelTable(
  parsed: ParsedDraft,
  current: QqChannelConfig,
  validateTokenSource: boolean,
): Record<string, unknown> {
  const draft = parsed.qq
  const qq: Record<string, unknown> = {
    enabled: draft.enabled,
    ws_url: draft.wsUrl,
    allow_remote: draft.allowRemote,
    connect_timeout_ms: draft.connectTimeoutMs,
    action_timeout_ms: draft.actionTimeoutMs,
    turn_timeout_ms: draft.turnTimeoutMs,
    reconnect_min_ms: draft.reconnectMinMs,
    reconnect_max_ms: draft.reconnectMaxMs,
    ping_interval_ms: draft.pingIntervalMs,
    dedupe_retention_hours: draft.dedupeRetentionHours,
    private_allow: draft.privateAllow,
    group_allow: draft.groupAllow,
    group_require_mention: draft.groupRequireMention,
    coalesce: {
      quiet_ms: draft.coalesce.quietMs,
      max_wait_ms: draft.coalesce.maxWaitMs,
      max_images: draft.coalesce.maxImages,
      max_total_image_bytes: draft.coalesce.maxTotalImageBytes,
    },
    images: {
      download_timeout_ms: draft.images.downloadTimeoutMs,
    },
    outbound: {
      split_chars: draft.outbound.splitChars,
      max_parts: draft.outbound.maxParts,
      min_interval_ms: draft.outbound.minIntervalMs,
    },
    limits: {
      max_inbound_turns_per_minute:
        draft.limits.maxInboundTurnsPerMinute,
      max_outbound_parts_per_minute:
        draft.limits.maxOutboundPartsPerMinute,
    },
  }
  if (draft.autonomousTarget !== null && draft.autonomousTarget !== '') {
    qq.autonomous_target = draft.autonomousTarget
  }
  if (validateTokenSource) {
    const credential = draft.credential
    if (credential.mode === 'environment') {
      qq.access_token_env = credential.environmentName
    } else if (credential.mode === 'new') {
      // 只用于复用同一套 schema 校验；真实引用在保存成功后替换。
      qq.access_token_secret = `secret_${'a'.repeat(32)}`
    } else if (credential.mode === 'keep') {
      if (current.accessTokenEnv !== null) {
        qq.access_token_env = current.accessTokenEnv
      }
      if (current.accessTokenSecret !== null) {
        qq.access_token_secret = current.accessTokenSecret
      }
    }
  }
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    qq,
  }
}

function buildOverlay(qq: QqChannelConfig): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    enabled: qq.enabled,
    ws_url: qq.wsUrl,
    allow_remote: qq.allowRemote,
    connect_timeout_ms: qq.connectTimeoutMs,
    action_timeout_ms: qq.actionTimeoutMs,
    turn_timeout_ms: qq.turnTimeoutMs,
    reconnect_min_ms: qq.reconnectMinMs,
    reconnect_max_ms: qq.reconnectMaxMs,
    ping_interval_ms: qq.pingIntervalMs,
    dedupe_retention_hours: qq.dedupeRetentionHours,
    private_allow: qq.privateAllow,
    group_allow: qq.groupAllow,
    group_require_mention: qq.groupRequireMention,
    coalesce: {
      quiet_ms: qq.coalesce.quietMs,
      max_wait_ms: qq.coalesce.maxWaitMs,
      max_images: qq.coalesce.maxImages,
      max_total_image_bytes: qq.coalesce.maxTotalImageBytes,
    },
    images: {
      download_timeout_ms: qq.images.downloadTimeoutMs,
    },
    outbound: {
      split_chars: qq.outbound.splitChars,
      max_parts: qq.outbound.maxParts,
      min_interval_ms: qq.outbound.minIntervalMs,
    },
    limits: {
      max_inbound_turns_per_minute: qq.limits.maxInboundTurnsPerMinute,
      max_outbound_parts_per_minute: qq.limits.maxOutboundPartsPerMinute,
    },
  }
  if (qq.accessTokenEnv !== null) {
    serialized.access_token_env = qq.accessTokenEnv
  }
  if (qq.accessTokenSecret !== null) {
    serialized.access_token_secret = qq.accessTokenSecret
  }
  if (qq.autonomousTarget !== null) {
    serialized.autonomous_target = formatTarget(qq.autonomousTarget)
  }
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    qq: serialized,
  }
}

function formatTarget(target: QqTargetConfig | null): string | null {
  return target === null ? null : `${target.kind}:${target.id}`
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Windows 上 chmod 只影响只读位；内容仍不包含 token。
  }
  replaceFile(temporary, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // 与 secret store 相同：权限是缓解措施，不是唯一保护。
  }
}

function restoreOverlay(path: string, previous: Buffer | null): void {
  try {
    if (previous === null) {
      rmSync(path, { force: true })
      return
    }
    const temporary = `${path}.${process.pid}.restore.tmp`
    writeFileSync(temporary, previous, { mode: 0o600, flag: 'w' })
    replaceFile(temporary, path)
  } catch {
    // 原始错误已经决定保存失败；恢复失败时下一次启动仍会 fail-closed。
  }
}

function replaceFile(source: string, target: string): void {
  try {
    renameSync(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      throw error
    }
    rmSync(target, { force: true })
    renameSync(source, target)
  }
}

function invalidConfigError(error: unknown): ChannelSettingsError {
  if (error instanceof ChannelSettingsError) return error
  const message =
    error instanceof Error && error.message !== ''
      ? error.message
      : 'QQ 渠道配置不合法'
  return new ChannelSettingsError('invalid_channel_settings', message)
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChannelSettingsError(
      'invalid_channel_settings',
      `${field} 必须是对象`,
    )
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ChannelSettingsError(
        'invalid_channel_settings',
        `${field} 包含不支持的字段 ${key}`,
      )
    }
  }
}

export type { LocalSecretReader }
