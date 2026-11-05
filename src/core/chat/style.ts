/**
 * 回复风格的确定性检查。
 *
 * 这里不调用模型、不读取人格文件，只对已经生成的文本执行规划书第 5 节的
 * 硬规则。检查结果只携带违规代码和短说明，不把回复正文复制进审计表。
 */

export type StyleViolationCode =
  | 'banned_phrase'
  | 'short_too_many_lines'
  | 'long_too_many_exclamations'
  | 'long_www'
  | 'long_missing_short_sentence'
  | 'serious_uses_master'

export interface StyleViolation {
  code: StyleViolationCode
  message: string
}

export interface StyleCheckResult {
  ok: boolean
  violations: StyleViolation[]
}

export interface StyleCheckOptions {
  // 认真长谈由调用方明确传入，避免把普通玩笑里的称呼误判成越界。
  serious?: boolean
}

const SHORT_MESSAGE_MAX_CHARS = 120
const LONG_MESSAGE_MIN_CHARS = 200
const BANNED_PHRASES = [
  '作为一个人工智能',
  '作为AI',
  '作为 AI',
  '你应该',
] as const

export function checkReplyStyle(
  text: string,
  options: StyleCheckOptions = {},
): StyleCheckResult {
  if (typeof text !== 'string') {
    throw new TypeError('reply text must be a string')
  }
  const violations: StyleViolation[] = []
  const normalized = text.trim()
  const length = Array.from(normalized).length
  const lines = normalized.split('\n').filter(line => line.trim() !== '')

  if (BANNED_PHRASES.some(phrase => normalized.includes(phrase))) {
    violations.push({
      code: 'banned_phrase',
      message: '出现了不舒服的 AI 自我说明或说教词',
    })
  }

  if (length <= SHORT_MESSAGE_MAX_CHARS && lines.length > 3) {
    violations.push({
      code: 'short_too_many_lines',
      message: '短回复超过 3 行',
    })
  }

  if (length > LONG_MESSAGE_MIN_CHARS) {
    const exclamations = (normalized.match(/[!！]/g) ?? []).length
    if (exclamations > 1) {
      violations.push({
        code: 'long_too_many_exclamations',
        message: '长回复的感叹号超过 1 个',
      })
    }
    if (/www/i.test(normalized)) {
      violations.push({
        code: 'long_www',
        message: '长回复里出现了 www',
      })
    }
    if (!hasShortSentenceInEveryParagraph(normalized)) {
      violations.push({
        code: 'long_missing_short_sentence',
        message: '长回复里有段落缺少 4～8 字的短句',
      })
    }
  }

  if (options.serious === true && normalized.includes('主人')) {
    violations.push({
      code: 'serious_uses_master',
      message: '认真长谈时不应使用“主人”',
    })
  }

  return {
    ok: violations.length === 0,
    violations,
  }
}

/**
 * 段落可以按空行或单换行拆分；每段至少需要一句 4～8 字的中文短句。
 * 这是启发式规则，不声称能覆盖所有标点或语言风格。
 */
function hasShortSentenceInEveryParagraph(text: string): boolean {
  const paragraphs = text
    .split(/\n\s*\n|\n/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '')
  if (paragraphs.length === 0) return false
  return paragraphs.every(paragraph => {
    const sentences = paragraph
      .split(/[。！？!?…]+/)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence !== '')
    return sentences.some(sentence => {
      const length = Array.from(sentence).length
      return length >= 4 && length <= 8
    })
  })
}
