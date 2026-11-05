/**
 * 视觉输入的领域契约。
 *
 * 视觉模型与聊天模型刻意分开：聊天模型只接收文字；图片先由独立模型转述，
 * 再作为不可信观察数据进入聊天上下文。图片字节不进入聊天消息、事件、
 * 长期记忆或普通审计。
 */

import type { ChatModelPricing, ChatUsage } from '../chat/types.ts'

export const MAX_VISION_IMAGES = 1
export const DEFAULT_VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const DEFAULT_VISION_MAX_DESCRIPTION_CHARS = 2_000

export const VISION_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const

export type VisionImageMimeType = (typeof VISION_IMAGE_MIME_TYPES)[number]

/** 浏览器/HTTP 边界提交的原始图片引用；解码前只允许受控的 MIME 和 base64。 */
export interface VisionImagePayload {
  mimeType: VisionImageMimeType
  data: string
}

/** 通过严格 base64 与魔数校验后的图片；调用方不得把 bytes 写入持久化。 */
export interface ValidatedVisionImage {
  mimeType: VisionImageMimeType
  bytes: Uint8Array
  base64: string
}

export interface VisionModelIdentity {
  id: string
  mode: string
  provider: string
}

export interface VisionDescribeRequest {
  image: Uint8Array
  mimeType: VisionImageMimeType
  // 只作为视觉模型的用户指令；不得包含系统提示词或凭据。
  instruction: string
  signal: AbortSignal
}

export interface VisionDescription {
  text: string
  attempts: number
  usage: ChatUsage | null
  estimatedCost: number | null
  pricing: ChatModelPricing | null
  responseId: string | null
}

export interface VisionModel {
  readonly id: string
  readonly mode: string
  readonly provider: string
  describeImage(request: VisionDescribeRequest): Promise<VisionDescription>
}

export class VisionModelError extends Error {
  readonly code: string
  readonly attempts: number

  constructor(code: string, message: string, attempts: number) {
    super(message)
    this.name = 'VisionModelError'
    this.code = code
    this.attempts = attempts
  }
}

/** 输入校验错误只暴露稳定 code 和用户可读说明，不包含图片内容。 */
export class VisionInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'VisionInputError'
    this.code = code
  }
}
