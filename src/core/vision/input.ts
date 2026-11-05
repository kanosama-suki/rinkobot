/**
 * 图片请求的严格输入校验。
 *
 * 只接受单张 PNG/JPEG/WebP 的规范 base64。这里同时检查解码后的字节数、
 * 规范编码和文件魔数，避免把任意二进制或伪装 MIME 的内容送进模型。
 */

import {
  MAX_VISION_IMAGES,
  VISION_IMAGE_MIME_TYPES,
  VisionInputError,
  type ValidatedVisionImage,
  type VisionImageMimeType,
} from './types.ts'

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface VisionInputLimits {
  maxImageBytes: number
}

export function validateVisionImages(
  value: unknown,
  limits: VisionInputLimits,
): ValidatedVisionImage[] {
  if (
    !Number.isSafeInteger(limits.maxImageBytes) ||
    limits.maxImageBytes < 1 ||
    limits.maxImageBytes > 5 * 1024 * 1024
  ) {
    throw new RangeError('vision.maxImageBytes must be between 1 and 5242880')
  }
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new VisionInputError('invalid_images', 'images 必须是数组')
  }
  if (value.length === 0) return []
  if (value.length > MAX_VISION_IMAGES) {
    // 第一版只允许一张，避免视觉费用和上下文长度不可控。
    throw new VisionInputError(
      'too_many_images',
      `每条消息最多附加 ${MAX_VISION_IMAGES} 张图片`,
    )
  }
  return value.map((item, index) => validateImage(item, index, limits))
}

function validateImage(
  value: unknown,
  index: number,
  limits: VisionInputLimits,
): ValidatedVisionImage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VisionInputError(
      'invalid_image',
      `第 ${index + 1} 张图片必须是对象`,
    )
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'mimeType' && key !== 'data') {
      throw new VisionInputError(
        'invalid_image',
        `第 ${index + 1} 张图片包含不支持字段 ${key}`,
      )
    }
  }
  if (
    typeof record.mimeType !== 'string' ||
    !VISION_IMAGE_MIME_TYPES.includes(record.mimeType as VisionImageMimeType)
  ) {
    throw new VisionInputError(
      'unsupported_image_type',
      '图片只支持 PNG、JPEG 或 WebP',
    )
  }
  const mimeType = record.mimeType as VisionImageMimeType
  if (typeof record.data !== 'string' || record.data === '') {
    throw new VisionInputError('invalid_image', '图片数据不能为空')
  }
  // 先按 base64 长度估算，避免为超大字符串分配解码内存。
  const maxEncodedLength = Math.ceil(limits.maxImageBytes / 3) * 4
  if (record.data.length > maxEncodedLength) {
    throw new VisionInputError(
      'image_too_large',
      `单张图片不能超过 ${Math.floor(limits.maxImageBytes / 1024)} KiB`,
    )
  }
  if (!BASE64.test(record.data)) {
    throw new VisionInputError('invalid_image', '图片数据不是规范的 base64')
  }

  const bytes = Buffer.from(record.data, 'base64')
  if (bytes.byteLength === 0) {
    throw new VisionInputError('invalid_image', '图片数据不能为空')
  }
  if (bytes.byteLength > limits.maxImageBytes) {
    throw new VisionInputError(
      'image_too_large',
      `单张图片不能超过 ${Math.floor(limits.maxImageBytes / 1024)} KiB`,
    )
  }
  // Buffer.from 对部分残缺输入较宽松；重新编码必须逐字一致。
  if (bytes.toString('base64') !== record.data) {
    throw new VisionInputError('invalid_image', '图片数据不是规范的 base64')
  }
  if (!matchesMagic(bytes, mimeType)) {
    throw new VisionInputError(
      'image_type_mismatch',
      '图片内容与声明的格式不一致',
    )
  }
  return {
    mimeType,
    bytes: new Uint8Array(bytes),
    base64: record.data,
  }
}

function matchesMagic(bytes: Uint8Array, mimeType: VisionImageMimeType): boolean {
  switch (mimeType) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case 'image/webp':
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.byteLength >= 12 &&
        String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
      )
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false
  return prefix.every((value, index) => bytes[index] === value)
}
