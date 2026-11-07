/**
 * 跨会话共享的模型调用预算。
 *
 * 网页和 QQ 会各自创建聊天服务；如果每个服务单独计数，多个 QQ 会话
 * 就能绕过全局并发上限，也会在视觉调用与聊天调用之间超卖每日额度。
 * 这里只维护内存中的“正在执行的回合”和“尚未写入审计行的预留调用”，
 * 已落库的调用仍由存储层按本地日统计。
 */

export const DEFAULT_MAX_CONCURRENT_MODEL_CALLS = 2
export const DEFAULT_DAILY_MODEL_CALL_LIMIT = 2_000

export type ModelBudgetFailure =
  | 'model_capacity_reached'
  | 'daily_model_call_limit_reached'

export interface ChatModelBudgetOptions {
  maxConcurrentModelCalls?: number
  dailyModelCallLimit?: number
}

export interface ChatModelBudgetSnapshot {
  activeModelCalls: number
  reservedModelCalls: number
  maxConcurrentModelCalls: number
  dailyModelCallLimit: number
}

export class ChatModelBudget {
  readonly maxConcurrentModelCalls: number
  readonly dailyModelCallLimit: number
  private activeModelCalls = 0
  private reservedModelCalls = 0

  constructor(options: ChatModelBudgetOptions = {}) {
    this.maxConcurrentModelCalls =
      options.maxConcurrentModelCalls ??
      DEFAULT_MAX_CONCURRENT_MODEL_CALLS
    this.dailyModelCallLimit =
      options.dailyModelCallLimit ?? DEFAULT_DAILY_MODEL_CALL_LIMIT
    if (
      !Number.isInteger(this.maxConcurrentModelCalls) ||
      this.maxConcurrentModelCalls < 1 ||
      this.maxConcurrentModelCalls > 8
    ) {
      throw new RangeError(
        'maxConcurrentModelCalls must be an integer between 1 and 8',
      )
    }
    if (
      !Number.isInteger(this.dailyModelCallLimit) ||
      this.dailyModelCallLimit < 1
    ) {
      throw new RangeError('dailyModelCallLimit must be a positive integer')
    }
  }

  /**
   * 为一个逻辑聊天回合原子地占用并发槽和每日调用预留。
   * 成功返回 null；失败不改变任何计数。
   */
  beginTurn(
    requiredCalls: number,
    callsUsedToday: number,
  ): ModelBudgetFailure | null {
    validateReservation(requiredCalls, callsUsedToday)
    if (this.activeModelCalls >= this.maxConcurrentModelCalls) {
      return 'model_capacity_reached'
    }
    if (
      callsUsedToday + this.reservedModelCalls + requiredCalls >
      this.dailyModelCallLimit
    ) {
      return 'daily_model_call_limit_reached'
    }
    this.activeModelCalls += 1
    this.reservedModelCalls += requiredCalls
    return null
  }

  /**
   * 回合内部的额外调用（例如风格重写）只检查每日额度；它沿用已经持有
   * 的并发槽，不能因为一次重写就占用第二个并发位置。
   */
  reserveAdditionalCall(callsUsedToday: number): boolean {
    validateCallsUsedToday(callsUsedToday)
    if (
      callsUsedToday + this.reservedModelCalls + 1 >
      this.dailyModelCallLimit
    ) {
      return false
    }
    this.reservedModelCalls += 1
    return true
  }

  /** 预留转成真实审计行时调用；调用失败时由 finishTurn 统一释放。 */
  beginReservedCall(): void {
    if (this.reservedModelCalls < 1) {
      throw new RangeError('model budget has no reservation to consume')
    }
    this.reservedModelCalls -= 1
  }

  /** 结束回合并释放未消费的每日预留。 */
  finishTurn(remainingReservedCalls = 0): void {
    if (this.activeModelCalls < 1) {
      throw new RangeError('model budget has no active turn to finish')
    }
    if (
      !Number.isSafeInteger(remainingReservedCalls) ||
      remainingReservedCalls < 0 ||
      remainingReservedCalls > this.reservedModelCalls
    ) {
      throw new RangeError('remainingReservedCalls exceeds the shared budget')
    }
    this.activeModelCalls -= 1
    this.reservedModelCalls -= remainingReservedCalls
  }

  snapshot(): ChatModelBudgetSnapshot {
    return {
      activeModelCalls: this.activeModelCalls,
      reservedModelCalls: this.reservedModelCalls,
      maxConcurrentModelCalls: this.maxConcurrentModelCalls,
      dailyModelCallLimit: this.dailyModelCallLimit,
    }
  }
}

function validateReservation(
  requiredCalls: number,
  callsUsedToday: number,
): void {
  if (!Number.isSafeInteger(requiredCalls) || requiredCalls < 1) {
    throw new RangeError('requiredCalls must be a positive safe integer')
  }
  validateCallsUsedToday(callsUsedToday)
}

function validateCallsUsedToday(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('callsUsedToday must be a non-negative safe integer')
  }
}
