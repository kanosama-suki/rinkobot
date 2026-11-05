/**
 * 存储层记录和标识符校验。
 *
 * 这里只校验可进入 SQLite 的壳结构；事件和记忆的语义校验仍由 state 模块
 * 负责。所有会进入 SQL 标识符位置的字段都必须是受限 ASCII 标识符。
 */

import { parseInstant } from '../state/index.ts'
import { StorageError } from './errors.ts'
import type {
  BodyRecord,
  ChatRole,
  OutboxRecord,
  OutboxStatus,
} from './types.ts'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,127}$/
export const MAX_CHAT_MESSAGE_CHARS = 4_000
export const MAX_MEMORY_TEXT_CHARS = 4_000
const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'pending',
  'delivered',
  'failed',
  'cancelled',
]

export interface BodyInput {
  id: string
  kind: string
  content: string
  createdAt?: string
}

export function validateBodyInput(input: BodyInput): BodyRecord {
  const id = validateIdentifier(input.id, 'body.id')
  if (!KIND.test(input.kind)) {
    invalid('body.kind', 'expected a lowercase kind')
  }
  if (input.content.length === 0 || input.content.length > 10_000_000) {
    invalid('body.content', 'expected 1..10000000 characters')
  }
  return {
    id,
    kind: input.kind,
    content: input.content,
    createdAt: input.createdAt ?? '',
  }
}

export function validateOutboxRecord(value: OutboxRecord): OutboxRecord {
  const id = validateIdentifier(value.id, 'outbox.id')
  if (
    value.target.length === 0 ||
    value.target.length > 512 ||
    value.target.includes('\0')
  ) {
    invalid('outbox.target', 'expected 1..512 characters without NUL')
  }
  const payloadRef = validateIdentifier(value.payloadRef, 'outbox.payloadRef')
  if (!OUTBOX_STATUSES.includes(value.status)) {
    invalid('outbox.status', `unsupported status "${value.status}"`)
  }
  const dueAt =
    value.dueAt === null ? null : validateInstant(value.dueAt, 'outbox.dueAt')
  const createdAt = validateInstant(value.createdAt, 'outbox.createdAt')
  if (!Number.isInteger(value.attempts) || value.attempts < 0) {
    invalid('outbox.attempts', 'expected a non-negative integer')
  }
  if (value.lastErrorCode !== null && !ERROR_CODE.test(value.lastErrorCode)) {
    invalid('outbox.lastErrorCode', 'expected a lowercase error code')
  }
  return {
    id,
    target: value.target,
    payloadRef,
    status: value.status,
    dueAt,
    createdAt,
    attempts: value.attempts,
    lastErrorCode: value.lastErrorCode,
  }
}

export function validateIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    invalid(field, 'expected a safe identifier')
  }
  return value
}

export function validateChatRole(value: unknown): ChatRole {
  if (value !== 'user' && value !== 'assistant') {
    invalid('message.role', 'expected "user" or "assistant"')
  }
  return value
}

export function normalizeChatText(value: unknown, field = 'message.text'): string {
  if (typeof value !== 'string') {
    invalid(field, 'expected a string')
  }
  const text = value.trim()
  const length = Array.from(text).length
  if (length === 0 || length > MAX_CHAT_MESSAGE_CHARS) {
    invalid(field, `expected 1..${MAX_CHAT_MESSAGE_CHARS} characters`)
  }
  return text
}

export function normalizeMemoryText(
  value: unknown,
  field = 'memory.text',
): string {
  if (typeof value !== 'string') {
    invalid(field, 'expected a string')
  }
  const text = value.trim()
  const length = Array.from(text).length
  if (length === 0 || length > MAX_MEMORY_TEXT_CHARS) {
    invalid(field, `expected 1..${MAX_MEMORY_TEXT_CHARS} characters`)
  }
  return text
}

export function validateInstant(value: string, field: string): string {
  try {
    parseInstant(value, field)
  } catch (error) {
    invalid(field, error instanceof Error ? error.message : String(error))
  }
  return value
}

export function invalid(field: string, message: string): never {
  throw new StorageError('RECORD_INVALID', `${field}: ${message}`)
}
