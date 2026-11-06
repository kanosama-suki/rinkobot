/**
 * 显式“记住这个”的确定性识别。
 *
 * 模型可以决定记忆的措辞和重要度，但不能因为漏输出候选就静默丢掉
 * 所有者的明确指令。这里只提取很短、很直接的记忆内容；复杂或过长
 * 的表达仍交给模型候选，不用不可靠的自然语言解析硬猜。
 */

const MAX_EXPLICIT_MEMORY_CHARS = 300

const PREFIX_PATTERN =
  /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:记住|记一下|记着)(?:这个|这件事|这条|住)?[\s:：,，.。!！-]*(.+)$/su
const SUFFIX_PATTERN =
  /^(.+?)[\s,，.。!！]*(?:请)?(?:你)?(?:帮我)?(?:记住|记一下|记着)(?:这个|这件事|这条|住)?[\s.。!！]*$/su

export function hasExplicitRememberInstruction(text: string): boolean {
  return /(?:记住|记一下|记着)/u.test(text)
}

export function extractExplicitMemoryText(text: string): string | null {
  const trimmed = text.trim()
  if (!hasExplicitRememberInstruction(trimmed)) return null

  const match = PREFIX_PATTERN.exec(trimmed) ?? SUFFIX_PATTERN.exec(trimmed)
  const content = match?.[1]?.trim() ?? ''
  const length = Array.from(content).length
  if (length < 2 || length > MAX_EXPLICIT_MEMORY_CHARS) return null
  if (/^(?:这个|这件事|这条|住)$/u.test(content)) return null
  return content
}
