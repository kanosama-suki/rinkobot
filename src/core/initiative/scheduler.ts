/**
 * 唯一的主动性调度循环。
 *
 * 边界：
 * - 整个运行时只创建一个 interval；不为计划、提醒或 outbox 另开定时器；
 * - 一个 tick 未结束时跳过下一次，避免重入和重复投递；
 * - dispose 会 abort 正在进行的模型调用并清掉唯一 timer。
 */

import type { InitiativeServiceLike } from './types.ts'

export interface InitiativeSchedulerLogger {
  info(message: string): void
  error?(message: string): void
}

export interface InitiativeSchedulerOptions {
  service: InitiativeServiceLike
  intervalMs: number
  logger: InitiativeSchedulerLogger
}

export class InitiativeScheduler {
  readonly startedAt: string

  private readonly service: InitiativeServiceLike
  private readonly intervalMs: number
  private readonly logger: InitiativeSchedulerLogger
  private timer: NodeJS.Timeout | null = null
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private disposed = false
  private ticks = 0

  constructor(options: InitiativeSchedulerOptions) {
    if (
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs < 10_000 ||
      options.intervalMs > 3_600_000
    ) {
      throw new RangeError(
        'initiative intervalMs must be an integer between 10000 and 3600000',
      )
    }
    this.service = options.service
    this.intervalMs = options.intervalMs
    this.logger = options.logger
    this.startedAt = new Date().toISOString()
  }

  start(): void {
    if (this.disposed) {
      throw new Error('initiative scheduler has been disposed')
    }
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.tickNow()
    }, this.intervalMs)
    this.timer.unref()
  }

  async tickNow(): Promise<void> {
    if (this.disposed) return
    if (this.running !== null) return
    this.controller = new AbortController()
    this.running = this.runTick(this.controller.signal)
    try {
      await this.running
    } finally {
      this.running = null
      this.controller = null
    }
  }

  async dispose(): Promise<void> {
    this.stop()
    if (this.running !== null) {
      await this.running.catch(() => {})
    }
  }

  /**
   * 供同步宿主清理使用的快速路径。返回 true 时已经没有在途 tick，
   * 调用方可以立即关闭数据库；返回 false 时必须等待 dispose()。
   */
  disposeSync(): boolean {
    this.stop()
    return this.running === null
  }

  tickCount(): number {
    return this.ticks
  }

  /**
   * 健康检查读取的运行状态。start() 重复调用不会创建第二个 timer；
   * dispose 或 stop 后必须报告 stopped。
   */
  isRunning(): boolean {
    return !this.disposed && this.timer !== null
  }

  private async runTick(signal: AbortSignal): Promise<void> {
    this.ticks += 1
    try {
      const result = await this.service.tick(signal)
      if (result.status === 'stopped') {
        this.logger.info('[kanobot] initiative tick skipped: emergency stopped')
      }
    } catch (error) {
      if (isAbortError(error) && this.disposed) return
      const message = error instanceof Error ? error.message : String(error)
      if (this.logger.error) {
        this.logger.error(`[kanobot] initiative tick failed: ${message}`)
      } else {
        this.logger.info(`[kanobot] initiative tick failed: ${message}`)
      }
    }
  }

  private stop(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.controller?.abort()
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
