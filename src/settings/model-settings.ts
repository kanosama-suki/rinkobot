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
import {
  ModelCatalogError,
  parseOpenAIModelCatalog,
  type ModelCatalogEntry,
  type ModelImageInput,
} from '../core/chat/model-catalog.ts'
import type { VisionModel } from '../core/vision/index.ts'
import {
  createChatModelFromConfig,
  createVisionModelFromConfig,
  createEndpointPreflight,
  LocalSecretStore,
  type DshLlmBridge,
  type DshProviderInfo,
  type DshResolvedModelInfo,
  resolveCredential,
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

export interface ModelDiscoveryDraft {
  chat: {
    provider: ChatProvider
    route: string | null
    baseUrl: string | null
    timeoutMs: number
    allowPrivateNetwork: boolean
    credential: CredentialDraft
  }
  vision: {
    enabled: boolean
    provider: VisionProvider | null
    baseUrl: string | null
    timeoutMs: number
    allowPrivateNetwork: boolean
    credential: CredentialDraft
  }
}

export interface DiscoveredModel {
  id: string
  maxOutputTokens: number | null
  reasoningEfforts: readonly string[] | null
  imageInput: ModelImageInput
}

export interface ModelDiscoveryResult {
  chat: {
    provider: ChatProvider
    route: string | null
    providers: DshProviderInfo[]
    models: DiscoveredModel[]
  }
  vision: {
    enabled: boolean
    provider: VisionProvider | null
    /** 上游明确声明支持图片输入。 */
    supported: DiscoveredModel[]
    /** 上游没有声明图片能力；只能手选，保存前仍必须连接测试。 */
    unknown: DiscoveredModel[]
  }
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
  /** 模型发现请求的总超时；默认 10 秒，测试可缩短。 */
  discoveryTimeoutMs?: number
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

interface ParsedDiscoveryChatDraft
  extends Omit<ModelDiscoveryDraft['chat'], 'credential'> {
  credential: ParsedCredential
}

interface ParsedDiscoveryVisionDraft
  extends Omit<ModelDiscoveryDraft['vision'], 'credential'> {
  credential: ParsedCredential
}

interface ParsedDiscoveryDraft {
  chat: ParsedDiscoveryChatDraft
  vision: ParsedDiscoveryVisionDraft
}

interface ResolvedDiscoveryDraft {
  chat: {
    provider: ChatProvider
    route: string | null
    baseUrl: string | null
    timeoutMs: number
    allowPrivateNetwork: boolean
    apiKey: string | null
  }
  vision: {
    enabled: boolean
    provider: VisionProvider | null
    baseUrl: string | null
    timeoutMs: number
    allowPrivateNetwork: boolean
    apiKey: string | null
  }
}

export class ModelSettingsService {
  private readonly configDir: string
  private readonly secretStore: LocalSecretStore
  private readonly llm: DshLlmBridge | undefined
  private readonly readOnly: boolean
  private readonly discoveryTimeoutMs: number
  private loaded: LoadedConfig

  constructor(options: ModelSettingsServiceOptions) {
    this.configDir = options.configDir
    this.loaded = options.loaded
    this.llm = options.llm
    this.readOnly = options.readOnly ?? false
    this.discoveryTimeoutMs = validateDiscoveryTimeout(
      options.discoveryTimeoutMs ?? 10_000,
    )
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

  /**
   * 只读模型发现。请求体来自当前页面草稿，但不会写 runtime overlay，
   * 不会保存新密钥，也不会把密钥、secret 引用或完整草稿回显给页面。
   */
  async discover(input: unknown): Promise<ModelDiscoveryResult> {
    let resolved: ResolvedDiscoveryDraft
    try {
      resolved = this.resolveDiscoveryDraft(input)
    } catch (error) {
      if (error instanceof ModelSettingsError) throw error
      throw new ModelSettingsError(
        'model_discovery_failed',
        safeDiscoveryMessage(error, '模型发现配置无法解析'),
      )
    }
    const chatPromise = this.discoverChat(resolved.chat)
    const visionPromise = this.discoverVision(resolved.vision)
    const [chat, vision] = await Promise.all([chatPromise, visionPromise])
    return { chat, vision }
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

  private async discoverChat(
    draft: ResolvedDiscoveryDraft['chat'],
  ): Promise<ModelDiscoveryResult['chat']> {
    if (draft.provider === 'mock') {
      return {
        provider: draft.provider,
        route: null,
        providers: [],
        models: [],
      }
    }
    if (draft.provider === 'dsh') {
      const llm = this.llm
      if (llm === undefined) {
        throw new ModelSettingsError(
          'model_discovery_host_unavailable',
          '当前宿主没有提供 ctx.llm，无法发现 DSH 模型。',
        )
      }
      try {
        const providers = llm.listProviders().map(provider => ({
          id: provider.id,
          name: provider.name,
        }))
        const route = draft.route
        if (route === null) {
          return {
            provider: draft.provider,
            route: null,
            providers,
            models: [],
          }
        }
        const models = await withDiscoveryTimeout(
          llm.listModels(route),
          this.discoveryTimeoutMs,
        )
        return {
          provider: draft.provider,
          route,
          providers,
          models: models.map(dshModelToDiscoveredModel),
        }
      } catch (error) {
        if (error instanceof ModelSettingsError) throw error
        throw new ModelSettingsError(
          'model_discovery_dsh_failed',
          safeDiscoveryMessage(error, 'DSH 模型列表读取失败'),
        )
      }
    }

    if (draft.baseUrl === null) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        '模型发现需要完整的 Base URL。',
      )
    }
    const entries = await discoverOpenAIModels({
      baseUrl: draft.baseUrl,
      provider: draft.provider,
      allowPrivateNetwork: draft.allowPrivateNetwork,
      timeoutMs: Math.min(draft.timeoutMs, this.discoveryTimeoutMs),
      apiKey: draft.apiKey,
    })
    return {
      provider: draft.provider,
      route: null,
      providers: [],
      models: entries.map(toDiscoveredModel),
    }
  }

  private async discoverVision(
    draft: ResolvedDiscoveryDraft['vision'],
  ): Promise<ModelDiscoveryResult['vision']> {
    if (!draft.enabled || draft.provider === null) {
      return {
        enabled: false,
        provider: null,
        supported: [],
        unknown: [],
      }
    }
    if (draft.baseUrl === null) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        '视觉模型发现需要完整的 Base URL。',
      )
    }
    const entries = await discoverOpenAIModels({
      baseUrl: draft.baseUrl,
      provider: draft.provider,
      allowPrivateNetwork: draft.allowPrivateNetwork,
      timeoutMs: Math.min(draft.timeoutMs, this.discoveryTimeoutMs),
      apiKey: draft.apiKey,
    })
    const supported: DiscoveredModel[] = []
    const unknown: DiscoveredModel[] = []
    for (const entry of entries) {
      if (entry.imageInput === 'unsupported') continue
      const model = toDiscoveredModel(entry)
      if (entry.imageInput === 'supported') supported.push(model)
      else unknown.push(model)
    }
    return {
      enabled: true,
      provider: draft.provider,
      supported,
      unknown,
    }
  }

  private resolveDiscoveryDraft(input: unknown): ResolvedDiscoveryDraft {
    const draft = parseDiscoveryDraft(input)
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
    validateDiscoveryProviderFields(draft.chat, draft.vision)
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
    return {
      chat: {
        provider: draft.chat.provider,
        route: draft.chat.provider === 'dsh' ? draft.chat.route : null,
        baseUrl: chatBaseUrl,
        timeoutMs: draft.chat.timeoutMs,
        allowPrivateNetwork: draft.chat.allowPrivateNetwork,
        apiKey: resolveDiscoveryApiKey(chatCredential, this.secretStore, 'chat'),
      },
      vision: {
        enabled: draft.vision.enabled,
        provider: draft.vision.provider,
        baseUrl: visionBaseUrl,
        timeoutMs: draft.vision.timeoutMs,
        allowPrivateNetwork: draft.vision.allowPrivateNetwork,
        apiKey: draft.vision.enabled
          ? resolveDiscoveryApiKey(
              visionCredential,
              this.secretStore,
              'vision',
            )
          : null,
      },
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

const MAX_DISCOVERY_RESPONSE_BYTES = 1024 * 1024

function parseDiscoveryDraft(value: unknown): ParsedDiscoveryDraft {
  const root = asObject(value, '模型发现请求')
  assertOnlyKeys(root, ['chat', 'vision'], '模型发现请求')
  return {
    chat: parseDiscoveryChatDraft(root.chat),
    vision: parseDiscoveryVisionDraft(root.vision),
  }
}

function parseDiscoveryChatDraft(value: unknown): ParsedDiscoveryChatDraft {
  const input = asObject(value, 'chat')
  assertOnlyKeys(
    input,
    [
      'provider',
      'route',
      'baseUrl',
      'timeoutMs',
      'allowPrivateNetwork',
      'credential',
    ],
    'chat',
  )
  return {
    provider: parseChatProvider(input.provider),
    route: nullableString(input.route, 'chat.route', 128),
    baseUrl: nullableString(input.baseUrl, 'chat.baseUrl', 512),
    timeoutMs: integerIn(input.timeoutMs, 'chat.timeoutMs', 1_000, 600_000),
    allowPrivateNetwork: booleanValue(
      input.allowPrivateNetwork,
      'chat.allowPrivateNetwork',
    ),
    credential: parseCredential(input.credential, 'chat.credential'),
  }
}

function parseDiscoveryVisionDraft(
  value: unknown,
): ParsedDiscoveryVisionDraft {
  const input = asObject(value, 'vision')
  assertOnlyKeys(
    input,
    [
      'enabled',
      'provider',
      'baseUrl',
      'timeoutMs',
      'allowPrivateNetwork',
      'credential',
    ],
    'vision',
  )
  return {
    enabled: booleanValue(input.enabled, 'vision.enabled'),
    provider: nullableVisionProvider(input.provider),
    baseUrl: nullableString(input.baseUrl, 'vision.baseUrl', 512),
    timeoutMs: integerIn(input.timeoutMs, 'vision.timeoutMs', 1_000, 600_000),
    allowPrivateNetwork: booleanValue(
      input.allowPrivateNetwork,
      'vision.allowPrivateNetwork',
    ),
    credential: parseCredential(input.credential, 'vision.credential'),
  }
}

function validateDiscoveryProviderFields(
  chat: ParsedDiscoveryChatDraft,
  vision: ParsedDiscoveryVisionDraft,
): void {
  if (chat.provider === 'dsh') {
    if (chat.baseUrl !== null) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        'DSH provider 不能填写 Base URL。',
      )
    }
    if (
      chat.credential.mode === 'environment' ||
      chat.credential.mode === 'new'
    ) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        'DSH provider 的凭据由宿主管理，不能提交 API key。',
      )
    }
  } else if (chat.route !== null) {
    throw new ModelSettingsError(
      'model_discovery_invalid_config',
      '只有 DSH provider 接受 route。',
    )
  }
  if (chat.provider === 'mock') {
    if (
      chat.baseUrl !== null ||
      chat.credential.mode === 'environment' ||
      chat.credential.mode === 'new'
    ) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        'mock provider 不接受端点和凭据。',
      )
    }
  } else if (
    chat.provider === 'magpie' ||
    chat.provider === 'openai-compatible'
  ) {
    if (chat.baseUrl === null) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        '模型发现需要完整的 Base URL。',
      )
    }
  }
  if (vision.enabled) {
    if (vision.provider === null || vision.baseUrl === null) {
      throw new ModelSettingsError(
        'model_discovery_invalid_config',
        '启用视觉时必须填写 provider 和 Base URL。',
      )
    }
  } else if (
    vision.credential.mode === 'environment' ||
    vision.credential.mode === 'new'
  ) {
    throw new ModelSettingsError(
      'model_discovery_invalid_config',
      '视觉未启用时不应提交新的 API key。',
    )
  }
}

function resolveDiscoveryApiKey(
  credential: {
    env: string | null
    secret: string | null
    newValue: string | null
  },
  store: LocalSecretStore,
  label: string,
): string | null {
  if (credential.newValue !== null) return credential.newValue
  return resolveCredential(
    credential.env,
    credential.secret,
    store,
    `${label}.model_discovery`,
  )
}

async function discoverOpenAIModels(input: {
  baseUrl: string
  provider: ChatProvider | VisionProvider
  allowPrivateNetwork: boolean
  timeoutMs: number
  apiKey: string | null
}): Promise<ModelCatalogEntry[]> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, input.timeoutMs)
  const preflight = input.provider === 'openai-compatible'
    ? createEndpointPreflight(input.baseUrl, {
        allowPrivateNetwork: input.allowPrivateNetwork,
      })
    : null
  try {
    await preflight?.()
    const headers: Record<string, string> = {
      accept: 'application/json',
    }
    if (input.apiKey !== null) {
      headers.authorization = `Bearer ${input.apiKey}`
    }
    const response = await fetch(`${input.baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) {
      await cancelResponseBody(response)
      throw discoveryHttpError(response.status)
    }
    const payload = await readDiscoveryJson(response)
    try {
      return parseOpenAIModelCatalog(payload)
    } catch (error) {
      if (error instanceof ModelCatalogError) {
        throw new ModelSettingsError(
          'model_discovery_invalid_response',
          '模型列表响应格式不合法。',
        )
      }
      throw error
    }
  } catch (error) {
    if (error instanceof ModelSettingsError) throw error
    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      throw new ModelSettingsError(
        'model_discovery_timeout',
        `模型发现超过 ${input.timeoutMs} ms。`,
      )
    }
    throw new ModelSettingsError(
      'model_discovery_unavailable',
      safeDiscoveryMessage(error, '无法连接模型服务。'),
    )
  } finally {
    clearTimeout(timer)
  }
}

function discoveryHttpError(status: number): ModelSettingsError {
  if (status === 401 || status === 403) {
    return new ModelSettingsError(
      'model_discovery_auth_failed',
      '模型服务拒绝了当前凭据（HTTP 401/403）。',
    )
  }
  if (status === 408 || status === 504) {
    return new ModelSettingsError(
      'model_discovery_timeout',
      `模型服务报告超时（HTTP ${status}）。`,
    )
  }
  return new ModelSettingsError(
    'model_discovery_http_error',
    `模型服务返回 HTTP ${status}。`,
  )
}

async function readDiscoveryJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_DISCOVERY_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response)
    throw new ModelSettingsError(
      'model_discovery_invalid_response',
      '模型列表响应过大。',
    )
  }
  if (response.body === null) {
    throw new ModelSettingsError(
      'model_discovery_invalid_response',
      '模型列表响应为空。',
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_DISCOVERY_RESPONSE_BYTES) {
        throw new ModelSettingsError(
          'model_discovery_invalid_response',
          '模型列表响应过大。',
        )
      }
      chunks.push(result.value)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 读取失败时释放连接；原始错误仍然保留。
    }
  }
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ModelSettingsError(
      'model_discovery_invalid_response',
      '模型列表响应不是合法 JSON。',
    )
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 错误正文不读取、不返回、不写日志。
  }
}

function toDiscoveredModel(entry: ModelCatalogEntry): DiscoveredModel {
  return {
    id: entry.id,
    maxOutputTokens: entry.maxOutputTokens,
    reasoningEfforts:
      entry.reasoningEfforts === null ? null : [...entry.reasoningEfforts],
    imageInput: entry.imageInput,
  }
}

function dshModelToDiscoveredModel(
  model: DshResolvedModelInfo,
): DiscoveredModel {
  return {
    id: model.id,
    maxOutputTokens:
      Number.isSafeInteger(model.defaultMaxTokens) &&
      (model.defaultMaxTokens ?? 0) > 0
        ? model.defaultMaxTokens as number
        : null,
    reasoningEfforts:
      model.reasoning === undefined
        ? null
        : model.reasoning.efforts.map(effort => effort.id),
    imageInput:
      model.inputModalities === undefined
        ? 'unknown'
        : model.inputModalities.includes('image')
          ? 'supported'
          : 'unsupported',
  }
}

async function withDiscoveryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ModelSettingsError(
            'model_discovery_timeout',
            `DSH 模型发现超过 ${timeoutMs} ms。`,
          ))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function safeDiscoveryMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') {
    // 适配器和 fetch 的错误消息不含请求头或密钥值。
    return error.message
  }
  return fallback
}

function validateDiscoveryTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError('discoveryTimeoutMs must be between 1 and 60000')
  }
  return value
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
