/**
 * QQ 目标与出站文本格式。
 *
 * 回复拆分只处理平台排版，不改写正文；未知目标一律拒绝，不能把任意
 * outbox 字符串解释成新收件人。
 */

export interface QqTarget {
  kind: 'private' | 'group'
  id: string
}

export class QqFormatError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QqFormatError'
    this.code = code
  }
}

const QQ_ID = /^[1-9]\d{4,19}$/

export function parseQqTargetKey(value: string): QqTarget {
  const match = /^(private|group):([1-9]\d{4,19})$/.exec(value)
  if (match === null) {
    throw new QqFormatError('invalid_target', 'invalid QQ target')
  }
  return {
    kind: match[1] as QqTarget['kind'],
    id: match[2],
  }
}

export function targetKey(target: QqTarget): string {
  return `${target.kind}:${target.id}`
}

export function outboxTarget(target: QqTarget): string {
  return `qq:${target.kind}:${target.id}`
}

export function parseOutboxTarget(value: string): QqTarget | null {
  const match = /^qq:(private|group):([1-9]\d{4,19})$/.exec(value)
  return match === null
    ? null
    : {
        kind: match[1] as QqTarget['kind'],
        id: match[2],
      }
}

export function targetAllowed(
  target: QqTarget,
  privateAllow: readonly string[],
  groupAllow: readonly string[],
): boolean {
  if (!QQ_ID.test(target.id)) return false
  return target.kind === 'private'
    ? privateAllow.includes(target.id)
    : groupAllow.includes(target.id)
}

/**
 * 按字符而不是 UTF-16 code unit 拆分，优先在段落、句末和空白处断开。
 * maxParts 不足时明确失败；配置加载器已经保证 4000 字正文可以覆盖。
 */
export function splitQqText(
  text: string,
  maxChars: number,
  maxParts: number,
): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new QqFormatError('invalid_split', 'invalid split length')
  }
  if (!Number.isInteger(maxParts) || maxParts < 1) {
    throw new QqFormatError('invalid_split', 'invalid part limit')
  }
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized === '') {
    throw new QqFormatError('empty_reply', 'reply text is empty')
  }
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return [normalized]

  const parts: string[] = []
  let cursor = 0
  while (cursor < chars.length) {
    if (parts.length >= maxParts) {
      throw new QqFormatError(
        'too_many_parts',
        'reply needs more QQ parts than configured',
      )
    }
    const limit = Math.min(chars.length, cursor + maxChars)
    let cut = limit
    if (limit < chars.length) {
      const preferred = findPreferredCut(chars, cursor, limit)
      if (preferred > cursor) cut = preferred
    }
    const part = chars.slice(cursor, cut).join('').trim()
    if (part !== '') parts.push(part)
    cursor = cut
    while (cursor < chars.length && /\s/.test(chars[cursor] ?? '')) {
      cursor += 1
    }
  }
  if (parts.length > maxParts) {
    throw new QqFormatError(
      'too_many_parts',
      'reply needs more QQ parts than configured',
    )
  }
  return parts
}

function findPreferredCut(
  chars: readonly string[],
  start: number,
  limit: number,
): number {
  const minimum = start + Math.max(1, Math.floor((limit - start) * 0.55))
  for (let index = limit - 1; index >= minimum; index -= 1) {
    if (chars[index] === '\n') return index + 1
  }
  for (let index = limit - 1; index >= minimum; index -= 1) {
    if ('。！？!?；;'.includes(chars[index] ?? '')) return index + 1
  }
  for (let index = limit - 1; index >= minimum; index -= 1) {
    if (/\s/.test(chars[index] ?? '')) return index
  }
  return limit
}
