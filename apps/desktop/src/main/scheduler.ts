import fs from 'node:fs'
import { missedRun, nextRun, type Schedule } from '@harness/core'
import type { ScheduleStatus } from '../shared/ipc'

/** Run times per schedule id. `since` is when the schedule was first seen, the reference before its first run. */
type RunState = Record<string, { lastRunAt: number | null; since: number; error?: string }>

/** Timers longer than ~24.8 days overflow; wake at least hourly and re-check (also covers sleep and clock changes). */
const MAX_WAIT = 3_600_000

/**
 * Runs scheduled prompts while the app is open. One timer is armed for the soonest run.
 * At launch, `catchUp()` runs each schedule once if a run was missed while the app was closed.
 */
export class Scheduler {
  private state: RunState
  /** Next run per schedule id, with the `when` it was computed from. */
  private next = new Map<string, { at: number; key: string }>()
  private running = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly file: string,
    private readonly schedules: () => Schedule[],
    private readonly run: (s: Schedule) => Promise<void>,
    private readonly onChange: () => void,
  ) {
    this.state = this.load()
  }

  private load(): RunState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private save() {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error('Could not save schedule state:', e)
    }
  }

  private runnable(): Schedule[] {
    return this.schedules().filter((s) => s.enabled && s.cwd.trim() && s.prompt.trim())
  }

  /** Recomputes next runs for new or changed schedules and arms the timer for the soonest. */
  arm(now = Date.now()) {
    if (this.disposed) return
    const list = this.runnable()
    const ids = new Set(this.schedules().map((s) => s.id))
    let changed = false
    for (const id of Object.keys(this.state)) {
      if (!ids.has(id)) {
        delete this.state[id]
        changed = true
      }
    }
    for (const s of this.schedules()) {
      if (!this.state[s.id]) {
        this.state[s.id] = { lastRunAt: null, since: now }
        changed = true
      }
    }
    if (changed) this.save()
    for (const id of [...this.next.keys()]) if (!list.some((s) => s.id === id)) this.next.delete(id)
    for (const s of list) {
      const key = JSON.stringify(s.when)
      if (this.next.get(s.id)?.key === key) continue
      // Edits and launches look forward from now; missed runs are only caught up at launch.
      const st = this.state[s.id]
      this.next.set(s.id, { at: nextRun(s.when, Math.max(st.lastRunAt ?? st.since, now)), key })
    }
    this.rearm(now)
  }

  private rearm(now = Date.now()) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.disposed || !this.next.size) return
    const soonest = Math.min(...[...this.next.values()].map((n) => n.at))
    this.timer = setTimeout(() => this.tick(), Math.min(MAX_WAIT, Math.max(0, soonest - now)))
  }

  private tick() {
    this.timer = null
    const now = Date.now()
    for (const s of this.runnable()) {
      const n = this.next.get(s.id)
      if (n && n.at <= now) this.start(s, now)
    }
    this.rearm()
  }

  /** At launch: one run for each schedule that missed a run while the app was closed. */
  catchUp(now = Date.now()) {
    for (const s of this.runnable()) {
      const st = this.state[s.id]
      if (st && missedRun(s.when, st.lastRunAt ?? st.since, now)) this.start(s, now)
    }
    this.rearm()
  }

  runNow(id: string): boolean {
    const s = this.schedules().find((x) => x.id === id)
    if (!s || !s.cwd.trim() || !s.prompt.trim()) return false
    return this.start(s, Date.now())
  }

  /** Starts a run unless the previous run of the same schedule is still going. */
  private start(s: Schedule, now: number): boolean {
    if (this.disposed) return false
    const st = (this.state[s.id] ??= { lastRunAt: null, since: now })
    // The next slot counts from now, so a late or skipped run doesn't fire again right away.
    if (s.enabled) this.next.set(s.id, { at: nextRun(s.when, now), key: JSON.stringify(s.when) })
    if (this.running.has(s.id)) return false
    st.lastRunAt = now
    delete st.error
    this.save()
    this.running.add(s.id)
    this.onChange()
    this.run(s)
      .catch((e) => {
        st.error = (e as Error).message
        this.save()
      })
      .finally(() => {
        this.running.delete(s.id)
        this.onChange()
      })
    return true
  }

  status(): ScheduleStatus[] {
    return this.schedules().map((s) => ({
      id: s.id,
      lastRun: this.state[s.id]?.lastRunAt ?? null,
      nextRun: this.next.get(s.id)?.at ?? null,
      running: this.running.has(s.id),
      error: this.state[s.id]?.error ?? null,
    }))
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
