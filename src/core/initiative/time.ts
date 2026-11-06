/**
 * Initiative 使用的时区、安静时段和本地日边界。
 *
 * 边界：只依赖 Intl，不引入日期库；对不存在的本地时间 fail-closed，
 * 不静默舍入到另一个时刻。Asia/Shanghai 没有夏令时，但迁移到其他时区
 * 后仍必须显式暴露非法本地时间。
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

export interface LocalDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export function parseLocalClock(value: string, field: string): {
  hour: number
  minute: number
} {
  const match = CLOCK.exec(value)
  if (match === null) {
    throw new TypeError(`${field} must use HH:MM`)
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  }
}

export function localDateKey(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone)
  return formatDateKey(parts)
}

export function localTimeParts(
  date: Date,
  timezone: string,
): LocalDateTimeParts & { minuteOfDay: number } {
  const parts = zonedParts(date, timezone)
  return {
    ...parts,
    minuteOfDay: parts.hour * 60 + parts.minute,
  }
}

export function isQuietAt(
  now: Date,
  timezone: string,
  startValue: string,
  endValue: string,
): boolean {
  const start = parseLocalClock(startValue, 'quiet start')
  const end = parseLocalClock(endValue, 'quiet end')
  const current = localTimeParts(now, timezone).minuteOfDay
  const from = start.hour * 60 + start.minute
  const to = end.hour * 60 + end.minute
  return from < to
    ? current >= from && current < to
    : current >= from || current < to
}

/**
 * 当前处于安静时段时返回下一次结束时刻；否则返回 now。
 */
export function quietEndsAtOrAfter(
  now: Date,
  timezone: string,
  startValue: string,
  endValue: string,
): Date {
  if (!isQuietAt(now, timezone, startValue, endValue)) {
    return new Date(now.getTime())
  }
  const start = parseLocalClock(startValue, 'quiet start')
  const end = parseLocalClock(endValue, 'quiet end')
  const currentDay = localDateKey(now, timezone)
  const currentMinute = localTimeParts(now, timezone).minuteOfDay
  const endMinute = end.hour * 60 + end.minute
  const startMinute = start.hour * 60 + start.minute
  const targetDay =
    endMinute <= startMinute && currentMinute >= startMinute
      ? addLocalDays(currentDay, 1)
      : currentDay
  return localDateTimeToDate(targetDay, end.hour, end.minute, timezone)
}

export function addLocalDays(dateKey: string, days: number): string {
  const match = DATE_KEY.exec(dateKey)
  if (match === null) {
    throw new TypeError('dateKey must use YYYY-MM-DD')
  }
  if (!Number.isInteger(days)) {
    throw new TypeError('days must be an integer')
  }
  const value = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days,
  ))
  return formatDateKey({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  })
}

/**
 * 返回某个本地日历日的 UTC 半开区间 [start, end)。
 */
export function localDayRange(
  dateKey: string,
  timezone: string,
): { start: Date; end: Date } {
  return {
    start: localDateTimeToDate(dateKey, 0, 0, timezone),
    end: localDateTimeToDate(addLocalDays(dateKey, 1), 0, 0, timezone),
  }
}

export function localDateTimeToDate(
  dateKey: string,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const match = DATE_KEY.exec(dateKey)
  if (match === null) {
    throw new TypeError('dateKey must use YYYY-MM-DD')
  }
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new TypeError('local time must be a valid hour and minute')
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour,
    minute,
  }
  let guess = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  )
  // 两次迭代足够处理固定偏移和常见 DST；最后再严格比较，绝不接受
  // Intl 把这个本地时间映射到另一个时刻。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(guess), timezone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    )
    const desiredAsUtc = Date.UTC(
      desired.year,
      desired.month - 1,
      desired.day,
      desired.hour,
      desired.minute,
    )
    const difference = actualAsUtc - desiredAsUtc
    if (difference === 0) break
    guess -= difference
  }
  const final = zonedParts(new Date(guess), timezone)
  if (
    final.year !== desired.year ||
    final.month !== desired.month ||
    final.day !== desired.day ||
    final.hour !== desired.hour ||
    final.minute !== desired.minute
  ) {
    throw new RangeError(
      `local date-time ${dateKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} does not exist in ${timezone}`,
    )
  }
  return new Date(guess)
}

export function formatLocalClock(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone)
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

function zonedParts(date: Date, timezone: string): Omit<
  LocalDateTimeParts,
  never
> {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('date must be valid')
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = formatter.formatToParts(date)
  const values = new Map(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  )
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
  }
}

function formatDateKey(parts: {
  year: number
  month: number
  day: number
}): string {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-')
}
