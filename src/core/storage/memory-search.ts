/**
 * 记忆全文检索的分词和 FTS5 查询构造。
 *
 * 中文只用默认分词会漏掉单字短词，因此每条记忆同时索引：
 * - word_text：Intl.Segmenter 切出的词；
 * - char_text：逐字的字母/数字，用于“茶”这类单字查询。
 *
 * 查询只拼接经过 Segmenter 提取并转义的 token，不把用户原文直接交给
 * FTS5 查询语法。多个 token 用 AND，避免“的/不”等常用字把无关记忆
 * 也召回；char_text 仍然保证单字查询可用。
 */

const WORD_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const MAX_SEARCH_QUERY_CHARS = 500
const MAX_SEARCH_TOKENS = 20

export interface MemorySearchColumns {
  wordText: string
  charText: string
}

export function buildMemorySearchColumns(text: string): MemorySearchColumns {
  const words: string[] = []
  for (const part of WORD_SEGMENTER.segment(text)) {
    if (part.isWordLike) words.push(part.segment)
  }
  const chars = Array.from(text).filter(char => /[\p{L}\p{N}]/u.test(char))
  return {
    wordText: words.join(' '),
    charText: chars.join(' '),
  }
}

export function buildMemorySearchMatch(query: string): string | null {
  if (typeof query !== 'string') {
    throw new TypeError('memory search query must be text')
  }
  const trimmed = query.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SEARCH_QUERY_CHARS) {
    throw new RangeError(
      `memory search query must be 1..${MAX_SEARCH_QUERY_CHARS} characters`,
    )
  }

  const tokens: string[] = []
  const seen = new Set<string>()
  for (const part of WORD_SEGMENTER.segment(trimmed)) {
    if (!part.isWordLike) continue
    const token = part.segment.trim()
    const key = token.toLowerCase()
    if (token === '' || seen.has(key)) continue
    seen.add(key)
    tokens.push(token)
    if (tokens.length >= MAX_SEARCH_TOKENS) break
  }
  if (tokens.length === 0) return null

  return tokens
    .map(token => {
      const quoted = `"${token.replace(/"/g, '""')}"`
      return `(word_text:${quoted} OR char_text:${quoted})`
    })
    .join(' AND ')
}
