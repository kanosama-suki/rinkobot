/**
 * 模型提交的单条记忆候选门禁。
 *
 * 聊天信封和旧版独立抽取器曾各自解析候选；现在只保留这一份规则，
 * 统一处理原话引用、来源降级、敏感内容、第三人内容和置信度上限。
 * 这里不写数据库，也不调用模型。
 */

import type {
  Importance,
  MemorySource,
  Sensitivity,
} from '../state/index.ts'

const MAX_TEXT_CHARS = 300
const MAX_QUOTE_CHARS = 4_000

const SENSITIVE_PATTERNS = [
  /密码|口令|私钥|身份证|护照号|银行卡|信用卡|手机号|住址|病历|诊断|处方|遗书|自杀|自残/i,
]
const THIRD_PARTY_PATTERNS = [
  /朋友|同事|同学|室友|家人|妈妈|爸爸|父母|哥哥|姐姐|弟弟|妹妹|孩子|伴侣/i,
]

export interface ParsedMemoryCandidate {
  text: string
  quote: string
  kind: string
  source: MemorySource
  sensitivity: Sensitivity
  importance: Importance
  confidence: number
}

/**
 * 校验一条模型候选。未知字段、找不到的引用和非法枚举都直接拒绝，
 * 不尝试猜测或修正模型的意图。
 */
export function parseMemoryCandidate(
  value: unknown,
  userText: string,
  assistantText: string,
): ParsedMemoryCandidate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const allowed = [
    'text',
    'quote',
    'kind',
    'source',
    'sensitivity',
    'importance',
    'confidence',
  ]
  if (Object.keys(record).some(key => !allowed.includes(key))) return null

  const text = cleanText(record.text, MAX_TEXT_CHARS)
  const quote = cleanText(record.quote, MAX_QUOTE_CHARS)
  if (text === null || quote === null) return null
  if (!userText.includes(quote) && !assistantText.includes(quote)) return null

  const kind = typeof record.kind === 'string' &&
    /^[a-z][a-z0-9_.-]{0,63}$/.test(record.kind)
    ? record.kind
    : null
  if (kind === null) return null

  const claimedSource = record.source
  if (claimedSource !== 'user_stated' && claimedSource !== 'rinko_inferred') {
    return null
  }
  const source: MemorySource =
    claimedSource === 'user_stated' && userText.includes(quote)
      ? 'user_stated'
      : 'rinko_inferred'

  const claimedSensitivity = record.sensitivity
  if (
    claimedSensitivity !== 'normal' &&
    claimedSensitivity !== 'sensitive' &&
    claimedSensitivity !== 'third_party'
  ) {
    return null
  }
  const sensitivity = guardSensitivity(
    `${text}\n${quote}`,
    claimedSensitivity,
  )

  const importance = record.importance
  if (
    importance !== 'normal' &&
    importance !== 'important' &&
    importance !== 'permanent'
  ) {
    return null
  }
  const confidence = record.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null
  }

  return {
    text,
    quote,
    kind,
    source,
    sensitivity,
    importance,
    // 推断来源的置信度不能因为模型自报而高于用户陈述。
    confidence: source === 'rinko_inferred'
      ? Math.min(confidence, 0.8)
      : confidence,
  }
}

function guardSensitivity(
  text: string,
  claimed: Sensitivity,
): Sensitivity {
  if (claimed === 'sensitive') return 'sensitive'
  if (SENSITIVE_PATTERNS.some(pattern => pattern.test(text))) {
    return 'sensitive'
  }
  if (claimed === 'third_party') return 'third_party'
  if (THIRD_PARTY_PATTERNS.some(pattern => pattern.test(text))) {
    return 'third_party'
  }
  return 'normal'
}

function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const length = Array.from(text).length
  if (length === 0 || length > maxChars) return null
  return text
}
