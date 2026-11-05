/**
 * 聊天输入的边界解析。
 *
 * 纯字符串输入保持向后兼容；对象形式允许附加一张图片。图片只在本轮内存
 * 中存在，持久化的用户正文仍然只有文字；没有配文时使用明确占位符，
 * 避免数据库出现空正文或把视觉转述当作用户原话。
 */

import {
  MAX_CHAT_MESSAGE_CHARS,
  normalizeChatText,
} from '../storage/index.ts'
import {
  DEFAULT_VISION_MAX_IMAGE_BYTES,
  validateVisionImages,
  VisionInputError,
  type ValidatedVisionImage,
} from '../vision/index.ts'
import { ChatInputError } from './types.ts'

export const EMPTY_IMAGE_MESSAGE_TEXT = '（发送了一张图片）'

export interface ChatTurn {
  text: string
  images: ValidatedVisionImage[]
  imageOnly: boolean
}

export interface ChatTurnLimits {
  maxImageBytes?: number
}

export function parseChatTurnInput(
  input: unknown,
  limits: ChatTurnLimits = {},
): ChatTurn {
  let rawText: unknown
  let rawImages: unknown
  if (typeof input === 'string') {
    rawText = input
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'text' && key !== 'images') {
        throw new ChatInputError('invalid_message', `不支持字段 ${key}`)
      }
    }
    rawText = record.text
    rawImages = record.images
  } else {
    throw new ChatInputError('invalid_message', '消息必须是文本或消息对象')
  }

  let images: ValidatedVisionImage[]
  try {
    images = validateVisionImages(rawImages, {
      maxImageBytes: limits.maxImageBytes ?? DEFAULT_VISION_MAX_IMAGE_BYTES,
    })
  } catch (error) {
    if (error instanceof VisionInputError) {
      throw new ChatInputError(error.code, error.message)
    }
    throw error
  }

  if (rawText !== undefined && typeof rawText !== 'string') {
    throw new ChatInputError('invalid_message', '消息正文必须是文本')
  }
  const imageOnly =
    images.length > 0 && (rawText === undefined || rawText.trim() === '')
  try {
    const text = imageOnly
      ? normalizeChatText(EMPTY_IMAGE_MESSAGE_TEXT)
      : normalizeChatText(rawText)
    return { text, images, imageOnly }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new ChatInputError(
      'invalid_message',
      message.includes(String(MAX_CHAT_MESSAGE_CHARS))
        ? `消息长度必须在 1 到 ${MAX_CHAT_MESSAGE_CHARS} 个字符之间`
        : '消息不能为空，且必须是文本',
    )
  }
}
