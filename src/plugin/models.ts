/**
 * 宿主与本地开发入口共用的模型工厂。
 *
 * 真实模式只接受配置中的本机回环 Magpie 路由；工厂在返回前完成精确模型
 * 可用性检查。任何失败都向上抛出，不自动降级到 mock 或另一个模型。
 */

import {
  MagpieChatModel,
  MockChatModel,
  type ChatModel,
} from '../core/chat/index.ts'
import type { LoadedConfig } from '../core/config/index.ts'
import {
  MagpieVisionModel,
  type VisionModel,
} from '../core/vision/index.ts'

export type KanobotModelMode = 'mock' | 'magpie'

export async function createChatModel(
  loaded: LoadedConfig,
  modelMode: KanobotModelMode,
): Promise<ChatModel> {
  if (modelMode === 'mock') {
    return new MockChatModel()
  }

  const model = loaded.system.model
  if (model.provider !== 'magpie') {
    throw new Error(
      `modelMode "magpie" requires model.provider "magpie"; got "${model.provider}"`,
    )
  }
  if (model.baseUrl === null) {
    throw new Error('modelMode "magpie" requires model.base_url')
  }
  if (model.maxOutputTokens === null) {
    throw new Error('modelMode "magpie" requires model.max_output_tokens')
  }
  const magpie = new MagpieChatModel({
    baseUrl: model.baseUrl,
    model: model.name,
    maxOutputTokens: model.maxOutputTokens,
    timeoutMs: model.timeoutMs,
    maxRetries: model.maxRetries,
    reasoningEffort: model.reasoningEffort,
    apiKey: resolveApiKey(model.apiKeyEnv, 'model.api_key_env'),
  })
  await magpie.checkAvailable()
  return magpie
}

export async function createVisionModel(
  loaded: LoadedConfig,
  modelMode: KanobotModelMode,
): Promise<VisionModel | null> {
  const vision = loaded.system.vision
  if (!vision.enabled) return null
  if (modelMode !== 'magpie') {
    // mock 模式承诺不调用真实模型；带图配置必须显式切到真实路由，
    // 不能一边显示 mock 一边偷偷发起视觉请求。
    throw new Error('vision.enabled requires modelMode "magpie"')
  }
  if (
    vision.provider !== 'magpie' ||
    vision.baseUrl === null ||
    vision.name === null ||
    vision.maxOutputTokens === null
  ) {
    throw new Error('vision configuration is incomplete')
  }
  const model = new MagpieVisionModel({
    baseUrl: vision.baseUrl,
    model: vision.name,
    maxOutputTokens: vision.maxOutputTokens,
    timeoutMs: vision.timeoutMs,
    maxRetries: vision.maxRetries,
    apiKey: resolveApiKey(vision.apiKeyEnv, 'vision.api_key_env'),
  })
  await model.checkAvailable()
  return model
}

function resolveApiKey(apiKeyEnv: string | null, field: string): string | null {
  if (apiKeyEnv === null) return null
  const value = process.env[apiKeyEnv]
  if (value === undefined || value.trim() === '') {
    // 只报告变量名，不打印或回显变量值。
    throw new Error(
      `${field} "${apiKeyEnv}" is configured but the environment variable is empty or missing`,
    )
  }
  return value
}
