/**
 * 提醒与长期记忆的确定性边界。
 *
 * 模型可能把“明早提醒我吃药”同时提交成 memoryCandidate 和
 * reminderCandidate。这里不调用第二次模型，只按提醒动作词、时间性动作、
 * 与提醒候选的文本重合度做保守仲裁：
 * - 纯提醒动作不进入长期记忆；
 * - 混合句只保留稳定事实，提醒动作被丢弃；
 * - 明确“记住”的兜底也要经过同一仲裁。
 *
 * 仲裁不替代 candidate.ts 的引用、敏感和第三人门禁；它只决定一条已经
 * 通过门禁的候选是否还应该写入长期记忆。
 */

import type { ParsedMemoryCandidate } from './candidate.ts'

export const MEMORY_ARBITER_REASON_CODES = [
  'memory_retained',
  'memory_suppressed_by_reminder',
  'memory_reminder_action_only',
  'memory_fact_extracted_from_reminder',
  'memory_explicit_reminder_suppressed',
] as const

export type MemoryArbiterReasonCode =
  typeof MEMORY_ARBITER_REASON_CODES[number]

export type MemoryArbiterAction = 'retained' | 'suppressed' | 'extracted'

export interface ReminderBoundaryCandidate {
  text: string
  dueAt?: string
}

export interface MemoryArbitrationItem {
  candidate: ParsedMemoryCandidate
  action: MemoryArbiterAction
  reasonCode: MemoryArbiterReasonCode
}

export interface MemoryArbitrationResult {
  items: MemoryArbitrationItem[]
  suppressedCount: number
  extractedCount: number
}

export interface ExplicitMemoryArbitration {
  text: string | null
  action: Exclude<MemoryArbiterAction, 'retained'> | 'retained'
  reasonCode: MemoryArbiterReasonCode
}

const REMINDER_ACTION =
  /提醒(?:我|一下|你)?|叫我(?:一下)?|通知我|到点|别忘(?:了)?|闹钟|定时|喊我|记得(?:提醒|叫我|通知|吃|喝|带|买|做|去|来|交|发|打|开会|起床|出门|上班|上课|见面)/u

const TIME_MARKER =
  /今天|明天|明早|明晚|今晚|今早|早上|上午|中午|下午|晚上|周[一二三四五六日天]|一小时后|半小时后|到时候/u

const TEMPORAL_ACTION =
  /(?:今天|明天|明早|明晚|今晚|今早|早上|上午|中午|下午|晚上|周[一二三四五六日天]|一小时后|半小时后|到时候)[^，。！？；,!?;\n]{0,16}(?:要|得|该|需要|记得|别忘|提醒|叫我|通知我|吃药|起床|开会|出门|上班|上课|见面|打电话|交|发|买|带|做)/u

const EXPLICIT_PREFIX =
  /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:记住|记一下|记着)(?:这个|这件事|这条|住)?[\s:：,，.。!！-]*/u

export function arbitrateMemoryCandidates(input: {
  candidates: readonly ParsedMemoryCandidate[]
  reminders: readonly ReminderBoundaryCandidate[]
  userText: string
  explicitlyRequested: boolean
}): MemoryArbitrationResult {
  const items: MemoryArbitrationItem[] = []
  let suppressedCount = 0
  let extractedCount = 0

  for (const candidate of input.candidates) {
    const decision = arbitrateText(
      candidate.text,
      `${candidate.quote}\n${input.userText}`,
      input.reminders,
      input.explicitlyRequested,
      false,
    )
    if (decision.action === 'suppressed') {
      suppressedCount += 1
      items.push({
        candidate,
        action: 'suppressed',
        reasonCode: decision.reasonCode,
      })
      continue
    }
    if (decision.text !== null && decision.text !== candidate.text) {
      extractedCount += 1
      items.push({
        candidate: { ...candidate, text: decision.text },
        action: 'extracted',
        reasonCode: decision.reasonCode,
      })
      continue
    }
    items.push({
      candidate,
      action: 'retained',
      reasonCode: 'memory_retained',
    })
  }

  return { items, suppressedCount, extractedCount }
}

export function arbitrateExplicitMemoryText(input: {
  text: string
  reminders: readonly ReminderBoundaryCandidate[]
  userText: string
}): ExplicitMemoryArbitration {
  const decision = arbitrateText(
    input.text,
    `${input.text}\n${input.userText}`,
    input.reminders,
    true,
    true,
  )
  return {
    text: decision.action === 'suppressed' ? null : decision.text,
    action: decision.action,
    reasonCode: decision.reasonCode,
  }
}

function arbitrateText(
  text: string,
  evidenceText: string,
  reminders: readonly ReminderBoundaryCandidate[],
  explicitlyRequested: boolean,
  explicitFallback: boolean,
): {
  text: string | null
  action: MemoryArbiterAction
  reasonCode: MemoryArbiterReasonCode
} {
  const normalizedText = cleanExplicitPrefix(text)
  const relatedToReminder =
    hasReminderSignal(normalizedText) ||
    hasReminderSignal(evidenceText) ||
    reminders.some(reminder => overlaps(normalizedText, reminder.text))
  if (!relatedToReminder) {
    return {
      text: normalizedText,
      action: normalizedText === text ? 'retained' : 'extracted',
      reasonCode: normalizedText === text
        ? 'memory_retained'
        : 'memory_fact_extracted_from_reminder',
    }
  }

  const stableText = extractStableFacts(normalizedText, reminders)
  if (stableText === null) {
    return {
      text: null,
      action: 'suppressed',
      reasonCode:
        explicitFallback || explicitlyRequested
          ? 'memory_explicit_reminder_suppressed'
          : 'memory_reminder_action_only',
    }
  }
  if (stableText === normalizedText) {
    return {
      text: normalizedText,
      action: 'retained',
      reasonCode: 'memory_retained',
    }
  }
  return {
    text: stableText,
    action: 'extracted',
    reasonCode: 'memory_fact_extracted_from_reminder',
  }
}

function hasReminderSignal(text: string): boolean {
  return REMINDER_ACTION.test(text) || TEMPORAL_ACTION.test(text)
}

function extractStableFacts(
  text: string,
  reminders: readonly ReminderBoundaryCandidate[],
): string | null {
  const clauses = text
    .split(/[，,。.!！？?；;\n]+/u)
    .map(clause => cleanExplicitPrefix(clause.trim()))
    .filter(clause => clause !== '')

  const stable: string[] = []
  for (const clause of clauses) {
    if (REMINDER_ACTION.test(clause) || TEMPORAL_ACTION.test(clause)) {
      continue
    }
    if (
      TIME_MARKER.test(clause) &&
      reminders.some(reminder => overlaps(clause, reminder.text))
    ) {
      continue
    }
    if (clause.length < 2) continue
    stable.push(clause)
  }
  return stable.length === 0 ? null : stable.join('，')
}

function cleanExplicitPrefix(text: string): string {
  return text.replace(EXPLICIT_PREFIX, '').trim()
}

function overlaps(left: string, right: string): boolean {
  const a = normalizeForOverlap(left)
  const b = normalizeForOverlap(right)
  if (a.length < 2 || b.length < 2) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const leftPairs = bigrams(a)
  const rightPairs = bigrams(b)
  if (leftPairs.size === 0 || rightPairs.size === 0) return false
  let shared = 0
  for (const pair of leftPairs) {
    if (rightPairs.has(pair)) shared += 1
  }
  return shared / Math.min(leftPairs.size, rightPairs.size) >= 0.55
}

function normalizeForOverlap(text: string): string {
  return text
    .toLowerCase()
    .replace(/kano|主人/gu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(text: string): Set<string> {
  const characters = Array.from(text)
  const result = new Set<string>()
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index]}${characters[index + 1]}`)
  }
  return result
}
