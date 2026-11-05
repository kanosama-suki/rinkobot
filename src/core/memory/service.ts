/**
 * 长期记忆的写入、纠正、候选转正和检索服务。
 *
 * 边界：
 * - 用户明确陈述且不敏感的内容立即 active；
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
  type MemorySearchOptions,
  type RememberMemoryInput,
} from './types.ts'

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

export class KanobotMemoryService {
  private readonly storage: KanobotStorage
  private readonly clock: Clock

  constructor(storage: KanobotStorage, clock: Clock = systemClock) {
    this.storage = storage
    this.clock = clock
  }

  remember(input: RememberMemoryInput): MemoryRecord {
    const source = requireMemorySource(input.source)
    const sensitivity = input.sensitivity === undefined
      ? 'normal'
      : requireSensitivity(input.sensitivity)
    const importance = input.importance === undefined
      ? 'normal'
      : requireImportance(input.importance)
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
        source === 'user_stated' && sensitivity === 'normal'
          ? 'active'
          : 'candidate',
      id: input.id,
      createdAt: input.createdAt,
    })
    return this.storage.putMemory(record)
  }

  /**
   * 所有者纠正属于明确陈述，因此新记录直接 active，并原子替代旧记录。
   * 敏感/第三人内容不能用 correction 绕过候选确认。
   */
  correct(previousId: string, input: CorrectMemoryInput): MemoryRecord {
    const record = this.prepareRecord({
      text: input.text,
      quoteText: input.quoteText,
      kind: input.kind,
      source: 'user_stated',
      confidence: 1,
      sensitivity: 'normal',
      importance: input.importance ?? 'important',
      status: 'active',
      id: input.id,
      createdAt: input.createdAt,
    })
    return this.storage.replaceMemory(previousId, record)
  }

  promote(id: string): MemoryRecord {
    return this.storage.promoteMemory(id)
  }

  search(
    query: string,
    options: MemorySearchOptions = {},
  ): MemorySearchResult[] {
    return this.storage.searchMemories(query, {
      limit: options.limit ?? 5,
      markRecalled: options.markRecalled ?? true,
    })
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
