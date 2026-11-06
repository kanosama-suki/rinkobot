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
const STOPWORDS = new Set([
  '我', '你', '您', '他', '她', '它', '我们', '你们', '他们',
  '的', '了', '着', '过', '是', '在', '有', '和', '与', '也', '就',
  '都', '很', '太', '不', '没', '没有', '吗', '呢', '吧', '啊', '呀',
  '哦', '嗯', '这', '那', '这个', '那个', '什么', '怎么', '为什么',
  '一个', '一下', '一些', '今天', '明天', '昨天', '现在', '然后',
  '但是', '因为', '所以', '如果', '可以', '能', '会', '要', '想',
  '说', '给', '对', '把', '被', '让', '从', '到',
])

export type MemorySearchMode = 'all' | 'any'

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

export function buildMemorySearchMatch(
  query: string,
  mode: MemorySearchMode = 'all',
): string | null {
  const wordTokens = listMemorySearchTokens(query)
  if (wordTokens.length === 0) return null

  // 宽松召回时把中文词拆成单字，解决 Segmenter 把“想喝”整体成词、
  // 而记忆里只存了“喝”时完全匹配不上的问题。精确模式不拆，避免过宽。
  const seen = new Set(wordTokens.map(token => token.toLowerCase()))
  const tokens = [...wordTokens]
  if (mode === 'any') {
    for (const token of wordTokens) {
      if (!/^[\p{Script=Han}]+$/u.test(token)) continue
      for (const char of Array.from(token)) {
        const key = char.toLowerCase()
        if (STOPWORDS.has(key) || seen.has(key)) continue
        seen.add(key)
        tokens.push(char)
        if (tokens.length >= MAX_SEARCH_TOKENS) break
      }
      if (tokens.length >= MAX_SEARCH_TOKENS) break
    }
  }

  return tokens
    .map(token => {
      const quoted = `"${token.replace(/"/g, '""')}"`
      return `(word_text:${quoted} OR char_text:${quoted})`
    })
    .join(mode === 'any' ? ' OR ' : ' AND ')
}

/**
 * 返回与 FTS 查询一致的有界词元，供记忆召回的相关性判断复用。
 * 这里只做切词和停用词过滤，不把用户原文拼进 FTS 语法。
 */
export function listMemorySearchTokens(query: string): string[] {
  if (typeof query !== 'string') {
    throw new TypeError('memory search query must be text')
  }
  const trimmed = query.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SEARCH_QUERY_CHARS) {
    throw new RangeError(
      `memory search query must be 1..${MAX_SEARCH_QUERY_CHARS} characters`,
    )
  }

  const wordTokens: string[] = []
  const seen = new Set<string>()
  for (const part of WORD_SEGMENTER.segment(trimmed)) {
    if (!part.isWordLike) continue
    const token = part.segment.trim()
    const key = token.toLowerCase()
    if (token === '' || STOPWORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    wordTokens.push(token)
    if (wordTokens.length >= MAX_SEARCH_TOKENS) break
  }
  return wordTokens
}
