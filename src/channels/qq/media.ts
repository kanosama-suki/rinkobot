/**
 * QQ 入站图片读取。
 *
 * 优先让 NapCat 给出本机缓存路径，再尝试 get_file；最后才使用 get_msg
 * 刷新 QQ 图片直链。任何一步失败都会让整个逻辑回合失败，不能静默丢图。
 * 图片只在本轮内存中存在，不写数据库或日志。
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InboundImageReference } from '../types.ts'
import type {
  OneBotActionResponse,
  QqGateway,
} from './gateway.ts'

export type SupportedQqImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'

export interface ResolvedQqImage {
  mimeType: SupportedQqImageMime
  bytes: Uint8Array
  base64: string
  byteLength: number
}

export interface ResolveQqImagesOptions {
  maxBytesPerImage: number
  maxTotalBytes: number
  downloadTimeoutMs: number
  fetch?: typeof fetch
  readFile?: typeof readFile
  stat?: typeof stat
}

export class QqMediaError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QqMediaError'
    this.code = code
  }
}

export async function resolveQqImages(
  gateway: QqGateway,
  references: readonly InboundImageReference[],
  options: ResolveQqImagesOptions,
  signal: AbortSignal,
): Promise<ResolvedQqImage[]> {
  validateResolveOptions(options)
  const resolved: ResolvedQqImage[] = []
  let total = 0
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]
    if (reference === undefined) {
      throw new QqMediaError('image_missing', 'image reference disappeared')
    }
    if (signal.aborted) {
      throw new QqMediaError('aborted', 'image resolution was aborted')
    }
    const remaining = options.maxTotalBytes - total
    if (remaining <= 0) {
      throw new QqMediaError('images_too_large', 'total image budget exceeded')
    }
    const image = await resolveOne(
      gateway,
      reference,
      Math.min(options.maxBytesPerImage, remaining),
      options,
      signal,
    )
    total += image.byteLength
    resolved.push(image)
  }
  return resolved
}

async function resolveOne(
  gateway: QqGateway,
  reference: InboundImageReference,
  maxBytes: number,
  options: ResolveQqImagesOptions,
  signal: AbortSignal,
): Promise<ResolvedQqImage> {
  const localPath = await findLocalPath(gateway, reference, signal)
  if (localPath !== null) {
    const bytes = await readLocalImage(
      localPath,
      maxBytes,
      options,
    )
    return imageResult(bytes)
  }
  const url = await findFreshUrl(gateway, reference, signal)
  if (url === null) {
    throw new QqMediaError(
      'image_unavailable',
      'NapCat could not provide a readable local image or fresh URL',
    )
  }
  const bytes = await downloadQqImage(url, maxBytes, options, signal)
  return imageResult(bytes)
}

async function findLocalPath(
  gateway: QqGateway,
  reference: InboundImageReference,
  signal: AbortSignal,
): Promise<string | null> {
  // 不直接信任事件段里的 file 路径：只接受 NapCat 动作返回的本机路径，
  // 防止被伪造的事件诱导读取任意本地文件。
  if (reference.file !== null) {
    try {
      const response = await gateway.getImage(reference.file, signal)
      const path = extractLocalPath(response)
      if (path !== null) return path
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
    }
  }
  if (reference.fileId !== null) {
    try {
      const response = await gateway.getFile(reference.fileId, signal)
      const path = extractLocalPath(response)
      if (path !== null) return path
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
    }
  }
  return null
}

async function findFreshUrl(
  gateway: QqGateway,
  reference: InboundImageReference,
  signal: AbortSignal,
): Promise<string | null> {
  const direct = reference.file
  if (direct !== null && isAllowedQqImageUrl(direct)) return direct
  try {
    const response = await gateway.getMsg(reference.messageId, signal)
    return extractImageUrl(response)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return null
  }
}

async function readLocalImage(
  path: string,
  maxBytes: number,
  options: ResolveQqImagesOptions,
): Promise<Uint8Array> {
  let canonical: string
  let info
  try {
    canonical = await realpath(path)
    info = await (options.stat ?? stat)(canonical)
  } catch {
    throw new QqMediaError('image_unreadable', 'image cache file is missing')
  }
  if (!info.isFile()) {
    throw new QqMediaError('image_unreadable', 'image cache is not a file')
  }
  if (info.size <= 0 || info.size > maxBytes) {
    throw new QqMediaError(
      'image_too_large',
      'image cache file exceeds the configured budget',
    )
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(
      await (options.readFile ?? readFile)(canonical),
    )
  } catch {
    throw new QqMediaError('image_unreadable', 'cannot read image cache file')
  }
  // stat 与 readFile 之间文件可能被替换或增长；以实际读入字节为最终边界。
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new QqMediaError(
      'image_too_large',
      'image cache file exceeds the configured budget',
    )
  }
  return bytes
}

async function downloadQqImage(
  rawUrl: string,
  maxBytes: number,
  options: ResolveQqImagesOptions,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!isAllowedQqImageUrl(rawUrl)) {
    throw new QqMediaError(
      'image_url_rejected',
      'image URL is not an allowed QQ CDN endpoint',
    )
  }
  const timeout = AbortSignal.timeout(options.downloadTimeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(rawUrl, {
      redirect: 'error',
      signal: combined,
    })
  } catch {
    throw new QqMediaError(
      selectedAbortCode(signal, timeout),
      'image download failed',
    )
  }
  if (!response.ok) {
    throw new QqMediaError(
      'image_download_failed',
      `image download returned HTTP ${response.status}`,
    )
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new QqMediaError(
      'image_too_large',
      'downloaded image exceeds the configured budget',
    )
  }
  const bytes = await readResponseBytes(response, maxBytes, signal)
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new QqMediaError(
      'image_too_large',
      'downloaded image exceeds the configured budget',
    )
  }
  return bytes
}

/**
 * 不把响应整体交给 arrayBuffer()：不可信的 content-length 可能缺失或撒谎，
 * 流式读取并累计实际字节可以及时取消超大响应。
 */
async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body
  if (body === null) {
    throw new QqMediaError(
      'image_download_failed',
      'image download returned no body',
    )
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new QqMediaError(
          'image_too_large',
          'downloaded image exceeds the configured budget',
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof QqMediaError) throw error
    throw new QqMediaError(
      signal.aborted ? 'aborted' : 'image_download_failed',
      error instanceof Error ? error.message : 'image download failed',
    )
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function imageResult(bytes: Uint8Array): ResolvedQqImage {
  const mimeType = detectImageMime(bytes)
  return {
    mimeType,
    bytes,
    base64: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  }
}

export function detectImageMime(bytes: Uint8Array): SupportedQqImageMime {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  throw new QqMediaError(
    'unsupported_image_type',
    'QQ image is not PNG, JPEG or WebP',
  )
}

function extractLocalPath(response: OneBotActionResponse): string | null {
  const data = isRecord(response.data) ? response.data : {}
  for (const value of [data.file, data.url]) {
    const candidate = normalizeLocalCandidate(value)
    if (candidate !== null) return candidate
  }
  return null
}

function extractImageUrl(response: OneBotActionResponse): string | null {
  const data = isRecord(response.data) ? response.data : {}
  const segments = Array.isArray(data.message)
    ? data.message
    : Array.isArray(response.data)
      ? response.data
      : []
  for (const segment of segments) {
    if (!isRecord(segment) || !isRecord(segment.data)) continue
    if (
      (segment.type === 'image' || segment.type === 'mface') &&
      typeof segment.data.url === 'string' &&
      isAllowedQqImageUrl(segment.data.url)
    ) {
      return segment.data.url
    }
  }
  return typeof data.url === 'string' && isAllowedQqImageUrl(data.url)
    ? data.url
    : null
}

function normalizeLocalCandidate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  let candidate = value.trim()
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate)
    } catch {
      return null
    }
  }
  if (!isAbsolute(candidate)) return null
  return candidate
}

export function isAllowedQqImageUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return false
  const hostname = url.hostname.toLowerCase()
  const suffixes = [
    '.qq.com',
    '.qq.com.cn',
    '.qpic.cn',
    '.gtimg.com',
  ]
  return suffixes.some(suffix => hostname.endsWith(suffix))
}

function selectedAbortCode(
  signal: AbortSignal,
  timeout: AbortSignal,
): string {
  return signal.aborted ? 'aborted' : timeout.aborted
    ? 'image_download_timeout'
    : 'image_download_failed'
}

function validateResolveOptions(options: ResolveQqImagesOptions): void {
  if (
    !Number.isSafeInteger(options.maxBytesPerImage) ||
    options.maxBytesPerImage < 1 ||
    options.maxBytesPerImage > 5 * 1024 * 1024
  ) {
    throw new RangeError('maxBytesPerImage must be between 1 and 5242880')
  }
  if (
    !Number.isSafeInteger(options.maxTotalBytes) ||
    options.maxTotalBytes < 1 ||
    options.maxTotalBytes > 20 * 1024 * 1024
  ) {
    throw new RangeError('maxTotalBytes must be between 1 and 20971520')
  }
  if (
    !Number.isInteger(options.downloadTimeoutMs) ||
    options.downloadTimeoutMs < 1_000 ||
    options.downloadTimeoutMs > 60_000
  ) {
    throw new RangeError('downloadTimeoutMs must be between 1000 and 60000')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
