import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { missedRun, nextRun, parseTime } from '../src/schedule/next.js'
import { parseSettings } from '../src/settings/schema.js'

// Local-time math depends on the zone; pin one with DST (US: 2026-03-08 spring forward, 2026-11-01 fall back).
const prevTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ
  else process.env.TZ = prevTz
})

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const HOUR = 3_600_000

describe('nextRun', () => {
  it('daily: later today, or tomorrow once the time has passed', () => {
    expect(nextRun({ kind: 'daily', time: '09:00' }, local(2026, 10, 29, 8, 0))).toBe(local(2026, 10, 29, 9, 0))
    expect(nextRun({ kind: 'daily', time: '09:00' }, local(2026, 10, 29, 9, 0))).toBe(local(2026, 10, 30, 9, 0))
    expect(nextRun({ kind: 'daily', time: '09:00' }, local(2026, 10, 29, 12, 0))).toBe(local(2026, 10, 30, 9, 0))
    // Month and year rollover.
    expect(nextRun({ kind: 'daily', time: '00:30' }, local(2026, 12, 31, 23, 0))).toBe(local(2027, 1, 1, 0, 30))
  })

  it('daily keeps the wall-clock time across DST changes', () => {
    const spring = nextRun({ kind: 'daily', time: '09:00' }, local(2026, 3, 7, 10, 0))
    expect(new Date(spring).getDate()).toBe(8)
    expect(new Date(spring).getHours()).toBe(9)
    expect(spring - local(2026, 3, 7, 10, 0)).toBe(22 * HOUR) // a 23-hour day
    const fall = nextRun({ kind: 'daily', time: '09:00' }, local(2026, 10, 31, 9, 0))
    expect(new Date(fall).getHours()).toBe(9)
    expect(fall - local(2026, 10, 31, 9, 0)).toBe(25 * HOUR)
    // 02:30 doesn't exist on the spring-forward day; the run still happens that day, just after the gap.
    const gap = nextRun({ kind: 'daily', time: '02:30' }, local(2026, 3, 8, 0, 0))
    expect(new Date(gap).getDate()).toBe(8)
    expect(gap).toBeGreaterThan(local(2026, 3, 8, 0, 0))
  })

  it('weekly: the next matching weekday', () => {
    // 2026-10-29 is a Thursday (4).
    expect(new Date(local(2026, 10, 29)).getDay()).toBe(4)
    expect(nextRun({ kind: 'weekly', weekday: 1, time: '08:00' }, local(2026, 10, 29, 12))).toBe(local(2026, 11, 2, 8))
    expect(nextRun({ kind: 'weekly', weekday: 4, time: '13:00' }, local(2026, 10, 29, 12))).toBe(local(2026, 10, 29, 13))
    expect(nextRun({ kind: 'weekly', weekday: 4, time: '11:00' }, local(2026, 10, 29, 12))).toBe(local(2026, 11, 5, 11))
  })

  it('interval: the last run plus the interval, at least a minute', () => {
    const t = local(2026, 10, 29, 12)
    expect(nextRun({ kind: 'interval', hours: 6 }, t)).toBe(t + 6 * HOUR)
    expect(nextRun({ kind: 'interval', hours: 1 / 60 }, t)).toBe(t + 60_000)
    expect(nextRun({ kind: 'interval', hours: 0.0001 }, t)).toBe(t + 60_000)
  })

  it('falls back to 09:00 for a bad time', () => {
    expect(parseTime('25:00')).toEqual({ h: 9, m: 0 })
    expect(parseTime('7:05')).toEqual({ h: 7, m: 5 })
    expect(parseTime(undefined)).toEqual({ h: 9, m: 0 })
  })
})

describe('missedRun', () => {
  it('catches up once, however many slots were missed', () => {
    const daily = { kind: 'daily' as const, time: '09:00' }
    const last = local(2026, 10, 20, 9, 0)
    const now = local(2026, 10, 29, 12, 0) // nine slots later
    expect(missedRun(daily, last, now)).toBe(true)
    // The catch-up run happens now; nothing is missed after it, and the next run is tomorrow's slot.
    expect(missedRun(daily, now, now)).toBe(false)
    expect(nextRun(daily, now)).toBe(local(2026, 10, 30, 9, 0))
  })

  it('nothing is missed before the first slot', () => {
    const now = local(2026, 10, 29, 12, 0)
    expect(missedRun({ kind: 'daily', time: '09:00' }, local(2026, 10, 29, 10, 0), now)).toBe(false)
    expect(missedRun({ kind: 'interval', hours: 4 }, local(2026, 10, 29, 10, 0), now)).toBe(false)
    expect(missedRun({ kind: 'interval', hours: 1 }, local(2026, 10, 29, 10, 0), now)).toBe(true)
  })
})

describe('schedules setting', () => {
  it('fills defaults and keeps other settings when one schedule is malformed', () => {
    const s = parseSettings({ schedules: [{ id: 'a', cwd: '/tmp', prompt: 'hi' }] })
    expect(s.schedules[0]).toMatchObject({ name: 'Schedule', enabled: true, model: null, when: { kind: 'daily', time: '09:00', weekday: 1, hours: 24 } })
    const bad = parseSettings({ schedules: [{ id: '' }], appearance: { fontSize: 16 } })
    expect(bad.schedules).toEqual([])
    expect(bad.appearance.fontSize).toBe(16)
  })
})
