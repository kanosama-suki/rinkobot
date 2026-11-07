/**
 * 主动性的确定性服务层。
 *
 * 一个 tick 内按固定顺序处理维护、计划、提醒、outbox、主动评估和每日整理；
 * 模型只提交候选，所有发送都必须经过闸门、正文风格检查和 outbox。
 * 这里不创建定时器，调度由宿主适配层统一持有。
 */

import { randomUUID } from 'node:crypto'

import { checkReplyStyle } from '../chat/index.ts'
import type { InitiativeConfig } from '../config/index.ts'
import type { KanobotMemoryService } from '../memory/index.ts'
import type { KanobotEmergencyService } from '../policy/index.ts'
import {
  systemClock,
  type Clock,
  type LifeState,
} from '../state/index.ts'
import type {
  CareItemRecord,
  ChatMessageRecord,
  DailyPlanItemRecord,
  DailyPlanRecord,
  KanobotStorage,
  OutboxRecord,
  ReminderCandidateRecord,
  ReminderRecord,
} from '../storage/index.ts'
import {
  addLocalDays,
  isQuietAt,
  localDateKey,
  localDateTimeToDate,
  localDayRange,
  localTimeParts,
  parseLocalClock,
} from './time.ts'
import {
  evaluateProactiveGate,
  nextProactiveIntervalMs,
} from './policy.ts'
import {
  type DailyPlanView,
  type DailySummaryView,
  type InitiativeBrain,
  type InitiativeRunView,
  type InitiativeTickResult,
  type InitiativeView,
  type ProactiveContext,
  type ReminderCandidateView,
  type ReminderView,
  type CareItemView,
  type ExternalOutboxDelivery,
} from './types.ts'
import { InitiativeError } from './types.ts'

export interface InitiativeServiceOptions {
  config: InitiativeConfig
  timezone: string
  quietHoursStart: string
  quietHoursEnd: string
  emergency: KanobotEmergencyService
  memory?: KanobotMemoryService
  /**
   * 主动消息和提醒的目标。默认仍是网页；QQ 启用时由宿主传入明确的
   * `qq:private:<id>` / `qq:group:<id>`，不能在核心层写死平台字段。
   */
  outboxTarget?: string
  externalOutbox?: ExternalOutboxDelivery
  clock?: Clock
  conversationId?: string
  random?: () => number
  startupAt?: string
}

export class KanobotInitiativeService {
  private readonly storage: KanobotStorage
  private readonly brain: InitiativeBrain
  private readonly config: InitiativeConfig
  private readonly timezone: string
  private readonly quietHoursStart: string
  private readonly quietHoursEnd: string
  private readonly emergency: KanobotEmergencyService
  private readonly memory: KanobotMemoryService | undefined
  private readonly outboxTarget: string
  private readonly externalOutbox: ExternalOutboxDelivery | undefined
  private readonly clock: Clock
  private readonly conversationId: string
  private readonly random: () => number
  private readonly startupAt: string
  private ticking = false

  constructor(
    storage: KanobotStorage,
    brain: InitiativeBrain,
    options: InitiativeServiceOptions,
  ) {
    this.storage = storage
    this.brain = brain
    this.config = options.config
    this.timezone = options.timezone
    this.quietHoursStart = options.quietHoursStart
    this.quietHoursEnd = options.quietHoursEnd
    this.emergency = options.emergency
    this.memory = options.memory
    this.outboxTarget = options.outboxTarget ?? 'web:owner'
    if (
      this.outboxTarget.length === 0 ||
      this.outboxTarget.length > 512 ||
      this.outboxTarget.includes('\0')
    ) {
      throw new RangeError('outboxTarget must be a non-empty target string')
    }
    this.externalOutbox = options.externalOutbox
    this.clock = options.clock ?? systemClock
    this.conversationId = options.conversationId ?? 'main'
    this.random = options.random ?? Math.random
    this.startupAt = options.startupAt ?? this.clock.now().toISOString()
  }

  async tick(signal: AbortSignal): Promise<InitiativeTickResult> {
    if (this.ticking) {
      throw new InitiativeError(
        'initiative_tick_already_running',
        'an initiative tick is already running',
      )
    }
    this.ticking = true
    const result: InitiativeTickResult = {
      status: 'completed',
      deliveredOutbox: 0,
      proactiveSent: false,
      planGenerated: false,
      reviewCompleted: false,
    }
    try {
      if (this.emergency.status().stopped) {
        this.recordRun('tick', 'skipped', 'emergency_stopped')
        return { ...result, status: 'stopped' }
      }
      const now = this.clock.now()
      if (Number.isNaN(now.getTime())) {
        throw new InitiativeError(
          'initiative_clock_invalid',
          'clock returned an invalid date',
        )
      }
      const nowIso = now.toISOString()
      const today = localDateKey(now, this.timezone)
      this.storage.updateInitiativeState({ lastTickAt: nowIso })
      this.runMaintenance(now, today)

      result.planGenerated = await this.runDailyPlan(now, signal)
      this.queueDueReminders(nowIso)
      result.deliveredOutbox += await this.processOutbox(now, signal)
      result.proactiveSent = await this.runProactive(now, signal)
      result.deliveredOutbox += await this.processOutbox(now, signal)
      result.reviewCompleted = await this.runDailyReview(now, signal)
      this.storage.updateInitiativeState({ lastTickAt: this.clock.now().toISOString() })
      this.recordRun('tick', 'allowed', 'tick_completed')
      return result
    } catch (error) {
      this.recordRun('tick', 'failed', errorCode(error))
      throw error
    } finally {
      this.ticking = false
    }
  }

  view(now: Date = this.clock.now()): InitiativeView {
    const nowIso = now.toISOString()
    const state = this.storage.getInitiativeState()
    const today = localDateKey(now, this.timezone)
    const planRecord = this.storage.getDailyPlan(today)
    const recentSince = new Date(
      now.getTime() - this.config.proactive.circuitWindowMinutes * 60_000,
    ).toISOString()
    return {
      enabled: this.config.proactive.enabled,
      quietNow: isQuietAt(
        now,
        this.timezone,
        this.quietHoursStart,
        this.quietHoursEnd,
      ),
      lastTickAt: state.lastTickAt,
      nextProactiveAt: state.nextProactiveAt,
      lastProactiveAt: state.lastProactiveAt,
      consecutiveUnanswered: state.consecutiveUnanswered,
      circuit: {
        open: state.circuitOpenedAt !== null,
        openedAt: state.circuitOpenedAt,
        recentMessageCount: this.storage.countDeliveredOutboxSince(
          'proactive',
          recentSince,
        ),
      },
      plan: planRecord === null ? null : this.planView(planRecord),
      reminderCandidates: this.storage
        .listReminderCandidates('pending', 20)
        .map(candidate => this.reminderCandidateView(candidate)),
      reminders: this.storage
        .listReminders('all', 20)
        .map(reminder => this.reminderView(reminder)),
      careItems: this.storage
        .listCareItems('all', 20)
        .map(item => this.careItemView(item)),
      summaries: this.recentSummaries(7),
      latestRuns: this.storage
        .listInitiativeRuns(20)
        .map(run => ({
          id: run.id,
          occurredAt: run.occurredAt,
          kind: run.kind,
          outcome: run.outcome,
          detailCode: run.detailCode,
          targetId: run.targetId,
        })),
    }
  }

  confirmReminderCandidate(id: string): ReminderView {
    this.emergency.assertAutonomousAllowed()
    const confirmed = this.storage.confirmReminderCandidate(
      id,
      this.clock.now().toISOString(),
    )
    this.recordRun(
      'reminder',
      'allowed',
      'owner_confirmed_reminder',
      confirmed.reminder.id,
    )
    return this.reminderView(confirmed.reminder)
  }

  rejectReminderCandidate(id: string): ReminderCandidateView {
    this.emergency.assertAutonomousAllowed()
    const candidate = this.storage.rejectReminderCandidate(id)
    this.recordRun(
      'reminder',
      'allowed',
      'owner_rejected_reminder',
      candidate.id,
    )
    return this.reminderCandidateView(candidate)
  }

  cancelReminder(id: string): ReminderView {
    this.emergency.assertAutonomousAllowed()
    const reminder = this.storage.cancelReminder(id)
    this.recordRun('reminder', 'allowed', 'owner_cancelled_reminder', id)
    return this.reminderView(reminder)
  }

  resetCircuit(): InitiativeView {
    this.storage.updateInitiativeState({
      circuitOpenedAt: null,
      updatedAt: this.clock.now().toISOString(),
    })
    this.recordRun('circuit', 'allowed', 'owner_reset_circuit')
    return this.view()
  }

  private runMaintenance(now: Date, today: string): void {
    const nowIso = now.toISOString()
    const staleBefore = new Date(
      now.getTime() -
        Math.max(10, this.config.outbox.retryBackoffMinutes * 2) * 60_000,
    ).toISOString()
    this.storage.recoverStaleOutbox(staleBefore, nowIso)
    this.storage.expireOutbox(
      new Date(
        now.getTime() - this.config.outbox.expireAfterMinutes * 60_000,
      ).toISOString(),
      nowIso,
    )
    this.storage.expireCareItems(nowIso)
    // 记忆冷却和回收站清理都属于维护阶段；归档失败不能让本轮主动消息
    // 直接失败，但会通过 initiative run 的脱敏错误码暴露。
    try {
      const archived = this.memory?.archiveExpiredCandidates(now) ?? []
      if (archived.length > 0) {
        this.recordRun('tick', 'allowed', 'memory_candidates_archived')
      }
    } catch (error) {
      this.recordRun('tick', 'failed', errorCode(error))
    }
    const state = this.storage.getInitiativeState()
    if (state.lastTrashPurgeDay !== today) {
      try {
        const purged = this.storage.purgeExpiredTrash(nowIso)
        this.storage.updateInitiativeState({
          lastTrashPurgeDay: today,
          updatedAt: nowIso,
        })
        if (purged > 0) {
          this.recordRun('tick', 'allowed', 'trash_purged')
        }
      } catch (error) {
        this.recordRun('tick', 'failed', errorCode(error))
      }
    }
    try {
      this.storage.maybeCreateDailyBackup(now)
    } catch (error) {
      this.recordRun('tick', 'failed', errorCode(error))
    }
  }

  private async runDailyPlan(
    now: Date,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.config.life.enabled) return false
    const today = localDateKey(now, this.timezone)
    const state = this.storage.getInitiativeState()
    if (state.lastDailyPlanDay === today) return false
    const schedule = parseLocalClock(
      this.config.schedule.dailyPlanAt,
      'initiative.schedule.daily_plan_at',
    )
    const minute = localTimeParts(now, this.timezone).minuteOfDay
    if (minute < schedule.hour * 60 + schedule.minute) return false
    const existing = this.storage.getDailyPlan(today)
    if (existing !== null) {
      this.storage.updateInitiativeState({
        lastDailyPlanDay: today,
        updatedAt: now.toISOString(),
      })
      return false
    }

    try {
      this.emergency.assertAutonomousAllowed()
      const draft = await this.brain.planDay({
        now: now.toISOString(),
        timezone: this.timezone,
        state: this.storage.currentState(),
        maxItems: this.config.life.maxPlanItems,
        signal,
      })
      this.emergency.assertAutonomousAllowed()
      const scheduled = this.schedulePlanItems(
        today,
        draft.items,
        now.toISOString(),
      )
      if (scheduled.length === 0) {
        this.storage.updateInitiativeState({
          lastDailyPlanDay: today,
          updatedAt: this.clock.now().toISOString(),
        })
        this.recordRun('daily_plan', 'skipped', 'no_plan_items')
        return false
      }
      this.storage.putDailyPlan({
        localDay: today,
        createdAt: this.clock.now().toISOString(),
        items: scheduled.map((item, index) => ({
          id: `plan-${randomUUID()}`,
          position: index + 1,
          kind: item.kind,
          title: item.title,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
        })),
      })
      this.storage.updateInitiativeState({
        lastDailyPlanDay: today,
        updatedAt: this.clock.now().toISOString(),
      })
      this.recordRun('daily_plan', 'sent', 'daily_plan_created')
      return true
    } catch (error) {
      this.storage.updateInitiativeState({
        lastDailyPlanDay: today,
        updatedAt: this.clock.now().toISOString(),
      })
      this.recordRun('daily_plan', 'failed', errorCode(error))
      return false
    }
  }

  private schedulePlanItems(
    today: string,
    items: readonly {
      kind: string
      title: string
      durationMinutes: number
    }[],
    createdAt: string,
  ): Array<{
    kind: string
    title: string
    startsAt: string
    endsAt: string
  }> {
    const start = parseLocalClock(
      this.config.life.dayStartAt,
      'initiative.life.day_start_at',
    )
    const end = parseLocalClock(
      this.config.life.dayEndAt,
      'initiative.life.day_end_at',
    )
    const dayEnd = localDateTimeToDate(
      today,
      end.hour,
      end.minute,
      this.timezone,
    )
    const configuredStart = localDateTimeToDate(
      today,
      start.hour,
      start.minute,
      this.timezone,
    )
    // 晚启动时只安排尚未开始的软活动，不能把上午的计划倒填成已经发生过。
    const generatedAt = new Date(createdAt)
    const firstAvailable = new Date(
      generatedAt.getTime() + this.config.life.itemGapMinutes * 60_000,
    )
    let cursor = firstAvailable > configuredStart
      ? firstAvailable
      : configuredStart
    const planned: Array<{
      kind: string
      title: string
      startsAt: string
      endsAt: string
    }> = []
    for (const item of items.slice(0, this.config.life.maxPlanItems)) {
      const startsAt = new Date(cursor)
      const endsAt = new Date(
        startsAt.getTime() + item.durationMinutes * 60_000,
      )
      if (endsAt.getTime() > dayEnd.getTime()) break
      planned.push({
        kind: item.kind,
        title: item.title,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      })
      cursor = new Date(
        endsAt.getTime() + this.config.life.itemGapMinutes * 60_000,
      )
    }
    return planned
  }

  private queueDueReminders(nowIso: string): void {
    if (!this.config.reminders.enabled) return
    try {
      this.emergency.assertAutonomousAllowed()
    } catch {
      return
    }
    for (const reminder of this.storage.listDueReminders(nowIso, 50)) {
      try {
        this.emergency.assertAutonomousAllowed()
        this.storage.queueReminderOutbox(
          reminder.id,
          nowIso,
          this.config.outbox.maxAttempts,
          this.outboxTarget,
        )
        this.recordRun(
          'reminder',
          'allowed',
          'reminder_queued',
          reminder.id,
        )
      } catch (error) {
        this.recordRun(
          'reminder',
          'failed',
          errorCode(error),
          reminder.id,
        )
      }
    }
  }

  private async processOutbox(
    now: Date,
    signal: AbortSignal,
  ): Promise<number> {
    const nowIso = now.toISOString()
    let delivered = 0
    for (const candidate of this.storage.listDueOutbox(nowIso, 50)) {
      try {
        this.emergency.assertAutonomousAllowed()
      } catch {
        break
      }
      const staleReason = candidate.kind === 'proactive'
        ? this.proactiveDeliveryStaleReason(candidate, now)
        : null
      if (staleReason !== null) {
        try {
          this.storage.expireOutboxRecord(candidate.id, nowIso)
          this.recordRun(
            'outbox',
            'skipped',
            staleReason,
            candidate.id,
          )
        } catch (error) {
          this.recordRun('outbox', 'failed', errorCode(error), candidate.id)
        }
        continue
      }
      let claimed: OutboxRecord
      try {
        claimed = this.storage.claimOutbox(candidate.id, nowIso)
      } catch (error) {
        this.recordRun('outbox', 'failed', errorCode(error), candidate.id)
        continue
      }
      if (claimed.target !== 'web:owner') {
        const external = this.externalOutbox
        if (external !== undefined && external.supports(claimed.target)) {
          delivered += await this.deliverExternalOutbox(
            claimed,
            external,
            now,
            signal,
          )
          continue
        }
        try {
          this.storage.abandonOutbox(
            claimed.id,
            'unsupported_target',
            nowIso,
          )
        } catch {
          // 下一次启动仍会看到这条未知目标，不能把它当成已发送。
        }
        this.recordRun('outbox', 'failed', 'unsupported_target', claimed.id)
        continue
      }
      try {
        const result = this.storage.deliverOutbox(claimed.id, nowIso)
        delivered += 1
        this.recordRun('outbox', 'sent', 'outbox_delivered', claimed.id)
        if (result.outbox.kind === 'proactive') {
          this.afterProactiveDelivery(nowIso)
        }
      } catch (error) {
        const retryAt = claimed.attempts < claimed.maxAttempts
          ? new Date(
              now.getTime() + this.config.outbox.retryBackoffMinutes * 60_000,
            ).toISOString()
          : null
        try {
          this.storage.markOutboxFailure(
            claimed.id,
            'delivery_failed',
            nowIso,
            retryAt,
          )
        } catch {
          // 原始投递错误已经记录；不在这里无限重试。
        }
        this.recordRun('outbox', 'failed', errorCode(error), claimed.id)
      }
    }
    return delivered
  }

  private async deliverExternalOutbox(
    claimed: OutboxRecord,
    external: ExternalOutboxDelivery,
    now: Date,
    signal: AbortSignal,
  ): Promise<number> {
    const nowIso = now.toISOString()
    const body = this.storage.getBody(claimed.payloadRef)
    if (body === null) {
      try {
        this.storage.abandonOutbox(
          claimed.id,
          'payload_missing',
          nowIso,
        )
      } catch {
        // 原始缺失错误已经足以说明这条投递不可完成。
      }
      this.recordRun('outbox', 'failed', 'payload_missing', claimed.id)
      return 0
    }
    try {
      const result = await external.deliver({
        target: claimed.target,
        text: body.content,
        signal,
      })
      if (result.status === 'delivered') {
        this.storage.deliverOutbox(claimed.id, nowIso)
        this.recordRun('outbox', 'sent', 'outbox_delivered', claimed.id)
        if (claimed.kind === 'proactive') {
          this.afterProactiveDelivery(nowIso)
        }
        return 1
      }
      if (result.status === 'unknown') {
        this.storage.markOutboxUnknown(
          claimed.id,
          externalErrorCode(result.errorCode),
          nowIso,
        )
        this.recordRun(
          'outbox',
          'failed',
          externalErrorCode(result.errorCode),
          claimed.id,
        )
        return 0
      }
      if (!result.retryable) {
        this.storage.abandonOutbox(
          claimed.id,
          externalErrorCode(result.errorCode),
          nowIso,
        )
      } else {
        const retryAt = claimed.attempts < claimed.maxAttempts
          ? new Date(
              now.getTime() + this.config.outbox.retryBackoffMinutes * 60_000,
            ).toISOString()
          : null
        this.storage.markOutboxFailure(
          claimed.id,
          externalErrorCode(result.errorCode),
          nowIso,
          retryAt,
        )
      }
      this.recordRun(
        'outbox',
        'failed',
        externalErrorCode(result.errorCode),
        claimed.id,
      )
      return 0
    } catch (error) {
      // 适配器自身异常无法证明消息未发出，按结果未知处理，避免重启后重复。
      const code = errorCode(error)
      try {
        this.storage.markOutboxUnknown(claimed.id, code, nowIso)
      } catch {
        // 投递结果已经不确定，不能再把它当成可重试状态。
      }
      this.recordRun('outbox', 'failed', code, claimed.id)
      return 0
    }
  }

  /**
   * 主动消息只在它被构思时的情境仍然有效时发送。静默、熔断、重启或
   * kano 已经回来之后，旧草稿不应继续穿透 outbox。
   */
  private proactiveDeliveryStaleReason(
    candidate: OutboxRecord,
    now: Date,
  ): string | null {
    if (this.storage.getInitiativeState().circuitOpenedAt !== null) {
      return 'proactive_circuit_open'
    }
    if (
      isQuietAt(
        now,
        this.timezone,
        this.quietHoursStart,
        this.quietHoursEnd,
      )
    ) {
      return 'proactive_quiet_hours_expired'
    }
    if (Date.parse(candidate.createdAt) < Date.parse(this.startupAt)) {
      return 'stale_proactive_expired'
    }
    const latestUser = this.storage.latestUserChatMessage(
      this.conversationId,
    )
    if (
      latestUser !== null &&
      Date.parse(latestUser.createdAt) > Date.parse(candidate.createdAt)
    ) {
      return 'proactive_superseded_by_chat'
    }
    return null
  }

  private afterProactiveDelivery(deliveredAt: string): void {
    const state = this.storage.getInitiativeState()
    const consecutive = state.consecutiveUnanswered + 1
    this.storage.updateInitiativeState({
      lastProactiveAt: deliveredAt,
      consecutiveUnanswered: consecutive,
      updatedAt: deliveredAt,
    })
    const since = new Date(
      Date.parse(deliveredAt) -
        this.config.proactive.circuitWindowMinutes * 60_000,
    ).toISOString()
    const recent = this.storage.countDeliveredOutboxSince('proactive', since)
    if (
      recent >= this.config.proactive.circuitMaxMessages &&
      state.circuitOpenedAt === null
    ) {
      this.storage.updateInitiativeState({
        circuitOpenedAt: deliveredAt,
        updatedAt: deliveredAt,
      })
      this.recordRun('circuit', 'skipped', 'proactive_circuit_opened')
    }
  }

  private async runProactive(
    now: Date,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.config.proactive.enabled) return false
    let state = this.storage.getInitiativeState()
    const nowIso = now.toISOString()
    const latestUser = this.storage.latestUserChatMessage(
      this.conversationId,
    )
    if (
      latestUser !== null &&
      (state.lastProactiveAt === null ||
        Date.parse(latestUser.createdAt) > Date.parse(state.lastProactiveAt))
    ) {
      state = this.storage.updateInitiativeState({
        consecutiveUnanswered: 0,
        updatedAt: nowIso,
      })
    }
    const circuitSince = new Date(
      now.getTime() - this.config.proactive.circuitWindowMinutes * 60_000,
    ).toISOString()
    if (
      state.circuitOpenedAt === null &&
      this.storage.countDeliveredOutboxSince('proactive', circuitSince) >=
        this.config.proactive.circuitMaxMessages
    ) {
      this.storage.updateInitiativeState({
        circuitOpenedAt: nowIso,
        updatedAt: nowIso,
      })
      this.recordRun('circuit', 'skipped', 'proactive_circuit_opened')
      return false
    }

    const decision = evaluateProactiveGate({
      config: this.config.proactive,
      now,
      timezone: this.timezone,
      quietStart: this.quietHoursStart,
      quietEnd: this.quietHoursEnd,
      nextProactiveAt: state.nextProactiveAt,
      lastChatMessageAt: latestUser?.createdAt ?? null,
      state: this.storage.currentState(),
      circuitOpenedAt: state.circuitOpenedAt,
    })
    if (!decision.allowed) {
      this.recordRun('proactive', 'skipped', decision.reason ?? 'gate_denied')
      if (decision.retryAt !== null) {
        this.storage.updateInitiativeState({
          nextProactiveAt: decision.retryAt,
          updatedAt: nowIso,
        })
      }
      return false
    }

    try {
      this.emergency.assertAutonomousAllowed()
      const dueCare = this.storage.listDueCareItems(nowIso, 1)
      const lastSummary = this.latestSummaryText(
        localDateKey(now, this.timezone),
      )
      const planRecord = this.storage.getDailyPlan(
        localDateKey(now, this.timezone),
      )
      const recentMessages = this.storage.listChatMessages(
        this.conversationId,
        20,
      )
      const silenceMinutes = latestUser === null
        ? null
        : Math.max(
            0,
            Math.floor(
              (now.getTime() - Date.parse(latestUser.createdAt)) / 60_000,
            ),
          )
      const longSilence =
        silenceMinutes !== null &&
        silenceMinutes >= this.config.proactive.longSilenceHours * 60
      const context: ProactiveContext = {
        now: nowIso,
        timezone: this.timezone,
        state: this.storage.currentState(),
        recentMessages,
        plan: planRecord === null ? [] : this.planView(planRecord).items,
        lastDailySummary: lastSummary,
        latestUserMessageAt: latestUser?.createdAt ?? null,
        silenceMinutes,
        longSilence,
        consecutiveUnanswered: state.consecutiveUnanswered,
        morningGreeting: this.isMorningGreetingWindow(now, state),
        dueCare: dueCare.map(item => ({
          id: item.id,
          text: this.bodyText(item.bodyRef, 'care item'),
          dueUntil: item.dueUntil,
        })),
      }
      const draft = await this.brain.composeProactive(context, signal)
      this.emergency.assertAutonomousAllowed()
      if (!draft.shouldSend) {
        this.scheduleNextProactive(now, state.consecutiveUnanswered)
        this.recordRun('proactive', 'skipped', draft.reasonCode)
        return false
      }
      const style = checkReplyStyle(draft.message, {
        serious: Array.from(draft.message).length > 200,
      })
      if (!style.ok) {
        this.scheduleNextProactive(now, state.consecutiveUnanswered)
        this.recordRun('proactive', 'skipped', 'style_check_failed')
        return false
      }
      const matchedCare = draft.careItemId === null
        ? undefined
        : dueCare.find(item => item.id === draft.careItemId)
      const careItemIds = matchedCare === undefined ? [] : [matchedCare.id]
      this.storage.enqueueOutbox({
        target: this.outboxTarget,
        kind: 'proactive',
        text: draft.message,
        dueAt: nowIso,
        maxAttempts: this.config.outbox.maxAttempts,
        createdAt: nowIso,
        careItemIds,
      })
      this.scheduleNextProactive(now, state.consecutiveUnanswered)
      this.recordRun('proactive', 'allowed', draft.reasonCode)
      return true
    } catch (error) {
      this.scheduleNextProactive(now, state.consecutiveUnanswered)
      this.recordRun('proactive', 'failed', errorCode(error))
      return false
    }
  }

  private scheduleNextProactive(now: Date, unanswered: number): void {
    const interval = nextProactiveIntervalMs(
      this.config.proactive,
      this.random,
      unanswered,
    )
    this.storage.updateInitiativeState({
      nextProactiveAt: new Date(now.getTime() + interval).toISOString(),
      updatedAt: now.toISOString(),
    })
  }

  private isMorningGreetingWindow(
    now: Date,
    state: ReturnType<KanobotStorage['getInitiativeState']>,
  ): boolean {
    if (!this.config.proactive.morningGreeting) return false
    const parts = localTimeParts(now, this.timezone)
    if (parts.hour < 7 || parts.hour >= 11) return false
    const today = localDateKey(now, this.timezone)
    return state.lastProactiveAt === null ||
      localDateKey(new Date(state.lastProactiveAt), this.timezone) !== today
  }

  private async runDailyReview(
    now: Date,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.config.review.enabled) return false
    const today = localDateKey(now, this.timezone)
    const at = parseLocalClock(
      this.config.schedule.dailyReviewAt,
      'initiative.schedule.daily_review_at',
    )
    if (localTimeParts(now, this.timezone).minuteOfDay < at.hour * 60 + at.minute) {
      return false
    }
    const targetDay = addLocalDays(today, -1)
    let state = this.storage.getInitiativeState()
    if (state.lastDailyReviewDay === targetDay) return false
    // 摘要在独立事务中先落库，整理状态最后才写。若进程在两者之间退出，
    // 重入时不能再次写同一 local_day，也不能把它当成普通失败反复重试。
    if (this.storage.getDailySummary(targetDay) !== null) {
      this.storage.updateInitiativeState({
        lastDailyReviewDay: targetDay,
        lastReviewAttemptDay: targetDay,
        dailyReviewAttempts: 0,
        updatedAt: now.toISOString(),
      })
      this.recordRun(
        'daily_review',
        'skipped',
        'daily_summary_already_exists',
      )
      return false
    }
    if (state.lastReviewAttemptDay !== targetDay) {
      state = this.storage.updateInitiativeState({
        lastReviewAttemptDay: targetDay,
        dailyReviewAttempts: 0,
        updatedAt: now.toISOString(),
      })
    }
    if (state.dailyReviewAttempts >= this.config.review.maxAttemptsPerDay) {
      return false
    }

    try {
      this.emergency.assertAutonomousAllowed()
      const range = localDayRange(targetDay, this.timezone)
      const messages = this.storage.listChatMessagesBetween(
        this.conversationId,
        range.start.toISOString(),
        range.end.toISOString(),
        this.config.review.maxMessages,
      )
      if (messages.length === 0) {
        this.storage.updateInitiativeState({
          lastDailyReviewDay: targetDay,
          lastReviewAttemptDay: targetDay,
          dailyReviewAttempts: 0,
          updatedAt: now.toISOString(),
        })
        this.recordRun('daily_review', 'skipped', 'no_messages')
        return false
      }
      const draft = await this.brain.reviewDay(
        {
          localDay: targetDay,
          timezone: this.timezone,
          messages,
          state: this.storage.currentState(),
        },
        signal,
      )
      this.emergency.assertAutonomousAllowed()
      const createdAt = this.clock.now().toISOString()
      this.storage.putDailySummary({
        localDay: targetDay,
        summary: draft.summary,
        sourceMessageIds: messages.map(message => message.id),
        createdAt,
      })
      this.persistReviewMemories(draft.memories, createdAt)
      this.storage.updateInitiativeState({
        lastDailyReviewDay: targetDay,
        lastReviewAttemptDay: targetDay,
        dailyReviewAttempts: 0,
        updatedAt: createdAt,
      })
      this.recordRun('daily_review', 'sent', 'daily_summary_created')
      return true
    } catch (error) {
      state = this.storage.getInitiativeState()
      this.storage.updateInitiativeState({
        lastReviewAttemptDay: targetDay,
        dailyReviewAttempts: state.dailyReviewAttempts + 1,
        updatedAt: this.clock.now().toISOString(),
      })
      this.recordRun('daily_review', 'failed', errorCode(error))
      return false
    }
  }

  private persistReviewMemories(
    memories: readonly {
      text: string
      kind: string
      importance: 'normal' | 'important' | 'permanent'
      sensitivity: 'normal' | 'sensitive' | 'third_party'
      messageIds: string[]
    }[],
    createdAt: string,
  ): void {
    if (this.memory === undefined) return
    for (const memory of memories.slice(0, 3)) {
      try {
        if (this.memory.hasEquivalentText(memory.text)) continue
        const sourceMessage = memory.messageIds
          .map(id => this.storage.getChatMessage(id))
          .find(message => message !== null)
        if (sourceMessage === null || sourceMessage === undefined) continue
        this.memory.remember({
          text: memory.text,
          quoteText: sourceMessage.text,
          kind: memory.kind,
          source: 'rinko_inferred',
          confidence: 0.65,
          importance: memory.importance,
          sensitivity: memory.sensitivity,
          createdAt,
        })
      } catch {
        // 单条记忆候选失败不丢弃已经生成的每日摘要。
      }
    }
  }

  private planView(plan: DailyPlanRecord): DailyPlanView {
    return {
      localDay: plan.localDay,
      createdAt: plan.createdAt,
      items: plan.items.map(item => ({
        id: item.id,
        localDay: item.localDay,
        position: item.position,
        kind: item.kind as DailyPlanView['items'][number]['kind'],
        title: this.bodyText(item.titleRef, 'daily plan item'),
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        status: item.status,
      })),
    }
  }

  private reminderCandidateView(
    candidate: ReminderCandidateRecord,
  ): ReminderCandidateView {
    return {
      id: candidate.id,
      text: this.bodyText(candidate.bodyRef, 'reminder candidate'),
      dueAt: candidate.dueAt,
      status: candidate.status,
      createdAt: candidate.createdAt,
      sourceMessageId: candidate.sourceMessageId,
      confirmedReminderId: candidate.confirmedReminderId,
    }
  }

  private reminderView(reminder: ReminderRecord): ReminderView {
    return {
      id: reminder.id,
      text: this.bodyText(reminder.bodyRef, 'reminder'),
      dueAt: reminder.dueAt,
      status: reminder.status,
      createdAt: reminder.createdAt,
      deliveredAt: reminder.deliveredAt,
    }
  }

  private careItemView(item: CareItemRecord): CareItemView {
    return {
      id: item.id,
      text: this.bodyText(item.bodyRef, 'care item'),
      dueFrom: item.dueFrom,
      dueUntil: item.dueUntil,
      status: item.status,
      createdAt: item.createdAt,
      deliveredAt: item.deliveredAt,
    }
  }

  private recentSummaries(limit: number): DailySummaryView[] {
    return this.storage.listDailySummaries(limit).map(summary => ({
      localDay: summary.localDay,
      summary: this.bodyText(summary.bodyRef, 'daily summary'),
      sourceMessageIds: summary.sourceRefs,
      createdAt: summary.createdAt,
    }))
  }

  private latestSummaryText(today: string): string | null {
    const summary = this.storage
      .listDailySummaries(7)
      .find(item => item.localDay < today)
    return summary === undefined
      ? null
      : this.bodyText(summary.bodyRef, 'daily summary')
  }

  private bodyText(ref: string, label: string): string {
    const body = this.storage.getBody(ref)
    if (body === null) {
      throw new InitiativeError(
        'initiative_body_missing',
        `${label} "${ref}" has no readable body`,
      )
    }
    return body.content
  }

  private recordRun(
    kind:
      | 'tick'
      | 'daily_plan'
      | 'daily_review'
      | 'proactive'
      | 'reminder'
      | 'outbox'
      | 'circuit',
    outcome: 'allowed' | 'sent' | 'skipped' | 'failed',
    detailCode: string,
    targetId: string | null = null,
  ): void {
    try {
      this.storage.recordInitiativeRun({
        kind,
        outcome,
        detailCode:
          /^[a-z][a-z0-9_.-]{0,127}$/.test(detailCode)
            ? detailCode
            : 'unknown',
        targetId,
        occurredAt: this.clock.now().toISOString(),
      })
    } catch {
      // 运行记录失败不能改变已经确定的发送/跳过结果；数据库错误会在
      // 下一次正常操作或面板读取时暴露。
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof InitiativeError) {
    return /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code)
      ? error.code
      : 'initiative_error'
  }
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'initiative_failed'
}

function externalErrorCode(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,127}$/.test(value)
    ? value
    : 'external_delivery_failed'
}
