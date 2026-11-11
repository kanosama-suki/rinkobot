/**
 * 主动性模型适配器。
 *
 * 边界：
 * - 模型只产出计划、主动消息和每日整理的候选；
 * - 是否保存、何时发送、是否触发熔断由确定性服务决定；
 * - 内部调用没有用户消息锚点，也不生成 assistant message；
 * - 解析失败显式报错，不把自然语言或半截 JSON 当成成功结果。
 */

import type {
  ChatModel,
  ChatModelResult,
  ChatModelStreamEvent,
} from '../chat/index.ts'
import { ChatModelError } from '../chat/index.ts'
import type { Clock, LifeState } from '../state/index.ts'
import { systemClock } from '../state/index.ts'
import type {
  KanobotStorage,
  ModelCallRecord,
} from '../storage/index.ts'
import {
  InitiativeError,
  type DailyPlanDraft,
  type DailyPlanItemDraft,
  type DailyPlanKind,
  type DailyReviewContext,
  type DailyReviewDraft,
  type DailyReviewFact,
  type DailyReviewMemoryDraft,
  type InitiativeBrain,
  type ProactiveContext,
  type ProactiveDraft,
} from './types.ts'

const PLAN_KINDS: readonly DailyPlanKind[] = [
  'reading',
  'movie',
  'simulation',
  'study',
  'resting',
  'walk',
  'music',
]

const INTERNAL_SYSTEM_PROMPT =
  '你是 Rinkobot 的占位人格，只用于本地工程测试，不是正式人格。' +
  '你正在生成内部候选，不会直接对所有者说话。' +
  '只输出严格 JSON，不要 Markdown、解释或思考过程。' +
  '不要读取、猜测或补造没有出现在上下文里的私人事实。'

const JSON_ENVELOPE_PREFIX = '{"schemaVersion":1,'
const PLAN_PREFILL = `${JSON_ENVELOPE_PREFIX}"items":[`
const PROACTIVE_PREFILL = `${JSON_ENVELOPE_PREFIX}"shouldSend":`
const REVIEW_PREFILL = `${JSON_ENVELOPE_PREFIX}"summary":"`

export interface ModelInitiativeBrainOptions {
  model: ChatModel
  storage: KanobotStorage
  clock?: Clock
  conversationId?: string
  systemPrompt?: string
  dailyModelCallLimit?: number
  maxConcurrentModelCalls?: number
}

/**
 * 真实模型适配器。它把每次内部调用写成 purpose=initiative/daily_review
 * 的审计行，但不会伪造用户消息或 assistant message。
 */
export class ModelInitiativeBrain implements InitiativeBrain {
  private readonly model: ChatModel
  private readonly storage: KanobotStorage
  private readonly clock: Clock
  private readonly conversationId: string
  private readonly systemPrompt: string
  private readonly dailyModelCallLimit: number
  private readonly maxConcurrentModelCalls: number

  constructor(options: ModelInitiativeBrainOptions) {
    this.model = options.model
    this.storage = options.storage
    this.clock = options.clock ?? systemClock
    this.conversationId = options.conversationId ?? 'main'
    this.systemPrompt = options.systemPrompt ?? INTERNAL_SYSTEM_PROMPT
    this.dailyModelCallLimit = options.dailyModelCallLimit ?? 2_000
    this.maxConcurrentModelCalls = options.maxConcurrentModelCalls ?? 2
  }

  async planDay(input: {
    now: string
    timezone: string
    state: LifeState
    maxItems: number
    signal: AbortSignal
  }): Promise<DailyPlanDraft> {
    const raw = await this.run(
      'initiative',
      PLAN_PREFILL,
      [
        '生成一份今天可以自己调整的软性生活计划。',
        '这不是用户已经确认的日程；不要覆盖睡眠、用户明确安排或承诺。',
        `最多 ${input.maxItems} 项，每项只使用一个允许的 kind。`,
        'kind 只能是 reading、movie、simulation、study、resting、walk、music。',
        'durationMinutes 是 15 到 240 的整数。',
        '输出格式：{"schemaVersion":1,"items":[{"kind":"reading","title":"...","durationMinutes":45}]}',
        `当前时间：${input.now}`,
        `时区：${input.timezone}`,
        `当前虚拟状态：${JSON.stringify(input.state)}`,
      ].join('\n'),
      input.signal,
    )
    return parseDailyPlan(raw, input.maxItems)
  }

  async composeProactive(
    input: ProactiveContext,
    signal: AbortSignal,
  ): Promise<ProactiveDraft> {
    const care = input.dueCare.length === 0
      ? '没有到期的后续关心事项。'
      : '这些是到期的后续关心事项；最多自然提起其中一件，并只提一次：\n' +
        input.dueCare
          .map(item => `- [${item.id}] ${item.text}`)
          .join('\n')
    const raw = await this.run(
      'initiative',
      PROACTIVE_PREFILL,
      [
        '判断现在是否值得主动给 kano 发一条消息。没有内容就不发，不要为了保持存在感而发。',
        '不要每轮复述记忆。只有当前话题、到期关心事项或今天的生活里确有自然相关内容时才提。',
        '长时间没回不可以写成“你是不是出事了”“你为什么不理我”。可以轻轻问一句，也可以不提；不得指责、威胁、卖惨或用内疚逼回复。',
        '主动消息遵守与聊天相同的风格：自然、简洁、不出现 AI 自述。',
        'reasonCode 使用一个短小的英文代码，例如 care_follow_up、share_day、morning_greeting、check_in、nothing_to_say。',
        '输出格式：{"schemaVersion":1,"shouldSend":true,"message":"...","reasonCode":"share_day","careItemId":null}',
        care,
        `当前时间：${input.now}`,
        `时区：${input.timezone}`,
        `当前虚拟状态：${JSON.stringify(input.state)}`,
        `今天的软计划：${JSON.stringify(input.plan)}`,
        `最近一次每日摘要：${input.lastDailySummary ?? '无'}`,
        `最近聊天记录：${JSON.stringify(input.recentMessages)}`,
        `最近一次用户消息时间：${input.latestUserMessageAt ?? '无'}`,
        `距用户上次发言（分钟）：${input.silenceMinutes ?? '未知'}`,
        `是否超过配置的长沉默参考线：${input.longSilence ? '是' : '否'}`,
        `连续未回复的主动消息数：${input.consecutiveUnanswered}`,
        `是否处于醒来后的早晨窗口：${input.morningGreeting ? '是' : '否'}`,
        '只有确实在回应某条到期关心事项时，才把其方括号里的 ID 填进 careItemId；否则输出 null。',
      ].join('\n'),
      signal,
    )
    return parseProactive(raw)
  }

  async reviewDay(
    input: DailyReviewContext,
    signal: AbortSignal,
  ): Promise<DailyReviewDraft> {
    const raw = await this.run(
      'daily_review',
      REVIEW_PREFILL,
      [
        '整理这一天的聊天。输出供所有者查看的简短摘要，并挑选真正值得长期保留的候选。',
        '不要把寒暄、临时情绪、一次性安排或每句话都变成长期记忆。',
        '只使用输入消息中真实存在的 messageIds；不能编造来源。',
        '把涉及健康、创伤、证件、账户、住址或第三人隐私的内容标成 sensitive 或 third_party。',
        '普通的一次性小事不要进入 memories；真正重要的关系事件或持续偏好可以进入候选。',
        '输出格式：{"schemaVersion":1,"summary":"...","facts":[{"text":"...","messageIds":["..."]}],"memories":[{"text":"...","kind":"preference","importance":"important","sensitivity":"normal","messageIds":["..."]}]}',
        `本地日期：${input.localDay}`,
        `时区：${input.timezone}`,
        `当天的虚拟状态：${JSON.stringify(input.state)}`,
        `当天消息：${JSON.stringify(input.messages)}`,
      ].join('\n'),
      signal,
    )
    return parseDailyReview(
      raw,
      new Set(input.messages.map(message => message.id)),
    )
  }

  private async run(
    purpose: 'initiative' | 'daily_review',
    responsePrefill: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw abortError()
    if (this.storage.modelCallCountToday() >= this.dailyModelCallLimit) {
      throw new InitiativeError(
        'initiative_daily_model_limit',
        'daily model call limit has been reached',
      )
    }
    if (
      this.storage.runningModelCallCount() >= this.maxConcurrentModelCalls
    ) {
      throw new InitiativeError(
        'initiative_model_capacity_reached',
        'model concurrency limit has been reached',
      )
    }
    const startedAt = this.clock.now().toISOString()
    const call = this.storage.beginModelCall({
      conversationId: this.conversationId,
      purpose,
      provider: this.model.provider,
      model: this.model.id,
      startedAt,
    })
    let result: ChatModelResult | null = null
    let text = ''
    try {
      for await (const event of this.model.stream({
        systemPrompt: this.systemPrompt,
        messages: [{ role: 'user', text: prompt }],
        jsonMode: this.model.capabilities?.jsonMode !== false,
        responsePrefill: this.model.capabilities?.responsePrefill === false
          ? undefined
          : responsePrefill,
        signal,
      })) {
        if (event.type === 'text') {
          text += event.text
        } else {
          result = event.result
        }
      }
      if (result === null) {
        throw new InitiativeError(
          'initiative_model_protocol_error',
          'internal model stream ended without result metadata',
        )
      }
      this.finishSucceeded(call, result)
      return text
    } catch (error) {
      this.finishFailed(call, error)
      throw normalizeBrainFailure(error)
    }
  }

  private finishSucceeded(
    call: ModelCallRecord,
    result: ChatModelResult,
  ): void {
    this.storage.finishModelCall(call.id, {
      status: 'succeeded',
      completedAt: this.clock.now().toISOString(),
      assistantMessageId: null,
      attempts: result.attempts,
      usage: result.usage,
      estimatedCost: result.estimatedCost,
      pricing: result.pricing,
      responseId: result.responseId,
    })
  }

  private finishFailed(call: ModelCallRecord, error: unknown): void {
    try {
      this.storage.finishModelCall(call.id, {
        status: isAbortError(error) ? 'aborted' : 'failed',
        completedAt: this.clock.now().toISOString(),
        assistantMessageId: null,
        attempts: attemptsFrom(error),
        errorCode: errorCodeFrom(error),
      })
    } catch {
      // 原始模型/解析错误更重要；不能因为审计收尾失败把成功正文伪装成成功。
    }
  }
}

/**
 * mock 模式下的确定性占位实现。
 *
 * 它让开发页面仍能展示计划和摘要；不会假装接了真实模型，也不会在普通
 * tick 中频繁主动说话。到期关心事项仍会生成一条明确的占位草稿。
 */
export class MockInitiativeBrain implements InitiativeBrain {
  async planDay(input: {
    maxItems: number
  }): Promise<DailyPlanDraft> {
    const items: DailyPlanItemDraft[] = [
      {
        kind: 'reading',
        title: '读一会儿虚构的短篇',
        durationMinutes: 45,
      },
      {
        kind: 'resting',
        title: '留一点安静休息的时间',
        durationMinutes: 30,
      },
    ]
    return {
      schemaVersion: 1,
      items: items.slice(0, input.maxItems),
    }
  }

  async composeProactive(
    input: ProactiveContext,
  ): Promise<ProactiveDraft> {
    const care = input.dueCare[0]
    if (care !== undefined) {
      return {
        schemaVersion: 1,
        shouldSend: true,
        message: '之前那件事，今天感觉怎么样了？',
        reasonCode: 'care_follow_up',
        careItemId: care.id,
      }
    }
    if (input.morningGreeting) {
      return {
        schemaVersion: 1,
        shouldSend: true,
        message: '早上好，今天也慢慢来。',
        reasonCode: 'morning_greeting',
        careItemId: null,
      }
    }
    return {
      schemaVersion: 1,
      shouldSend: false,
      message: '',
      reasonCode: 'nothing_to_say',
      careItemId: null,
    }
  }

  async reviewDay(
    input: DailyReviewContext,
  ): Promise<DailyReviewDraft> {
    return {
      schemaVersion: 1,
      summary:
        input.messages.length === 0
          ? '今天没有留下聊天记录。'
          : `今天有 ${input.messages.length} 条占位聊天记录；这是 mock 摘要。`,
      facts: [],
      memories: [],
    }
  }
}

function parseDailyPlan(raw: string, maxItems: number): DailyPlanDraft {
  const root = parseObject(raw)
  if (root.schemaVersion !== 1 || !Array.isArray(root.items)) {
    throw invalidOutput('daily plan shape is invalid')
  }
  const items: DailyPlanItemDraft[] = []
  for (const value of root.items.slice(0, maxItems)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const item = value as Record<string, unknown>
    if (
      typeof item.kind !== 'string' ||
      !PLAN_KINDS.includes(item.kind as DailyPlanKind) ||
      typeof item.title !== 'string' ||
      typeof item.durationMinutes !== 'number' ||
      !Number.isInteger(item.durationMinutes) ||
      item.durationMinutes < 15 ||
      item.durationMinutes > 240
    ) {
      continue
    }
    const title = cleanText(item.title, 160)
    if (title === null) continue
    items.push({
      kind: item.kind as DailyPlanKind,
      title,
      durationMinutes: item.durationMinutes,
    })
  }
  return { schemaVersion: 1, items }
}

function parseProactive(raw: string): ProactiveDraft {
  const root = parseObject(raw)
  if (
    root.schemaVersion !== 1 ||
    typeof root.shouldSend !== 'boolean' ||
    typeof root.message !== 'string' ||
    typeof root.reasonCode !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(root.reasonCode) ||
    (root.careItemId !== undefined &&
      root.careItemId !== null &&
      (typeof root.careItemId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(root.careItemId)))
  ) {
    throw invalidOutput('proactive draft shape is invalid')
  }
  const message = root.message.trim()
  if (root.shouldSend) {
    if (
      message === '' ||
      Array.from(message).length > 1_000 ||
      message.includes('\0')
    ) {
      throw invalidOutput('proactive message is empty or too long')
    }
  }
  return {
    schemaVersion: 1,
    shouldSend: root.shouldSend,
    message: root.shouldSend ? message : '',
    reasonCode: root.reasonCode,
    careItemId:
      root.shouldSend && typeof root.careItemId === 'string'
        ? root.careItemId
        : null,
  }
}

function parseDailyReview(
  raw: string,
  allowedMessageIds: ReadonlySet<string>,
): DailyReviewDraft {
  const root = parseObject(raw)
  if (
    root.schemaVersion !== 1 ||
    typeof root.summary !== 'string' ||
    !Array.isArray(root.facts) ||
    !Array.isArray(root.memories)
  ) {
    throw invalidOutput('daily review shape is invalid')
  }
  const summary = cleanText(root.summary, 4_000)
  if (summary === null) {
    throw invalidOutput('daily review summary is empty or too long')
  }
  const facts: DailyReviewFact[] = []
  for (const value of root.facts.slice(0, 20)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const fact = value as Record<string, unknown>
    const text = typeof fact.text === 'string'
      ? cleanText(fact.text, 500)
      : null
    const ids = validMessageIds(fact.messageIds, allowedMessageIds)
    if (text !== null && ids.length > 0) {
      facts.push({ text, messageIds: ids })
    }
  }
  const memories: DailyReviewMemoryDraft[] = []
  for (const value of root.memories.slice(0, 8)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const memory = value as Record<string, unknown>
    const text = typeof memory.text === 'string'
      ? cleanText(memory.text, 500)
      : null
    const ids = validMessageIds(memory.messageIds, allowedMessageIds)
    if (
      text === null ||
      ids.length === 0 ||
      typeof memory.kind !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(memory.kind) ||
      (memory.importance !== 'normal' &&
        memory.importance !== 'important' &&
        memory.importance !== 'permanent') ||
      (memory.sensitivity !== 'normal' &&
        memory.sensitivity !== 'sensitive' &&
        memory.sensitivity !== 'third_party')
    ) {
      continue
    }
    memories.push({
      text,
      kind: memory.kind,
      importance: memory.importance,
      sensitivity: memory.sensitivity,
      messageIds: ids,
    })
  }
  return {
    schemaVersion: 1,
    summary,
    facts,
    memories,
  }
}

function parseObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(withoutFence) as unknown
  } catch {
    const first = withoutFence.indexOf('{')
    const last = withoutFence.lastIndexOf('}')
    if (first < 0 || last <= first) {
      throw invalidOutput('internal model did not return valid JSON')
    }
    try {
      parsed = JSON.parse(withoutFence.slice(first, last + 1)) as unknown
    } catch {
      throw invalidOutput('internal model did not return valid JSON')
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidOutput('internal model JSON root must be an object')
  }
  return parsed as Record<string, unknown>
}

function cleanText(value: string, maxChars: number): string | null {
  const text = value.trim()
  const length = Array.from(text).length
  if (length === 0 || length > maxChars || text.includes('\0')) return null
  return text
}

function validMessageIds(
  value: unknown,
  allowed: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) return []
  const ids = [...new Set(
    value.filter(
      (item): item is string =>
        typeof item === 'string' && allowed.has(item),
    ),
  )]
  return ids.slice(0, 100)
}

function invalidOutput(message: string): InitiativeError {
  return new InitiativeError('initiative_model_output_invalid', message)
}

function normalizeBrainFailure(error: unknown): Error {
  if (error instanceof InitiativeError) return error
  if (error instanceof Error && error.name === 'AbortError') return error
  if (error instanceof ChatModelError) {
    return new InitiativeError(error.code, error.message)
  }
  return new InitiativeError(
    'initiative_model_failed',
    error instanceof Error ? error.message : String(error),
  )
}

function attemptsFrom(error: unknown): number {
  if (error instanceof ChatModelError) return error.attempts
  if (isAbortError(error)) return 0
  return 1
}

function errorCodeFrom(error: unknown): string {
  if (isAbortError(error)) return 'aborted'
  if (error instanceof ChatModelError) {
    return /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code)
      ? error.code
      : 'initiative_model_failed'
  }
  if (error instanceof InitiativeError) {
    return /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code)
      ? error.code
      : 'initiative_model_failed'
  }
  return 'initiative_model_failed'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(): Error {
  const error = new Error('initiative model call aborted')
  error.name = 'AbortError'
  return error
}
