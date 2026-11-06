/**
 * 跨聊天、记忆和模型的统一审计时间线。
 *
 * 这一层只接收已校验的存储元数据，不读取 bodies，也不接收提示词或回复
 * 正文。所有来源都先映射成不含文本字段的条目，再统一排序和截断。
 */

import type {
  ChatTurnAuditRecord,
  KanobotStorage,
  ModelCallPurpose,
  ModelCallStatus,
  OwnerAuditAction,
  OwnerAuditOutcome,
  OwnerAuditTargetType,
  ReplyStyleCheckRecord,
} from '../storage/index.ts'

export const AUDIT_TIMELINE_SOURCES = [
  'owner',
  'memory',
  'model',
  'style',
  'chat',
] as const

export type AuditTimelineSource = typeof AUDIT_TIMELINE_SOURCES[number]
export type AuditTimelineFilter = AuditTimelineSource | 'all'
export type AuditTimelineOutcome =
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'running'
  | 'info'

export interface AuditTimelineEntry {
  id: string
  source: AuditTimelineSource
  kind: string
  occurredAt: string
  outcome: AuditTimelineOutcome
  targetId: string | null
  detailCode: string | null
  owner?: {
    action: OwnerAuditAction
    targetType: OwnerAuditTargetType
    outcome: OwnerAuditOutcome
  }
  memory?: {
    memoryId: string
    kind: string
    status: string
    source: string
    sensitivity: string
    importance: string
  }
  modelCall?: {
    purpose: ModelCallPurpose
    provider: string
    model: string
    attempts: number
    inputTokens: number | null
    outputTokens: number | null
    estimatedCost: number | null
    conversationId: string
    userMessageId: string | null
    assistantMessageId: string | null
  }
  style?: {
    assistantMessageId: string
    ok: boolean
    violationCodes: string[]
    retryCount: 0 | 1
    initialViolationCodes: string[]
  }
  chat?: {
    conversationId: string
    modelCallCount: number
    succeededModelCallCount: number
    styleOk: boolean | null
    violationCodes: string[]
    retryCount: number | null
  }
}

export class AuditTimelineService {
  private readonly storage: KanobotStorage

  constructor(storage: KanobotStorage) {
    this.storage = storage
  }

  list(
    limit = 50,
    filter: AuditTimelineFilter = 'all',
  ): AuditTimelineEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError('audit timeline limit must be between 1 and 200')
    }
    if (filter !== 'all' && !AUDIT_TIMELINE_SOURCES.includes(filter)) {
      throw new RangeError(`unsupported audit timeline source "${filter}"`)
    }

    const entries: AuditTimelineEntry[] = []
    if (filter === 'all' || filter === 'owner') {
      entries.push(
        ...this.storage.listOwnerAudit(limit).map(entry => ({
          id: `owner:${entry.id}`,
          source: 'owner' as const,
          kind: entry.action,
          occurredAt: entry.occurredAt,
          outcome: entry.outcome,
          targetId: entry.targetId,
          detailCode: entry.detailCode,
          owner: {
            action: entry.action,
            targetType: entry.targetType,
            outcome: entry.outcome,
          },
        })),
      )
    }
    if (filter === 'all' || filter === 'memory') {
      entries.push(
        ...this.storage.listRecentMemories(limit).map(memory => ({
          id: `memory:${memory.id}`,
          source: 'memory' as const,
          kind: 'memory.recorded',
          occurredAt: memory.createdAt,
          outcome: 'info' as const,
          targetId: memory.id,
          detailCode: memory.status,
          memory: {
            memoryId: memory.id,
            kind: memory.kind,
            status: memory.status,
            source: memory.source,
            sensitivity: memory.sensitivity,
            importance: memory.importance,
          },
        })),
      )
    }
    if (filter === 'all' || filter === 'model') {
      entries.push(
        ...this.storage.listModelCalls(limit).map(call => ({
          id: `model:${call.id}`,
          source: 'model' as const,
          kind: 'model.call',
          occurredAt: call.startedAt,
          outcome: modelCallOutcome(call.status),
          targetId: call.id,
          detailCode: call.errorCode,
          modelCall: {
            purpose: call.purpose,
            provider: call.provider,
            model: call.model,
            attempts: call.attempts,
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            estimatedCost: call.estimatedCost,
            conversationId: call.conversationId,
            userMessageId: call.userMessageId,
            assistantMessageId: call.assistantMessageId,
          },
        })),
      )
    }
    if (filter === 'all' || filter === 'style') {
      entries.push(
        ...this.storage.listReplyStyleChecks(limit).map(check => ({
          id: `style:${check.id}`,
          source: 'style' as const,
          kind: 'style.check',
          occurredAt: check.checkedAt,
          outcome: check.ok ? 'succeeded' as const : 'failed' as const,
          targetId: check.assistantMessageId,
          detailCode: check.ok ? null : check.violationCodes.join(','),
          style: styleEntry(check),
        })),
      )
    }
    if (filter === 'all' || filter === 'chat') {
      entries.push(
        ...this.storage.listChatTurnAudits(limit).map(turn => ({
          id: `chat:${turn.assistantMessageId}`,
          source: 'chat' as const,
          kind: 'chat.turn',
          occurredAt: turn.createdAt,
          outcome: turn.styleOk === false ? 'failed' as const : 'info' as const,
          targetId: turn.assistantMessageId,
          detailCode:
            turn.styleOk === false ? turn.violationCodes.join(',') : null,
          chat: chatEntry(turn),
        })),
      )
    }

    return entries
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit)
  }
}

function styleEntry(check: ReplyStyleCheckRecord) {
  return {
    assistantMessageId: check.assistantMessageId,
    ok: check.ok,
    violationCodes: [...check.violationCodes],
    retryCount: check.retryCount,
    initialViolationCodes: [...check.initialViolationCodes],
  }
}

function chatEntry(turn: ChatTurnAuditRecord) {
  return {
    conversationId: turn.conversationId,
    modelCallCount: turn.modelCallCount,
    succeededModelCallCount: turn.succeededModelCallCount,
    styleOk: turn.styleOk,
    violationCodes: [...turn.violationCodes],
    retryCount: turn.retryCount,
  }
}

function modelCallOutcome(status: ModelCallStatus): AuditTimelineOutcome {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'aborted'
    case 'running':
      return 'running'
  }
}
