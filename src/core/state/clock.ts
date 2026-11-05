/**
 * 唯一真实时钟接口。
 *
 * reducer 不读取这个接口；只有事件构造、快照节奏和备份调度可以使用。
 * 测试用固定时钟，不修改系统时间。
 */

export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export interface ManualClock extends Clock {
  set(iso: string): void
  advanceByMs(milliseconds: number): void
}

export function createManualClock(initialIso: string): ManualClock {
  let current = parseInstant(initialIso, 'initialIso')
  return {
    now(): Date {
      return new Date(current)
    },
    set(iso: string): void {
      current = parseInstant(iso, 'iso')
    },
    advanceByMs(milliseconds: number): void {
      if (!Number.isFinite(milliseconds)) {
        throw new TypeError('milliseconds must be finite')
      }
      current += milliseconds
    },
  }
}

export function parseInstant(value: string, field: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be a valid ISO timestamp`)
  }
  if (new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp`)
  }
  return milliseconds
}
