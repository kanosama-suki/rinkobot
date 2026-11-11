/**
 * 模型 provider 工厂。
 *
 * 这里是唯一把配置转换成 ChatModel / VisionModel 的地方。所有真实 provider
 * 在返回前完成精确模型与能力检查，失败时直接阻止启动，不自动降级到 mock
 * 或另一个模型。
 */

import {
  MagpieChatModel,
  MockChatModel,
  type ChatModel,
} from '../core/chat/index.ts'
import type {
  LoadedConfig,
  SystemConfig,
  VisionConfig,
} from '../core/config/index.ts'
import {
  MagpieVisionModel,
  type VisionModel,
} from '../core/vision/index.ts'
import { LocalSecretStore } from './secret-store.ts'
import { createEndpointPreflight } from './url-security.ts'

export type ModelProviderMode =
  | 'mock'
  | 'magpie'
  | 'openai-compatible'

export interface ModelRuntimeOptions {
  configDir: string
  /** 开发或测试显式覆盖 provider；正常运行使用配置文件。 */
  mode?: ModelProviderMode
  secretStore?: LocalSecretStore
  /** 设置页一次性连接测试使用；不会写入任何文件。 */
  apiKeyOverride?: string | null
}

export interface ModelRuntime {
  chat: ChatModel
  vision: VisionModel | null
}

export async function createModelRuntime(
  loaded: LoadedConfig,
  options: ModelRuntimeOptions,
): Promise<ModelRuntime> {
  const secretStore =
    options.secretStore ?? new LocalSecretStore(options.configDir)
  const chat = await createChatModelFromConfig(
    loaded.system.model,
    {
      ...options,
      secretStore,
    },
  )
  const vision = await createVisionModelFromConfig(
    loaded.system.vision,
    {
      ...options,
      secretStore,
    },
  )
  return { chat, vision }
}

export async function createChatModelFromConfig(
  config: SystemConfig['model'],
  options: ModelRuntimeOptions,
): Promise<ChatModel> {
  const provider = options.mode ?? config.provider
  if (provider === 'mock') {
    return new MockChatModel()
  }
  if (config.baseUrl === null || config.maxOutputTokens === null) {
    throw new Error(`${provider} provider configuration is incomplete`)
  }
  const apiKey = options.apiKeyOverride !== undefined
    ? normalizeOverrideCredential(options.apiKeyOverride)
    : resolveCredential(
        config.apiKeyEnv,
        config.apiKeySecret,
        options.secretStore ?? new LocalSecretStore(options.configDir),
        'model',
      )
  const openAICompatible = provider === 'openai-compatible'
  const model = new MagpieChatModel({
    baseUrl: config.baseUrl,
    model: config.name,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    reasoningEffort: config.reasoningEffort,
    apiKey,
    providerId: provider,
    mode: provider,
    providerName: openAICompatible ? 'OpenAI-compatible' : 'Magpie',
    sendSessionHeader: !openAICompatible,
    preflight: openAICompatible
      ? createEndpointPreflight(config.baseUrl, {
          allowPrivateNetwork: config.allowPrivateNetwork,
        })
      : null,
  })
  await model.checkAvailable()
  return model
}

export async function createVisionModelFromConfig(
  config: VisionConfig,
  options: ModelRuntimeOptions,
): Promise<VisionModel | null> {
  if (!config.enabled) return null
  if (options.mode === 'mock') {
    throw new Error('vision.enabled requires a real model provider, not mock')
  }
  const provider =
    options.mode === 'magpie' || options.mode === 'openai-compatible'
      ? options.mode
      : config.provider
  if (provider === null) {
    throw new Error('vision.provider is required when vision is enabled')
  }
  if (config.baseUrl === null || config.name === null || config.maxOutputTokens === null) {
    throw new Error('vision provider configuration is incomplete')
  }
  const apiKey = options.apiKeyOverride !== undefined
    ? normalizeOverrideCredential(options.apiKeyOverride)
    : resolveCredential(
        config.apiKeyEnv,
        config.apiKeySecret,
        options.secretStore ?? new LocalSecretStore(options.configDir),
        'vision',
      )
  const openAICompatible = provider === 'openai-compatible'
  const model = new MagpieVisionModel({
    baseUrl: config.baseUrl,
    model: config.name,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    apiKey,
    providerId: provider,
    mode: provider,
    sendSessionHeader: !openAICompatible,
    preflight: openAICompatible
      ? createEndpointPreflight(config.baseUrl, {
          allowPrivateNetwork: config.allowPrivateNetwork,
        })
      : null,
  })
  await model.checkAvailable()
  return model
}

export function resolveCredential(
  apiKeyEnv: string | null,
  apiKeySecret: string | null,
  secretStore: LocalSecretStore,
  field: string,
): string | null {
  if (apiKeyEnv !== null) {
    const value = process.env[apiKeyEnv]
    if (value === undefined || value.trim() === '') {
      // 只报告变量名，不打印或回显变量值。
      throw new Error(
        `${field}.api_key_env "${apiKeyEnv}" is configured but the environment variable is empty or missing`,
      )
    }
    return value
  }
  if (apiKeySecret !== null) {
    try {
      return secretStore.get(apiKeySecret)
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`${field}.api_key_secret could not be resolved`)
      }
      throw error
    }
  }
  return null
}

function normalizeOverrideCredential(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (normalized === '') {
    throw new Error('the one-shot model credential must not be empty')
  }
  return normalized
}

export { LocalSecretStore, SecretStoreError } from './secret-store.ts'
export {
  ModelEndpointError,
  createEndpointPreflight,
  endpointSecurityInternals,
} from './url-security.ts'
