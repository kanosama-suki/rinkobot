/**
 * 提醒意图和确认轮的确定性规则。
 *
 * 这里不调用模型，只回答三件事：当前用户话里有没有明确委托；是否只是
 * 模糊委托；下一句是不是在确认/拒绝最近一条提醒。文本比较刻意保守，
 * 宁可要求用户指定，也不把“洗澡”和“喝水”误合并。
 */

export type ReminderIntent = 'explicit' | 'ambiguous' | 'none'
export type ReminderReplyIntent = 'confirm' | 'reject'

const EXPLICIT_MARKER =
  /(提醒|叫我|通知我|别忘了|别忘记|记得要|记得提醒)/
const VAGUE_TIME =
  /(晚点|待会|等会|一会儿|回头|之后|有空|到时候)/
const CONCRETE_TIME =
  /(\d{1,2}\s*[:：]\s*\d{1,2}|\d{1,2}\s*[点时]|[零〇一二两三四五六七八九十百]{1,3}\s*[点时]|半\s*(?:个)?小时|\d+\s*(?:个)?(?:小时|分钟)|[零〇一二两三四五六七八九十百]+\s*(?:个)?(?:小时|分钟)|明天|明早|明晚|今晚|今天|早上|上午|中午|下午|晚上|凌晨|半夜|周[一二三四五六日天]|星期)/
const TRAILING_FILLERS = /[喵呀啊吧呢哦嘛啦哈]+$/g

/**
 * 只有“明确提醒动作 + 可辨识事项”才允许直接生效。模棱两可的时间词
 * 仍进入候选，让用户在聊天里自然确认。没有委托词的内容一律不建提醒。
 */
export function classifyReminderIntent(userText: string): ReminderIntent {
  const normalized = normalizeInput(userText)
  if (!EXPLICIT_MARKER.test(normalized)) return 'none'

  const action = normalizeReminderText(normalized)
  if (action.length < 2) return 'ambiguous'
  if (!CONCRETE_TIME.test(normalized) || VAGUE_TIME.test(normalized)) {
    return 'ambiguous'
  }
  return 'explicit'
}

export function reminderReplyIntent(
  userText: string,
): ReminderReplyIntent | null {
  const normalized = normalizeInput(userText)
    .replace(/[，,。.!！?？、；;：:\s]/g, '')
    .replace(TRAILING_FILLERS, '')
  if (
    normalized === '可以' ||
    normalized === '好' ||
    normalized === '好的' ||
    normalized === '行' ||
    normalized === '嗯' ||
    normalized === '确认' ||
    normalized === '就这样' ||
    normalized === '没问题' ||
    normalized === '是的' ||
    normalized === '对'
  ) {
    return 'confirm'
  }
  if (
    normalized === '不要' ||
    normalized === '不用' ||
    normalized === '不用了' ||
    normalized === '不要了' ||
    normalized === '取消' ||
    normalized === '取消吧' ||
    normalized === '算了' ||
    normalized === '别' ||
    normalized === '别了' ||
    normalized === '不需要'
  ) {
    return 'reject'
  }
  return null
}

/**
 * 用于“相近文本”判断。只删除委托、时间和代词等外壳，真正动作保留；
 * 因此“洗澡”和“喝水”不会相等。
 */
export function normalizeReminderText(value: string): string {
  return normalizeInput(value)
    .replace(
      /(明天|明早|明晚|今晚|今天|早上|上午|中午|下午|晚上|凌晨|半夜|待会|晚点|等会|一会儿|之后|有空|到时候)/g,
      '',
    )
    .replace(/\d{1,2}\s*[:：]\s*\d{1,2}/g, '')
    .replace(
      /[零〇一二两三四五六七八九十百]{1,3}\s*[点时](?:半|(?:[零〇一二两三四五六七八九十]{1,3})\s*分?)?/g,
      '',
    )
    .replace(/\d{1,2}\s*[点时](?:半|\d{1,2}\s*分?)?/g, '')
    .replace(
      /(?:\d+|[零〇一二两三四五六七八九十百]+)\s*(?:个)?(?:小时|分钟)(?:后|以后)?/g,
      '',
    )
    .replace(
      /(提醒我|提醒一下|提醒|叫我|通知我|告诉我|别忘了|别忘记|记得要|记得|请|麻烦)/g,
      '',
    )
    .replace(/(kano|你|我)/g, '')
    .replace(/[，,。.!！?？、；;：:\s"'“”‘’（）()【】[\]]/g, '')
}

export function reminderTextsEquivalent(
  left: string,
  right: string,
): boolean {
  const a = normalizeReminderText(left)
  const b = normalizeReminderText(right)
  return a.length >= 2 && a === b
}

export function reminderTimesClose(
  left: string,
  right: string,
  windowMs = 2 * 60_000,
): boolean {
  const a = Date.parse(left)
  const b = Date.parse(right)
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= windowMs
  )
}

function normalizeInput(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}
