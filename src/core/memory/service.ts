/**
 * 长期记忆的写入、纠正、候选转正和检索服务。
 *
 * 边界：
 * - 用户明确要求记住、或重要度高于 normal 的不敏感陈述立即 active；
 * - 普通寒暄和一次性小事只进入 candidate，不会仅因来自用户就永久化；
 * - 推断、外部内容、敏感内容和第三人内容只能先成为 candidate；
 * - 纠正通过 replaceMemory 原子替换旧记录，旧记录保留证据但不可检索；
 * - 正文仍只存在 bodies，FTS 只为 active 记忆维护索引。
 */

import { randomUUID } from 'node:crypto'

import {
  normalizeMemoryText,
  type KanobotStorage,
  type MemorySearchResult,
} from '../storage/index.ts'
import {
  systemClock,
  type Clock,
  type Importance,
  type MemoryRecord,
  type MemorySource,
  type Sensitivity,
} from '../state/index.ts'
import {
  MemoryInputError,
  type CorrectMemoryInput,
  type MemoryRecallOptions,
  type MemorySearchOptions,
  type MemoryView,
  type OwnerMemoryInput,
  type RememberMemoryInput,
} from './types.ts'
import {
  analyzeMemoryQuery,
  compareMemoryRecallResults,
  scoreMemoryRelevance,
  type MemoryRecallResult,
} from './recall.ts'

const MEMORY_SOURCES: readonly MemorySource[] = [
  'user_stated',
  'rinko_inferred',
  'external',
]
const SENSITIVITIES: readonly Sensitivity[] = [
  'normal',
  'sensitive',
  'third_party',
]
const IMPORTANCES: readonly Importance[] = [
  'normal',
  'important',
  'permanent',
]
const DEFAULT_CONFIDENCE: Record<MemorySource, number> = {
  user_stated: 1,
  rinko_inferred: 0.6,
  external: 0.5,
}

export interface MemoryRecallSettings {
  minRelevance: number
  candidateLimit: number
}

export interface MemoryServiceOptions {
  recall?: Partial<MemoryRecallSettings>
}

export const DEFAULT_MEMORY_RECALL_SETTINGS: MemoryRecallSettings = {
  // 两个主题词至少命中一个；单词查询必须命中该词。
  minRelevance: 0.5,
  // FTS 先多取一些候选，再在内存里按问题意图过滤和排序。
  candidateLimit: 24,
}

export class KanobotMemoryService {
  private readonly storage: KanobotStorage
  private readonly clock: Clock
  private readonly recallSettings: MemoryRecallSettings

  constructor(
    storage: KanobotStorage,
    clock: Clock = systemClock,
    options: MemoryServiceOptions = {},
  ) {
    this.storage = storage
    this.clock = clock
    this.recallSettings = validateRecallSettings({
      ...DEFAULT_MEMORY_RECALL_SETTINGS,
      ...options.recall,
    })
  }

  remember(input: RememberMemoryInput): MemoryRecord {
    const source = requireMemorySource(input.source)
    const sensitivity = input.sensitivity === undefined
      ? 'normal'
      : requireSensitivity(input.sensitivity)
    const requestedImportance = input.importance === undefined
      ? 'normal'
      : requireImportance(input.importance)
    const explicitlyRequested = input.explicitlyRequested === true
    // “记住这个”是明确指令。模型即使只给 normal，也不能把它当普通寒暄；
    // 但敏感和第三人内容仍只能进候选，不能绕过隐私门禁。
    const importance = explicitlyRequested && requestedImportance === 'normal'
      ? 'important'
      : requestedImportance
    const confidence = input.confidence ?? DEFAULT_CONFIDENCE[source]
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new MemoryInputError(
        'invalid_confidence',
        'memory confidence must be a number between 0 and 1',
      )
    }

    const record = this.prepareRecord({
      text: input.text,
      quoteText: input.quoteText,
      kind: input.kind,
      source,
      confidence,
      sensitivity,
      importance,
      status:
        source === 'user_stated' &&
        sensitivity === 'normal' &&
        (explicitlyRequested || importance !== 'normal')
          ? 'active'
          : 'candidate',
      id: input.id,
      createdAt: input.createdAt,
    })
    return this.storage.putMemory(record)
  }

  /**
   * 所有者纠正属于明确陈述，因此新记录直接 active，并原子替代旧记录。
   * 所有者纠正是显式确认；敏感/第三人内容也可以直接 active。
   */
  correct(previousId: string, input: CorrectMemoryInput): MemoryRecord {
    const sensitivity = input.sensitivity === undefined
      ? 'normal'
      : requireSensitivity(input.sensitivity)
    const record = this.prepareRecord({
      text: input.text,
      quoteText: input.quoteText,
      kind: input.kind,
      source: 'user_stated',
      confidence: 1,
      sensitivity,
      importance: input.importance ?? 'important',
      status: 'active',
      id: input.id,
      createdAt: input.createdAt,
    })
    return this.storage.replaceMemory(previousId, record)
  }

  /**
   * 所有者在面板里直接添加等同于“已确认”，因此敏感内容也可以直接
   * active；模型抽取路径不能调用这个方法。
   */
  addByOwner(input: OwnerMemoryInput): MemoryRecord {
    const sensitivity = input.sensitivity === undefined
      ? 'normal'
      : requireSensitivity(input.sensitivity)
    const importance = input.importance === undefined
      ? 'normal'
      : requireImportance(input.importance)
    const record = this.prepareRecord({
      text: input.text,
      quoteText: input.quoteText,
      kind: input.kind,
      source: 'user_stated',
      confidence: 1,
      sensitivity,
      importance,
      status: 'active',
      id: input.id,
      createdAt: input.createdAt,
    })
    return this.storage.putMemory(record)
  }

  promote(id: string): MemoryRecord {
    return this.storage.promoteMemory(id)
  }

  trash(id: string): MemoryRecord {
    return this.storage.trashMemory(id, this.clock.now().toISOString())
  }

  restore(id: string): MemoryRecord {
    return this.storage.restoreMemory(id, this.clock.now().toISOString())
  }

  purge(id: string): void {
    this.storage.purgeMemory(id, this.clock.now().toISOString())
  }

  search(
    query: string,
    options: MemorySearchOptions = {},
  ): MemorySearchResult[] {
    return this.storage.searchMemories(query, {
      limit: options.limit ?? 5,
      markRecalled: options.markRecalled ?? true,
      matchMode: options.matchMode ?? 'all',
    })
  }

  /**
   * 聊天上下文召回优先保证精确，再补一次宽松召回。
   * 宽松模式只在精确结果不足时使用，避免常用字召回的记忆塞满提示词。
   */
  recall(
    query: string,
    limit = 5,
    options: MemoryRecallOptions = {},
  ): MemoryRecallResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new MemoryInputError(
        'invalid_limit',
        'memory recall limit must be an integer between 1 and 10',
      )
    }
    const bounded = Array.from(query).slice(0, 500).join('')
    const plan = analyzeMemoryQuery(bounded)
    if (plan.topics.length === 0) return []

    const candidateLimit = Math.max(
      limit,
      Math.min(50, this.recallSettings.candidateLimit),
    )
    const precise = this.storage.searchMemories(bounded, {
      limit: candidateLimit,
      markRecalled: false,
      matchMode: 'all',
    })
    // 精确查询可能只命中“喜欢”这类常见词，真正相关的记忆反而需要宽松
    // 查询补回。因此两次查询都取有界候选，再统一按主题覆盖率过滤。
    const broad = this.storage.searchMemories(bounded, {
      limit: candidateLimit,
      markRecalled: false,
      matchMode: 'any',
    })

    const merged: MemoryRecallResult[] = []
    const seen = new Set<string>()
    for (const result of [...precise, ...broad]) {
      if (seen.has(result.memory.id)) continue
      seen.add(result.memory.id)
      const relevance = scoreMemoryRelevance(plan, result)
      if (
        relevance.rejectedReason !== null ||
        relevance.score < this.recallSettings.minRelevance
      ) {
        continue
      }
      merged.push({
        ...result,
        relevance: relevance.score,
        matchedTopics: relevance.matchedTopics,
      })
    }
    merged.sort(compareMemoryRecallResults)
    const admitted = merged.slice(0, limit)
    if (admitted.length > 0 && (options.markRecalled ?? true)) {
      this.storage.markMemoriesRecalled(
        admitted.map(result => result.memory.id),
        this.clock.now().toISOString(),
      )
    }
    return admitted
  }

  /**
   * 上下文组装完成后再统一标记召回时间。这样因预算被裁掉的条目不会被
   * 误记为“刚被想起”，后续检索排序也不会被凭空抬高。
   */
  markRecalled(ids: readonly string[]): void {
    if (ids.length === 0) return
    this.storage.markMemoriesRecalled(
      ids,
      this.clock.now().toISOString(),
    )
  }

  /**
   * 抽取前做一次精确去重；个人规模的记忆量足够小，
   * 这里宁可多读几条正文，也不让每轮聊天重复写入同一条事实。
   */
  hasEquivalentText(text: string): boolean {
    const normalized = text.trim()
    for (const memory of this.storage.listMemories()) {
      if (memory.status !== 'active' && memory.status !== 'candidate') continue
      const body = this.storage.getBody(memory.contentRef)
      if (body !== null && body.content.trim() === normalized) return true
    }
    return false
  }

  view(memory: MemoryRecord): MemoryView {
    const body = this.storage.getBody(memory.contentRef)
    if (body === null) {
      throw new MemoryInputError(
        'content_missing',
        `memory "${memory.id}" has no readable content body`,
      )
    }
    const quote = memory.quoteRef === null
      ? null
      : this.storage.getBody(memory.quoteRef)
    return {
      ...memory,
      text: body.content,
      quoteText: quote?.content ?? null,
    }
  }

  getView(id: string): MemoryView | null {
    const memory = this.storage.getMemory(id)
    return memory === null ? null : this.view(memory)
  }

  listViews(
    status: 'active' | 'candidate' | 'trash' | 'all' = 'active',
  ): MemoryView[] {
    const records = status === 'trash'
      ? this.storage.listMemories({ onlyDeleted: true })
      : status === 'candidate'
        ? this.storage.listMemories().filter(
            memory => memory.status === 'candidate',
          )
        : status === 'all'
          ? this.storage.listMemories().filter(
              memory => memory.status !== 'replaced',
            )
          : this.storage.listMemories().filter(
              memory => memory.status === 'active',
            )
    return records
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id))
      .map(memory => this.view(memory))
  }

  listCandidates(): MemoryRecord[] {
    return this.storage
      .listMemories()
      .filter(memory => memory.status === 'candidate')
  }

  listTrash(): MemoryRecord[] {
    return this.storage.listMemories({ onlyDeleted: true })
  }

  private prepareRecord(input: {
    text: string
    quoteText: string | null | undefined
    kind: string
    source: MemorySource
    confidence: number
    sensitivity: Sensitivity
    importance: Importance
    status: 'active' | 'candidate'
    id?: string
    createdAt?: string
  }): MemoryRecord {
    const text = normalizeMemoryTextSafe(input.text)
    const quoteText = input.quoteText === undefined || input.quoteText === null
      ? text
      : normalizeMemoryTextSafe(input.quoteText, 'memory.quoteText')
    const kind = validateKind(input.kind)
    const createdAt = validateCreatedAt(
      input.createdAt ?? this.clock.now().toISOString(),
    )
    const id = validateGeneratedId(input.id ?? `memory-${randomUUID()}`, 'memory.id')
    const contentRef = `body-memory-${randomUUID()}`
    this.storage.putBody({
      id: contentRef,
      kind: 'memory',
      content: text,
      createdAt,
    })
    const quoteRef = quoteText === text
      ? contentRef
      : this.writeQuoteBody(quoteText, createdAt)

    return {
      schemaVersion: 1,
      id,
      kind,
      contentRef,
      quoteRef,
      source: input.source,
      createdAt,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      importance: input.importance,
      lastRecalledAt: null,
      status: input.status,
      replacedBy: null,
      deletedAt: null,
      purgeAfter: null,
    }
  }

  private writeQuoteBody(text: string, createdAt: string): string {
    const quoteRef = `body-quote-${randomUUID()}`
    this.storage.putBody({
      id: quoteRef,
      kind: 'memory_quote',
      content: text,
      createdAt,
    })
    return quoteRef
  }
}

function validateRecallSettings(
  settings: MemoryRecallSettings,
): MemoryRecallSettings {
  if (
    typeof settings.minRelevance !== 'number' ||
    !Number.isFinite(settings.minRelevance) ||
    settings.minRelevance < 0 ||
    settings.minRelevance > 1
  ) {
    throw new MemoryInputError(
      'invalid_min_relevance',
      'memory recall minRelevance must be a number between 0 and 1',
    )
  }
  if (
    !Number.isInteger(settings.candidateLimit) ||
    settings.candidateLimit < 1 ||
    settings.candidateLimit > 50
  ) {
    throw new MemoryInputError(
      'invalid_candidate_limit',
      'memory recall candidateLimit must be an integer between 1 and 50',
    )
  }
  return settings
}

function requireMemorySource(value: unknown): MemorySource {
  if (!MEMORY_SOURCES.includes(value as MemorySource)) {
    throw new MemoryInputError(
      'invalid_source',
      `unsupported memory source "${String(value)}"`,
    )
  }
  return value as MemorySource
}

function requireSensitivity(value: unknown): Sensitivity {
  if (!SENSITIVITIES.includes(value as Sensitivity)) {
    throw new MemoryInputError(
      'invalid_sensitivity',
      `unsupported memory sensitivity "${String(value)}"`,
    )
  }
  return value as Sensitivity
}

function requireImportance(value: unknown): Importance {
  if (!IMPORTANCES.includes(value as Importance)) {
    throw new MemoryInputError(
      'invalid_importance',
      `unsupported memory importance "${String(value)}"`,
    )
  }
  return value as Importance
}

function normalizeMemoryTextSafe(value: unknown, field = 'memory.text'): string {
  try {
    return normalizeMemoryText(value, field)
  } catch (error) {
    throw new MemoryInputError(
      'invalid_text',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function validateKind(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new MemoryInputError(
      'invalid_kind',
      'memory kind must be a lowercase identifier',
    )
  }
  return value
}

function validateCreatedAt(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new MemoryInputError(
      'invalid_created_at',
      'memory createdAt must be an ISO instant',
    )
  }
  return new Date(value).toISOString()
}

function validateGeneratedId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new MemoryInputError('invalid_id', `${field} must be a safe identifier`)
  }
  return value
}
