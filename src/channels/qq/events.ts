/**
 * OneBot 11 消息事件解析。
 *
 * 这里只做平台语义：白名单、自我消息、@ 判定、文字/图片提取和稳定
 * 会话键。它不读图片、不聚合连发，也不调用核心。
 */

import type { InboundImageReference } from '../types.ts'
import {
  targetAllowed,
  targetKey,
  type QqTarget,
} from './format.ts'

export interface QqEventPolicy {
  selfId: string | null
  privateAllow: readonly string[]
  groupAllow: readonly string[]
  groupRequireMention: boolean
  now?(): Date
}

export interface ParsedQqMessage {
  target: QqTarget
  targetKey: string
  conversationKey: string
  senderKey: string
  messageId: string
  messageKey: string
  text: string
  images: InboundImageReference[]
  mentionedBot: boolean
  receivedAt: string
}

export type ParsedQqEvent =
  | { kind: 'message'; message: ParsedQqMessage }
  | { kind: 'ignore'; reason: string }

interface ParsedSegments {
  text: string
  images: InboundImageReference[]
  mentionedBot: boolean
}

export function parseQqMessageEvent(
  raw: unknown,
  policy: QqEventPolicy,
): ParsedQqEvent {
  if (!isRecord(raw)) return { kind: 'ignore', reason: 'not_an_object' }
  if (raw.post_type !== 'message') {
    return { kind: 'ignore', reason: 'not_a_message' }
  }
  const messageType = raw.message_type
  if (messageType !== 'private' && messageType !== 'group') {
    return { kind: 'ignore', reason: 'unsupported_message_type' }
  }
  const messageId = positiveId(raw.message_id)
  if (messageId === null) {
    return { kind: 'ignore', reason: 'missing_message_id' }
  }
  const senderId = positiveId(raw.user_id) ??
    positiveId(isRecord(raw.sender) ? raw.sender.user_id : undefined)
  if (senderId === null) {
    return { kind: 'ignore', reason: 'missing_sender_id' }
  }
  if (policy.selfId !== null && senderId === policy.selfId) {
    return { kind: 'ignore', reason: 'self_message' }
  }

  let target: QqTarget
  let conversationKey: string
  if (messageType === 'private') {
    target = { kind: 'private', id: senderId }
    if (!targetAllowed(target, policy.privateAllow, policy.groupAllow)) {
      return { kind: 'ignore', reason: 'private_not_allowed' }
    }
    conversationKey = `qq-private-${senderId}`
  } else {
    const groupId = positiveId(raw.group_id)
    if (groupId === null) {
      return { kind: 'ignore', reason: 'missing_group_id' }
    }
    target = { kind: 'group', id: groupId }
    if (!targetAllowed(target, policy.privateAllow, policy.groupAllow)) {
      return { kind: 'ignore', reason: 'group_not_allowed' }
    }
    conversationKey = `qq-group-${groupId}`
  }

  const segments = parseMessageSegments(
    raw.message,
    policy.selfId,
    messageId,
  )
  return {
    kind: 'message',
    message: {
      target,
      targetKey: targetKey(target),
      conversationKey,
      senderKey: `${target.kind}:${target.id}:${senderId}`,
      messageId,
      messageKey: `qq:${target.kind}:${target.id}:${messageId}`,
      text: segments.text.trim(),
      images: segments.images,
      mentionedBot: segments.mentionedBot,
      receivedAt: eventTime(raw.time, policy.now),
    },
  }
}

export function shouldAcceptGroupMessage(
  message: ParsedQqMessage,
  groupRequireMention: boolean,
  hasPending: boolean,
): boolean {
  if (message.target.kind !== 'group') return true
  return !groupRequireMention || message.mentionedBot || hasPending
}

function parseMessageSegments(
  value: unknown,
  selfId: string | null,
  messageId: string,
): ParsedSegments {
  if (Array.isArray(value)) {
    return parseArraySegments(value, selfId, messageId)
  }
  if (typeof value === 'string') {
    return parseCqString(value, selfId, messageId)
  }
  return { text: '', images: [], mentionedBot: false }
}

function parseArraySegments(
  segments: unknown[],
  selfId: string | null,
  messageId: string,
): ParsedSegments {
  let text = ''
  let mentionedBot = false
  const images: InboundImageReference[] = []
  for (const item of segments) {
    if (!isRecord(item) || typeof item.type !== 'string') continue
    const data = isRecord(item.data) ? item.data : {}
    if (item.type === 'text') {
      if (typeof data.text === 'string') text += data.text
      continue
    }
    if (item.type === 'at') {
      const qq = positiveId(data.qq)
      if (qq !== null && selfId !== null && qq === selfId) {
        mentionedBot = true
      } else if (qq !== null) {
        text += `@${qq}`
      }
      continue
    }
    if (item.type === 'image' || item.type === 'mface') {
      images.push(imageReference(data, messageId))
    }
  }
  return { text, images, mentionedBot }
}

function parseCqString(
  raw: string,
  selfId: string | null,
  messageId: string,
): ParsedSegments {
  let text = ''
  let mentionedBot = false
  const images: InboundImageReference[] = []
  const pattern = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g
  let cursor = 0
  for (const match of raw.matchAll(pattern)) {
    const index = match.index ?? 0
    text += unescapeCq(raw.slice(cursor, index))
    cursor = index + match[0].length
    const type = match[1] ?? ''
    const data = parseCqParams(match[2] ?? '')
    if (type === 'at') {
      const qq = positiveId(data.qq)
      if (qq !== null && selfId !== null && qq === selfId) {
        mentionedBot = true
      } else if (qq !== null) {
        text += `@${qq}`
      }
    } else if (type === 'image' || type === 'mface') {
      images.push(imageReference(data, messageId))
    }
  }
  text += unescapeCq(raw.slice(cursor))
  return { text, images, mentionedBot }
}

function imageReference(
  data: Record<string, unknown>,
  messageId: string,
): InboundImageReference {
  const file = nonEmptyString(data.file)
  const fileId = nonEmptyString(data.file_id) ??
    nonEmptyString(data.file_id_)
  const declared = Number(data.file_size)
  return {
    file,
    fileId: fileId ?? file,
    messageId,
    declaredBytes:
      Number.isSafeInteger(declared) && declared > 0 ? declared : null,
  }
}

function parseCqParams(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  const body = raw.startsWith(',') ? raw.slice(1) : raw
  if (body === '') return result
  for (const item of body.split(',')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    result[item.slice(0, separator)] = unescapeCq(
      item.slice(separator + 1),
    )
  }
  return result
}

function unescapeCq(value: string): string {
  return value
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&#44;', ',')
    .replaceAll('&amp;', '&')
}

function eventTime(value: unknown, now?: () => Date): string {
  const seconds = Number(value)
  if (Number.isSafeInteger(seconds) && seconds > 0) {
    const date = new Date(seconds * 1_000)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  const current = now?.() ?? new Date()
  if (Number.isNaN(current.getTime())) {
    throw new RangeError('QQ event clock returned an invalid date')
  }
  return current.toISOString()
}

function positiveId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) {
    return value
  }
  return null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
