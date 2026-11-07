/**
 * 所有者模型设置服务。
 *
 * 设置页只管理运行时覆盖文件，不改仓库示例 TOML，也不热更新正在使用的
 * provider。保存前会执行连接与能力检查；新密钥可一次性测试，测试值不落盘；
 * 正式保存时密钥进入本地加密 store，页面只看到掩码后的来源状态。
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  CONFIG_SCHEMA_VERSION,
  RUNTIME_MODEL_SETTINGS_FILENAME,
  loadConfigFromDirectory,
  validateModelBaseUrl,
  type ChatProvider,
  type LoadedConfig,
  type SystemConfig,
  type VisionConfig,
  type VisionProvider,
} from '../core/config/index.ts'
import type { ChatModel } from '../core/chat/index.ts'
import type { VisionModel } from '../core/vision/index.ts'
import {
  createChatModelFromConfig,
  createVisionModelFromConfig,
  LocalSecretStore,
  type DshLlmBridge,
} from '../model-providers/index.ts'

export type CredentialMode =
  | 'keep'
  | 'none'
  | 'environment'
  | 'new'

export interface CredentialDraft {
  mode: CredentialMode
  environmentName?: string
  value?: string
}

export interface ChatModelDraft {
  provider: ChatProvider
  route: string | null
  name: string
  baseUrl: string | null
  timeoutMs: number
  maxRetries: number
  maxOutputTokens: number | null
  reasoningEffort: string | null
  allowPrivateNetwork: boolean
  credential: CredentialDraft
}

export interface VisionModelDraft {
  enabled: boolean
  provider: VisionProvider | null
  name: string | null
  baseUrl: string | null
  timeoutMs: number
  maxRetries: number
  maxOutputTokens: number | null
  allowPrivateNetwork: boolean
  maxImageBytes: number
  maxDescriptionChars: number
  credential: CredentialDraft
}

export interface ModelSettingsDraft {
  chat: ChatModelDraft
  vision: VisionModelDraft
}

export interface CredentialView {
  mode: 'none' | 'environment' | 'local-secret'
  environmentName: string | null
  label: string | null
  configured: boolean
}

export interface ChatModelSettingsView extends Omit<ChatModelDraft, 'credential'> {
  credential: CredentialView
}

export interface VisionModelSettingsView
  extends Omit<VisionModelDraft, 'credential' | 'provider'> {
  provider: VisionProvider | null
  credential: CredentialView
}

export interface ModelSettingsView {
  configFile: string
  restartRequiredOnSave: true
  readOnly: boolean
  /** 宿主能力决定页面能提供哪些 provider；保存端仍会再次 fail-closed。 */
  hostCapabilities: {
    dshChat: {
      available: boolean
      reason: string | null
    }
  }
  chat: ChatModelSettingsView
  vision: VisionModelSettingsView
}

export interface ProviderTestResult {
  ok: true
  provider: string
  model: string
}

export interface VisionProviderTestResult extends ProviderTestResult {
  enabled: boolean
}

export interface ModelSettingsTestResult {
  chat: ProviderTestResult
  vision: VisionProviderTestResult
}

export class ModelSettingsError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ModelSettingsError'
    this.code = code
  }
}

export interface ModelSettingsServiceOptions {
  configDir: string
  loaded: LoadedConfig
  llm?: DshLlmBridge
  secretStore?: LocalSecretStore
  readOnly?: boolean
}

interface ResolvedDraft {
  draft: ParsedSettingsDraft
  chat: SystemConfig['model']
  vision: VisionConfig
  chatApiKeyOverride: string | undefined
  visionApiKeyOverride: string | undefined
}

interface ParsedChatDraft extends Omit<ChatModelDraft, 'credential'> {
  credential: ParsedCredential
}

interface ParsedVisionDraft extends Omit<VisionModelDraft, 'credential'> {
  credential: ParsedCredential
}

interface ParsedSettingsDraft {
  chat: ParsedChatDraft
  vision: ParsedVisionDraft
}

export class ModelSettingsService {
  private readonly configDir: string
  private readonly secretStore: LocalSecretStore
  private readonly llm: DshLlmBridge | undefined
  private readonly readOnly: boolean
  private loaded: LoadedConfig

  constructor(options: ModelSettingsServiceOptions) {
    this.configDir = options.configDir
    this.loaded = options.loaded
    this.llm = options.llm
    this.readOnly = options.readOnly ?? false
    this.secretStore =
      options.secretStore ?? new LocalSecretStore(options.configDir)
  }

  view(): ModelSettingsView {
    const model = this.loaded.system.model
    const vision = this.loaded.system.vision
    return {
      configFile: RUNTIME_MODEL_SETTINGS_FILENAME,
      restartRequiredOnSave: true,
      readOnly: this.readOnly,
      hostCapabilities: {
        dshChat: {
          available: this.llm !== undefined,
          reason:
            this.llm === undefined
              ? '当前宿主没有提供 ctx.llm；DSH 路由只在具备该服务的 DSH 插件中使用。'
              : null,
        },
      },
      chat: {
        provider: model.provider,
        route: model.route,
        name: model.name,
        baseUrl: model.baseUrl,
        timeoutMs: model.timeoutMs,
        maxRetries: model.maxRetries,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEffort: model.reasoningEffort,
        allowPrivateNetwork: model.allowPrivateNetwork,
        credential: credentialView(
          model.apiKeyEnv,
          model.apiKeySecret,
          this.secretStore,
        ),
      },
      vision: {
        enabled: vision.enabled,
        provider: vision.provider,
        name: vision.name,
        baseUrl: vision.baseUrl,
        timeoutMs: vision.timeoutMs,
        maxRetries: vision.maxRetries,
        maxOutputTokens: vision.maxOutputTokens,
        allowPrivateNetwork: vision.allowPrivateNetwork,
        maxImageBytes: vision.maxImageBytes,
        maxDescriptionChars: vision.maxDescriptionChars,
        credential: credentialView(
          vision.apiKeyEnv,
          vision.apiKeySecret,
          this.secretStore,
        ),
      },
    }
  }

  /**
   * 连接测试不接受已保存的 secret 引用作为输入；`keep` 只从服务端当前
   * 配置解析。页面没有读取 secret 值的接口。
   */
  async test(input: unknown): Promise<ModelSettingsTestResult> {
    const resolved = this.resolveDraft(input)
    const chat = await this.createCheckedChat(resolved)
    const vision = resolved.draft.vision.enabled
      ? await this.createCheckedVision(resolved)
      : null
    return {
      chat: {
        ok: true,
        provider: chat.provider,
        model: chat.id,
      },
      vision: {
        ok: true,
        enabled: vision !== null,
        provider: vision?.provider ?? '',
        model: vision?.id ?? '',
      },
    }
  }

  async save(input: unknown): Promise<ModelSettingsView> {
    if (this.readOnly) {
      throw new ModelSettingsError(
        'settings_read_only',
        '仓库示例配置是只读的；请使用独立运行时配置目录',
      )
    }
    const resolved = this.resolveDraft(input)
    // 保存前先验证实际连接和精确模型能力，避免一次保存把下次启动配置写坏。
    await this.createCheckedChat(resolved)
    if (resolved.draft.vision.enabled) {
      await this.createCheckedVision(resolved)
    }

    const chatSecret = this.commitCredential(
      resolved.draft.chat.credential,
      resolved.chat.apiKeyEnv,
      resolved.chat.apiKeySecret,
      'chat',
    )
    const visionSecret = resolved.draft.vision.enabled
      ? this.commitCredential(
          resolved.draft.vision.credential,
          resolved.vision.apiKeyEnv,
          resolved.vision.apiKeySecret,
          'vision',
        )
      : resolved.draft.vision.credential.mode === 'keep'
        ? {
            env: resolved.vision.apiKeyEnv,
            secret: resolved.vision.apiKeySecret,
          }
        : { env: null, secret: null }

    const overlay = buildOverlay(
      {
        ...resolved.chat,
        apiKeyEnv: chatSecret.env,
        apiKeySecret: chatSecret.secret,
      },
      {
        ...resolved.vision,
        enabled: resolved.draft.vision.enabled,
        apiKeyEnv: visionSecret.env,
        apiKeySecret: visionSecret.secret,
      },
    )
    this.writeOverlay(overlay)
    this.loaded = loadConfigFromDirectory(this.configDir)
    return this.view()
  }

  private resolveDraft(input: unknown): ResolvedDraft {
    const draft = parseDraft(input)
    const currentModel = this.loaded.system.model
    const currentVision = this.loaded.system.vision
    validateCredentialReuse(
      draft.chat.credential,
      currentModel.provider,
      currentModel.route,
      currentModel.baseUrl,
      currentModel.apiKeyEnv,
      currentModel.apiKeySecret,
      draft.chat.provider,
      draft.chat.route,
      draft.chat.baseUrl,
      'chat',
    )
    validateCredentialReuse(
      draft.vision.credential,
      currentVision.provider ?? 'magpie',
      currentVision.route,
      currentVision.baseUrl,
      currentVision.apiKeyEnv,
      currentVision.apiKeySecret,
      draft.vision.provider ?? 'magpie',
      null,
      draft.vision.baseUrl,
      'vision',
      !draft.vision.enabled,
    )

    validateProviderFields(draft.chat, draft.vision)
    const chatBaseUrl = normalizeDraftBaseUrl(
      draft.chat.baseUrl,
      'chat.baseUrl',
      draft.chat.provider,
      draft.chat.allowPrivateNetwork,
    )
    const visionBaseUrl = normalizeDraftBaseUrl(
      draft.vision.baseUrl,
      'vision.baseUrl',
      draft.vision.provider ?? 'magpie',
      draft.vision.allowPrivateNetwork,
    )

    const chatCredential = resolveDraftCredential(
      draft.chat.credential,
      currentModel.apiKeyEnv,
      currentModel.apiKeySecret,
      draft.chat.provider,
    )
    const visionCredential = resolveDraftCredential(
      draft.vision.credential,
      currentVision.apiKeyEnv,
      currentVision.apiKeySecret,
      draft.vision.provider ?? 'magpie',
    )
    const chat: SystemConfig['model'] = {
      provider: draft.chat.provider,
      route: draft.chat.provider === 'dsh' ? draft.chat.route : null,
      name: draft.chat.name,
      baseUrl: chatBaseUrl,
      apiKeyEnv: chatCredential.env,
      apiKeySecret: chatCredential.secret,
      allowPrivateNetwork: draft.chat.allowPrivateNetwork,
      timeoutMs: draft.chat.timeoutMs,
      maxRetries: draft.chat.maxRetries,
      maxOutputTokens: draft.chat.maxOutputTokens,
      reasoningEffort: draft.chat.reasoningEffort,
    }
    const vision: VisionConfig = {
      enabled: draft.vision.enabled,
      provider: draft.vision.provider,
      route: null,
      name: draft.vision.name,
      baseUrl: visionBaseUrl,
      apiKeyEnv: visionCredential.env,
      apiKeySecret: visionCredential.secret,
      allowPrivateNetwork: draft.vision.allowPrivateNetwork,
      timeoutMs: draft.vision.timeoutMs,
      maxRetries: draft.vision.maxRetries,
      maxOutputTokens: draft.vision.maxOutputTokens,
      maxImageBytes: draft.vision.maxImageBytes,
      maxDescriptionChars: draft.vision.maxDescriptionChars,
    }
    return {
      draft,
      chat,
      vision,
      chatApiKeyOverride: chatCredential.newValue ?? undefined,
      visionApiKeyOverride: visionCredential.newValue ?? undefined,
    }
  }

  private async createCheckedChat(resolved: ResolvedDraft): Promise<ChatModel> {
    try {
      return await createChatModelFromConfig(resolved.chat, {
        configDir: this.configDir,
        llm: this.llm,
        secretStore: this.secretStore,
        apiKeyOverride: resolved.chatApiKeyOverride,
      })
    } catch (error) {
      throw new ModelSettingsError(
        'chat_model_test_failed',
        safeError(error, '聊天模型连接或能力检查失败'),
      )
    }
  }

  private async createCheckedVision(
    resolved: ResolvedDraft,
  ): Promise<VisionModel> {
    try {
      const model = await createVisionModelFromConfig(resolved.vision, {
        configDir: this.configDir,
        secretStore: this.secretStore,
        apiKeyOverride: resolved.visionApiKeyOverride,
      })
      if (model === null) {
        throw new Error('vision model was enabled but no provider was created')
      }
      return model
    } catch (error) {
      throw new ModelSettingsError(
        'vision_model_test_failed',
        safeError(error, '视觉模型连接或能力检查失败'),
      )
    }
  }

  private commitCredential(
    credential: ParsedCredential,
    existingEnv: string | null,
    existingSecret: string | null,
    label: string,
  ): { env: string | null; secret: string | null } {
    switch (credential.mode) {
      case 'none':
        return { env: null, secret: null }
      case 'environment':
        return {
          env: requireEnvironmentName(credential.environmentName),
          secret: null,
        }
      case 'new':
        return {
          env: null,
          secret: this.secretStore.put(
            requireNewSecret(credential.newValue),
            `kanobot-${label}`,
          ),
        }
      case 'keep':
        return { env: existingEnv, secret: existingSecret }
    }
  }

  private writeOverlay(overlay: Record<string, unknown>): void {
    const target = join(this.configDir, RUNTIME_MODEL_SETTINGS_FILENAME)
    const previous = existsSync(target)
      ? readFileSync(target, 'utf8')
      : null
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(overlay, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    try {
      replaceFile(temp, target)
      loadConfigFromDirectory(this.configDir)
    } catch (error) {
      if (previous === null) {
        rmSync(target, { force: true })
      } else {
        const restore = `${target}.${process.pid}.restore`
        writeFileSync(restore, previous, { encoding: 'utf8', mode: 0o600 })
        replaceFile(restore, target)
      }
      throw new ModelSettingsError(
        'invalid_runtime_settings',
        error instanceof Error &&
        error.name === 'ConfigError'
          ? error.message
          : safeError(error, '运行时模型设置无法写入'),
      )
    } finally {
      rmSync(temp, { force: true })
    }
  }
}

function parseDraft(value: unknown): ParsedSettingsDraft {
  const root = asObject(value, '设置请求')
  assertOnlyKeys(root, ['chat', 'vision'], '设置请求')
  return {
    chat: parseChatDraft(root.chat),
    vision: parseVisionDraft(root.vision),
  }
}

function parseChatDraft(value: unknown): ParsedChatDraft {
  const input = asObject(value, 'chat')
  assertOnlyKeys(
    input,
    [
      'provider',
      'route',
      'name',
      'baseUrl',
      'timeoutMs',
      'maxRetries',
      'maxOutputTokens',
      'reasoningEffort',
      'allowPrivateNetwork',
      'credential',
    ],
    'chat',
  )
  const provider = parseChatProvider(input.provider)
  return {
    provider,
    route: nullableString(input.route, 'chat.route', 128),
    name: requiredDraftString(input.name, 'chat.name', 128),
    baseUrl: nullableString(input.baseUrl, 'chat.baseUrl', 512),
    timeoutMs: integerIn(input.timeoutMs, 'chat.timeoutMs', 1_000, 600_000),
    maxRetries: integerIn(input.maxRetries, 'chat.maxRetries', 0, 5),
    maxOutputTokens: nullableIntegerIn(
      input.maxOutputTokens,
      'chat.maxOutputTokens',
      1,
      65_536,
    ),
    reasoningEffort: nullableReasoningEffort(input.reasoningEffort),
    allowPrivateNetwork: booleanValue(
      input.allowPrivateNetwork,
      'chat.allowPrivateNetwork',
    ),
    credential: parseCredential(input.credential, 'chat.credential'),
  }
}

function parseVisionDraft(value: unknown): ParsedVisionDraft {
  const input = asObject(value, 'vision')
  assertOnlyKeys(
    input,
    [
      'enabled',
      'provider',
      'name',
      'baseUrl',
      'timeoutMs',
      'maxRetries',
      'maxOutputTokens',
      'allowPrivateNetwork',
      'maxImageBytes',
      'maxDescriptionChars',
      'credential',
    ],
    'vision',
  )
  return {
    enabled: booleanValue(input.enabled, 'vision.enabled'),
    provider: nullableVisionProvider(input.provider),
    name: nullableString(input.name, 'vision.name', 128),
    baseUrl: nullableString(input.baseUrl, 'vision.baseUrl', 512),
    timeoutMs: integerIn(input.timeoutMs, 'vision.timeoutMs', 1_000, 600_000),
    maxRetries: integerIn(input.maxRetries, 'vision.maxRetries', 0, 5),
    maxOutputTokens: nullableIntegerIn(
      input.maxOutputTokens,
      'vision.maxOutputTokens',
      1,
      65_536,
    ),
    allowPrivateNetwork: booleanValue(
      input.allowPrivateNetwork,
      'vision.allowPrivateNetwork',
    ),
    maxImageBytes: integerIn(
      input.maxImageBytes,
      'vision.maxImageBytes',
      1,
      5 * 1024 * 1024,
    ),
    maxDescriptionChars: integerIn(
      input.maxDescriptionChars,
      'vision.maxDescriptionChars',
      200,
      4_000,
    ),
    credential: parseCredential(input.credential, 'vision.credential'),
  }
}

function validateProviderFields(
  chat: ParsedChatDraft,
  vision: ParsedVisionDraft,
): void {
  if (chat.provider === 'dsh') {
    if (chat.route === null) {
      throw new ModelSettingsError(
        'invalid_settings',
        'DSH provider 必须填写精确 route',
      )
    }
    if (chat.baseUrl !== null) {
      throw new ModelSettingsError(
        'invalid_settings',
        'DSH provider 不能填写 baseUrl；端点由宿主管理',
      )
    }
    if (chat.maxOutputTokens === null) {
      throw new ModelSettingsError(
        'invalid_settings',
        'DSH provider 必须填写输出上限',
      )
    }
    if (chat.credential.mode === 'environment' || chat.credential.mode === 'new') {
      throw new ModelSettingsError(
        'invalid_settings',
        'DSH provider 的凭据由宿主管理，不能在设置页填写 API key',
      )
    }
  } else if (chat.route !== null) {
    throw new ModelSettingsError(
      'invalid_settings',
      '只有 DSH provider 接受 route',
    )
  }
  if (
    chat.provider === 'magpie' ||
    chat.provider === 'openai-compatible'
  ) {
    if (chat.baseUrl === null || chat.maxOutputTokens === null) {
      throw new ModelSettingsError(
        'invalid_settings',
        '真实聊天 provider 必须填写 baseUrl 和输出上限',
      )
    }
  }
  if (chat.provider === 'mock') {
    if (
      chat.baseUrl !== null ||
      chat.credential.mode === 'environment' ||
      chat.credential.mode === 'new'
    ) {
      throw new ModelSettingsError(
        'invalid_settings',
        'mock provider 不接受端点和凭据',
      )
    }
  }

  if (vision.enabled) {
    if (
      vision.provider === null ||
      vision.name === null ||
      vision.baseUrl === null ||
      vision.maxOutputTokens === null
    ) {
      throw new ModelSettingsError(
        'invalid_settings',
        '启用视觉时必须填写 provider、精确模型、baseUrl 和输出上限',
      )
    }
  }
}

interface ParsedCredential {
  mode: CredentialMode
  environmentName: string | null
  newValue: string | null
}

function parseCredential(value: unknown, field: string): ParsedCredential {
  const input = asObject(value, field)
  const mode = input.mode
  if (
    mode !== 'keep' &&
    mode !== 'none' &&
    mode !== 'environment' &&
    mode !== 'new'
  ) {
    throw new ModelSettingsError(
      'invalid_credential_mode',
      `${field}.mode 只能是 keep、none、environment 或 new`,
    )
  }
  if (mode === 'environment') {
    assertOnlyKeys(input, ['mode', 'environmentName'], field)
    return {
      mode,
      environmentName: requireEnvironmentName(input.environmentName),
      newValue: null,
    }
  }
  if (mode === 'new') {
    assertOnlyKeys(input, ['mode', 'value'], field)
    return {
      mode,
      environmentName: null,
      newValue: requireNewSecret(input.value),
    }
  }
  assertOnlyKeys(input, ['mode'], field)
  return { mode, environmentName: null, newValue: null }
}

function normalizeDraftBaseUrl(
  value: string | null,
  field: string,
  provider: ChatProvider | VisionProvider,
  allowPrivateNetwork: boolean,
): string | null {
  if (value === null) return null
  try {
    return validateModelBaseUrl(
      value,
      field,
      provider,
      allowPrivateNetwork,
    )
  } catch (error) {
    throw new ModelSettingsError(
      'invalid_model_url',
      safeError(error, `${field} 不合法`),
    )
  }
}

function resolveDraftCredential(
  credential: ParsedCredential,
  existingEnv: string | null,
  existingSecret: string | null,
  provider: ChatProvider | VisionProvider,
): { env: string | null; secret: string | null; newValue: string | null } {
  if (provider === 'dsh' || provider === 'mock') {
    if (credential.mode === 'new' || credential.mode === 'environment') {
      throw new ModelSettingsError(
        'credential_not_allowed',
        `${provider} provider 不接受本项目的 API key 配置`,
      )
    }
    return { env: null, secret: null, newValue: null }
  }
  switch (credential.mode) {
    case 'keep':
      return {
        env: existingEnv,
        secret: existingSecret,
        newValue: null,
      }
    case 'none':
      return { env: null, secret: null, newValue: null }
    case 'environment':
      return {
        env: credential.environmentName,
        secret: null,
        newValue: null,
      }
    case 'new':
      return {
        env: null,
        secret: null,
        newValue: credential.newValue,
      }
  }
}

function validateCredentialReuse(
  credential: ParsedCredential,
  currentProvider: ChatProvider | VisionProvider,
  currentRoute: string | null,
  currentBaseUrl: string | null,
  currentEnv: string | null,
  currentSecret: string | null,
  nextProvider: ChatProvider | VisionProvider,
  nextRoute: string | null,
  nextBaseUrl: string | null,
  field: string,
  disabled = false,
): void {
  if (
    disabled ||
    credential.mode !== 'keep' ||
    (currentEnv === null && currentSecret === null)
  ) {
    return
  }
  const changed =
    currentProvider !== nextProvider ||
    currentRoute !== nextRoute ||
    currentBaseUrl !== nextBaseUrl
  if (changed) {
    throw new ModelSettingsError(
      'credential_reuse_refused',
      `${field} 的端点或 provider 已改变；请显式填写新密钥或选择环境变量，不能把旧密钥发送到新地址`,
    )
  }
}

function buildOverlay(
  model: SystemConfig['model'],
  vision: VisionConfig,
): Record<string, unknown> {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    model: {
      provider: model.provider,
      route: model.route,
      name: model.name,
      base_url: model.baseUrl,
      api_key_env: model.apiKeyEnv,
      api_key_secret: model.apiKeySecret,
      allow_private_network: model.allowPrivateNetwork,
      timeout_ms: model.timeoutMs,
      max_retries: model.maxRetries,
      max_output_tokens: model.maxOutputTokens,
      reasoning_effort: model.reasoningEffort,
    },
    vision: {
      enabled: vision.enabled,
      provider: vision.provider,
      route: vision.route,
      name: vision.name,
      base_url: vision.baseUrl,
      api_key_env: vision.apiKeyEnv,
      api_key_secret: vision.apiKeySecret,
      allow_private_network: vision.allowPrivateNetwork,
      timeout_ms: vision.timeoutMs,
      max_retries: vision.maxRetries,
      max_output_tokens: vision.maxOutputTokens,
      max_image_bytes: vision.maxImageBytes,
      max_description_chars: vision.maxDescriptionChars,
    },
  }
}

function credentialView(
  apiKeyEnv: string | null,
  apiKeySecret: string | null,
  store: LocalSecretStore,
): CredentialView {
  if (apiKeyEnv !== null) {
    return {
      mode: 'environment',
      environmentName: apiKeyEnv,
      label: null,
      configured: true,
    }
  }
  if (apiKeySecret !== null) {
    return {
      mode: 'local-secret',
      environmentName: null,
      label: store.describe(apiKeySecret),
      configured: store.has(apiKeySecret),
    }
  }
  return {
    mode: 'none',
    environmentName: null,
    label: null,
    configured: false,
  }
}

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ModelSettingsError) return error.message
  if (error instanceof Error) {
    // 适配器的错误消息不含凭据值；配置加载错误也只带字段路径。
    return error.message || fallback
  }
  return fallback
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelSettingsError('invalid_settings', `${field} 必须是对象`)
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
      throw new ModelSettingsError(
        'invalid_settings',
        `${field} 包含不支持的字段 ${key}`,
      )
    }
  }
}

function parseChatProvider(value: unknown): ChatProvider {
  if (
    value !== 'mock' &&
    value !== 'magpie' &&
    value !== 'dsh' &&
    value !== 'openai-compatible'
  ) {
    throw new ModelSettingsError(
      'invalid_provider',
      'chat.provider 只能是 mock、magpie、dsh 或 openai-compatible',
    )
  }
  return value
}

function nullableVisionProvider(value: unknown): VisionProvider | null {
  if (value === null || value === undefined) return null
  if (value !== 'magpie' && value !== 'openai-compatible') {
    throw new ModelSettingsError(
      'invalid_provider',
      'vision.provider 只能是 magpie 或 openai-compatible',
    )
  }
  return value
}

function requiredDraftString(
  value: unknown,
  field: string,
  max: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ModelSettingsError(
      'invalid_settings',
      `${field} 必须是 1..${max} 字的单行文本`,
    )
  }
  return value.trim()
}

function nullableString(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === null || value === undefined || value === '') return null
  return requiredDraftString(value, field, max)
}

function integerIn(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ModelSettingsError(
      'invalid_settings',
      `${field} 必须是 ${min}..${max} 的整数`,
    )
  }
  return value
}

function nullableIntegerIn(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined) return null
  return integerIn(value, field, min, max)
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ModelSettingsError(
      'invalid_settings',
      `${field} 必须是布尔值`,
    )
  }
  return value
}

function nullableReasoningEffort(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const result = requiredDraftString(value, 'reasoningEffort', 32)
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(result)) {
    throw new ModelSettingsError(
      'invalid_settings',
      'reasoningEffort 必须是 low、high 这类小写标签',
    )
  }
  return result
}

function requireEnvironmentName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  ) {
    throw new ModelSettingsError(
      'invalid_environment_name',
      '环境变量名不合法',
    )
  }
  return value
}

function requireNewSecret(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelSettingsError('invalid_secret', '新密钥必须是字符串')
  }
  const normalized = value.trim()
  if (
    normalized === '' ||
    normalized.length > 8_192 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ModelSettingsError(
      'invalid_secret',
      '新密钥不能为空、不能包含控制字符，且不能超过 8192 字',
    )
  }
  return normalized
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
