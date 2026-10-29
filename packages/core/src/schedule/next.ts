/** When a schedule runs. Times are local wall-clock times, so 09:00 stays 09:00 across DST changes. */
export interface ScheduleWhen {
  kind: 'daily' | 'weekly' | 'interval'
  /** "HH:MM", local time (daily and weekly). */
  time?: string
  /** 0 = Sunday … 6 = Saturday (weekly). */
  weekday?: number
  /** Hours between runs (interval); fractions allowed, at least one minute. */
  hours?: number
}

const HOUR = 3_600_000
const MIN_INTERVAL = 60_000

export function parseTime(time: string | undefined): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time?.trim() ?? '')
  const h = match ? Number(match[1]) : NaN
  const m = match ? Number(match[2]) : NaN
  return h >= 0 && h < 24 && m >= 0 && m < 60 ? { h, m } : { h: 9, m: 0 }
}

export function intervalMs(when: ScheduleWhen): number {
  const ms = (when.hours ?? 24) * HOUR
  return Number.isFinite(ms) ? Math.max(MIN_INTERVAL, ms) : 24 * HOUR
}

/**
 * The first run strictly after `after` (ms). For intervals that is `after` plus the interval,
 * so pass the last run (or when the schedule was first seen).
 */
export function nextRun(when: ScheduleWhen, after: number): number {
  if (when.kind === 'interval') return after + intervalMs(when)
  const { h, m } = parseTime(when.time)
  const d = new Date(after)
  // Move by calendar days and set the wall-clock time each time, never add 24h: DST days are 23 or 25 hours.
  const at = (dayOffset: number) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset)
    x.setHours(h, m, 0, 0)
    return x.getTime()
  }
  if (when.kind === 'weekly') {
    const weekday = Number.isInteger(when.weekday) && when.weekday! >= 0 && when.weekday! <= 6 ? when.weekday! : 1
    const offset = (weekday - d.getDay() + 7) % 7
    const t = at(offset)
    return t > after ? t : at(offset + 7)
  }
  const t = at(0)
  return t > after ? t : at(1)
}

/**
 * Whether a run was missed while the app was closed: a slot fell between the last run
 * (or when the schedule was first seen) and now. However many slots were missed, this
 * is one catch-up run; after it, the last run is now and nothing is missed.
 */
export function missedRun(when: ScheduleWhen, lastRunAt: number, now: number): boolean {
  return nextRun(when, lastRunAt) <= now
}
