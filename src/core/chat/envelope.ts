/**
 * M3.5 单次对话信封。
 *
 * 模型用一次流式调用返回一个 JSON 对象：
 * reply / memoryCandidates / appraisal / commitments。
 * 正文通过增量扫描 reply 字段继续逐字显示；其余字段只在流结束后解析。
 *
 * 解析器对正文采取“可用优先”策略：只要 reply 是完整字符串，即使后续
 * 元数据损坏，也能保留已经显示的回复并丢弃元数据。这不是把坏数据当真，
 * 而是避免一次格式错误同时吞掉整轮聊天。
 */

import type { ParsedMemoryCandidate } from '../memory/index.ts'
import { parseMemoryCandidate } from '../memory/index.ts'
import { MAX_CHAT_REPLY_CHARS } from './types.ts'

export const CHAT_ENVELOPE_SCHEMA_VERSION = 1
export const MAX_ENVELOPE_MEMORY_CANDIDATES = 3
export const MAX_ENVELOPE_COMMITMENTS = 3

export interface ChatEnvelopeAppraisal {
  valence: number
  arousal: number
  confidence: number
}

export interface ChatEnvelopeCommitment {
  text: string
  dueAt: string | null
}

export interface ParsedChatEnvelope {
  schemaVersion: 1
  reply: string
  memoryCandidates: ParsedMemoryCandidate[]
  skippedMemoryCandidates: number
  appraisal: ChatEnvelopeAppraisal | null
  commitments: ChatEnvelopeCommitment[]
  skippedCommitments: number
  // 可降级的问题代码；正文仍然有效时不会因此丢弃整轮回复。
  issues: string[]
}

export class ChatEnvelopeError extends Error {
  readonly code: 'chat_envelope_invalid_json' | 'chat_envelope_invalid_shape'

  constructor(
    code: 'chat_envelope_invalid_json' | 'chat_envelope_invalid_shape',
    message: string,
  ) {
    super(message)
    this.name = 'ChatEnvelopeError'
    this.code = code
  }
}

/**
 * 从流式 JSON 中增量提取顶层 reply 字符串。
 *
 * 只负责“尽早显示正文”，最终是否接受整轮结构仍由 parseChatEnvelope
 * 决定。解析器不把看到的 JSON 片段写进数据库或日志。
 */
export class ReplyEnvelopeStream {
  private raw = ''
  private valueStart: number | null = null
  private valueEnd: number | null = null
  private emitted = ''

  push(chunk: string): string {
    this.raw += chunk
    if (this.valueStart === null) {
      this.valueStart = findTopLevelReplyValueStart(this.raw)
    }
    if (this.valueStart === null) return ''
    if (this.valueEnd === null) {
      this.valueEnd = findJsonStringEnd(this.raw, this.valueStart)
    }
    const end = this.valueEnd ?? this.raw.length
    const decoded = decodeJsonStringPrefix(
      this.raw.slice(this.valueStart, end),
    )
    if (decoded.length <= this.emitted.length) return ''
    const suffix = decoded.slice(this.emitted.length)
    this.emitted = decoded
    return suffix
  }

  get rawOutput(): string {
    return this.raw
  }

  get visibleReply(): string {
    return this.emitted
  }

  /**
   * reply 字符串已经闭合时才返回完整正文。后面的 JSON 坏掉也不影响
   * 这里，因为调用方会把它当作降级回复。
   */
  completeReply(): string | null {
    if (this.valueStart === null || this.valueEnd === null) return null
    return decodeJsonStringPrefix(
      this.raw.slice(this.valueStart, this.valueEnd),
    )
  }
}

/**
 * 严格解析最终信封。JSON 根、schemaVersion 或 reply 本身无效时抛错；
 * 单条记忆、appraisal 或承诺无效时只记录 issue 并丢弃该项。
 */
export function parseChatEnvelope(
  raw: string,
  userText: string,
): ParsedChatEnvelope {
  const root = parseJsonObject(raw)
  if (root.schemaVersion !== CHAT_ENVELOPE_SCHEMA_VERSION) {
    throw new ChatEnvelopeError(
      'chat_envelope_invalid_shape',
      `unsupported chat envelope schema version ${String(root.schemaVersion)}`,
    )
  }
  if (typeof root.reply !== 'string' || root.reply.trim() === '') {
    throw new ChatEnvelopeError(
      'chat_envelope_invalid_shape',
      'chat envelope reply must be a non-empty string',
    )
  }
  if (Array.from(root.reply).length > MAX_CHAT_REPLY_CHARS) {
    throw new ChatEnvelopeError(
      'chat_envelope_invalid_shape',
      'chat envelope reply exceeds the configured limit',
    )
  }

  const issues: string[] = []
  const { candidates, skipped } = parseMemoryCandidates(
    root.memoryCandidates,
    userText,
    root.reply,
    issues,
  )
  const appraisal = parseAppraisal(root.appraisal, issues)
  const { commitments, skipped: skippedCommitments } = parseCommitments(
    root.commitments,
    issues,
  )

  return {
    schemaVersion: CHAT_ENVELOPE_SCHEMA_VERSION,
    reply: root.reply,
    memoryCandidates: candidates,
    skippedMemoryCandidates: skipped,
    appraisal,
    commitments,
    skippedCommitments,
    issues,
  }
}

function parseMemoryCandidates(
  value: unknown,
  userText: string,
  reply: string,
  issues: string[],
): { candidates: ParsedMemoryCandidate[]; skipped: number } {
  if (!Array.isArray(value)) {
    if (value !== undefined) issues.push('memory_candidates_not_array')
    return { candidates: [], skipped: 0 }
  }
  let skipped = Math.max(0, value.length - MAX_ENVELOPE_MEMORY_CANDIDATES)
  const candidates: ParsedMemoryCandidate[] = []
  for (const raw of value.slice(0, MAX_ENVELOPE_MEMORY_CANDIDATES)) {
    const candidate = parseMemoryCandidate(raw, userText, reply)
    if (candidate === null) {
      skipped += 1
    } else {
      candidates.push(candidate)
    }
  }
  if (skipped > 0) issues.push('memory_candidates_skipped')
  return { candidates, skipped }
}

function parseAppraisal(
  value: unknown,
  issues: string[],
): ChatEnvelopeAppraisal | null {
  if (value === undefined || value === null) {
    issues.push('appraisal_missing')
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push('appraisal_invalid')
    return null
  }
  const record = value as Record<string, unknown>
  const valence = finiteNumber(record.valence, -1, 1)
  const arousal = finiteNumber(record.arousal, 0, 1)
  const confidence = finiteNumber(record.confidence, 0, 1)
  if (valence === null || arousal === null || confidence === null) {
    issues.push('appraisal_invalid')
    return null
  }
  return { valence, arousal, confidence }
}

function parseCommitments(
  value: unknown,
  issues: string[],
): { commitments: ChatEnvelopeCommitment[]; skipped: number } {
  if (!Array.isArray(value)) {
    if (value !== undefined) issues.push('commitments_not_array')
    return { commitments: [], skipped: 0 }
  }
  let skipped = Math.max(0, value.length - MAX_ENVELOPE_COMMITMENTS)
  const commitments: ChatEnvelopeCommitment[] = []
  for (const raw of value.slice(0, MAX_ENVELOPE_COMMITMENTS)) {
    const commitment = parseCommitment(raw)
    if (commitment === null) {
      skipped += 1
    } else {
      commitments.push(commitment)
    }
  }
  if (skipped > 0) issues.push('commitments_skipped')
  return { commitments, skipped }
}

function parseCommitment(value: unknown): ChatEnvelopeCommitment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.text !== 'string') return null
  const text = record.text.trim()
  const length = Array.from(text).length
  if (length === 0 || length > 500) return null
  const dueAt = parseDueAt(record.dueAt)
  if (record.dueAt !== undefined && record.dueAt !== null && dueAt === null) {
    return null
  }
  return { text, dueAt }
}

function parseDueAt(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  return new Date(milliseconds).toISOString()
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new ChatEnvelopeError(
      'chat_envelope_invalid_json',
      'chat envelope is empty',
    )
  }
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(withoutFence) as unknown
  } catch {
    const first = withoutFence.indexOf('{')
    const last = withoutFence.lastIndexOf('}')
    if (first < 0 || last <= first) {
      throw new ChatEnvelopeError(
        'chat_envelope_invalid_json',
        'chat envelope is not valid JSON',
      )
    }
    try {
      parsed = JSON.parse(withoutFence.slice(first, last + 1)) as unknown
    } catch {
      throw new ChatEnvelopeError(
        'chat_envelope_invalid_json',
        'chat envelope is not valid JSON',
      )
    }
  }
  return asObject(parsed)
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChatEnvelopeError(
      'chat_envelope_invalid_shape',
      'chat envelope root must be an object',
    )
  }
  return value as Record<string, unknown>
}

/**
 * 找到顶层 reply 字符串值的起点。允许 schemaVersion 等标量先出现；
 * 只把 depth 为 1 的键当作候选，避免被正文里的 `"reply":` 欺骗。
 */
function findTopLevelReplyValueStart(raw: string): number | null {
  let depth = 0
  let index = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') {
      const end = findJsonStringEnd(raw, index + 1)
      if (end === null) return null
      if (depth === 1) {
        let next = skipWhitespace(raw, end + 1)
        if (raw[next] === ':') {
          let key: string
          try {
            key = JSON.parse(raw.slice(index, end + 1)) as string
          } catch {
            return null
          }
          if (key === 'reply') {
            next = skipWhitespace(raw, next + 1)
            return raw[next] === '"' ? next + 1 : null
          }
        }
      }
      index = end + 1
      continue
    }
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    index += 1
  }
  return null
}

function findJsonStringEnd(raw: string, start: number): number | null {
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') return index
  }
  return null
}

function skipWhitespace(raw: string, start: number): number {
  let index = start
  while (index < raw.length && /\s/.test(raw[index])) index += 1
  return index
}

/**
 * 解码可能有截断的 JSON 字符串内容。遇到不完整转义就停下，等下一个
 * token；已解码前缀因此不会因为半截 `\uXXXX` 而闪烁。
 */
function decodeJsonStringPrefix(raw: string): string {
  let result = ''
  let index = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char !== '\\') {
      result += char
      index += 1
      continue
    }
    if (index + 1 >= raw.length) break
    const escape = raw[index + 1]
    if (escape === 'u') {
      if (index + 5 >= raw.length) break
      const hex = raw.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
      const code = Number.parseInt(hex, 16)
      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 11 >= raw.length) break
        if (raw[index + 6] !== '\\' || raw[index + 7] !== 'u') break
        const lowHex = raw.slice(index + 8, index + 12)
        if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) break
        const low = Number.parseInt(lowHex, 16)
        if (low < 0xdc00 || low > 0xdfff) break
        result += String.fromCharCode(code, low)
        index += 12
        continue
      }
      result += String.fromCharCode(code)
      index += 6
      continue
    }
    const simple: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    }
    const decoded = simple[escape]
    if (decoded === undefined) break
    result += decoded
    index += 2
  }
  return result
}
