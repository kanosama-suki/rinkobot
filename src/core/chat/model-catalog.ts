/**
 * OpenAI-compatible `/v1/models` 的共享解析器。
 *
 * 聊天、视觉和设置页发现必须使用同一份能力解析，避免三处对
 * `modalities.input`、输出上限和推理档位做出不同判断。
 *
 * 边界：
 * - 只解析模型元数据，不发请求、不保存配置、不读取凭据；
 * - 根响应不是对象或缺少 data 数组时显式失败；
 * - 单条畸形模型记录可以跳过，但不会把它猜成支持图片或某个推理档位。
 */

import type { ChatModelPricing } from './types.ts'

export type ModelImageInput = 'supported' | 'unsupported' | 'unknown'

export interface ModelCatalogEntry {
  id: string
  maxOutputTokens: number | null
  reasoningEfforts: readonly string[] | null
  pricing: ChatModelPricing | null
  imageInput: ModelImageInput
}

export class ModelCatalogError extends Error {
  readonly code = 'model_catalog_invalid'

  constructor(message: string) {
    super(message)
    this.name = 'ModelCatalogError'
  }
}

export function parseOpenAIModelCatalog(payload: unknown): ModelCatalogEntry[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ModelCatalogError('model list is not an object')
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) {
    throw new ModelCatalogError('model list has no data array')
  }

  const result: ModelCatalogEntry[] = []
  for (const value of data) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const model = value as Record<string, unknown>
    if (typeof model.id !== 'string' || model.id === '') continue
    result.push({
      id: model.id,
      maxOutputTokens:
        Number.isSafeInteger(model.max_output_tokens) &&
        (model.max_output_tokens as number) > 0
          ? model.max_output_tokens as number
          : null,
      reasoningEfforts: parseReasoningEfforts(model),
      pricing: parsePricing(model.pricing),
      imageInput: parseImageInput(model.modalities),
    })
  }
  return result
}

export function modelCatalogMap(
  entries: readonly ModelCatalogEntry[],
): Map<string, ModelCatalogEntry> {
  return new Map(entries.map(entry => [entry.id, entry]))
}

function parseReasoningEfforts(
  model: Record<string, unknown>,
): string[] | null {
  const levels = new Set<string>()
  if (Array.isArray(model.reasoning_levels)) {
    for (const value of model.reasoning_levels) {
      if (typeof value === 'string' && value !== '') levels.add(value)
    }
  }
  if (Array.isArray(model.supported_reasoning_levels)) {
    for (const value of model.supported_reasoning_levels) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue
      }
      const effort = (value as Record<string, unknown>).effort
      if (typeof effort === 'string' && effort !== '') levels.add(effort)
    }
  }
  return levels.size === 0 ? null : [...levels]
}

function parseImageInput(value: unknown): ModelImageInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'unknown'
  }
  const input = (value as Record<string, unknown>).input
  if (!Array.isArray(input)) return 'unknown'
  return input.includes('image') ? 'supported' : 'unsupported'
}

function parsePricing(value: unknown): ChatModelPricing | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const pricing = value as Record<string, unknown>
  return {
    prompt: parsePrice(pricing.prompt),
    completion: parsePrice(pricing.completion),
    cacheRead: parsePrice(pricing.input_cache_read),
    cacheWrite: parsePrice(pricing.input_cache_write),
  }
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const price = Number(value)
  return Number.isFinite(price) && price >= 0 ? price : null
}
