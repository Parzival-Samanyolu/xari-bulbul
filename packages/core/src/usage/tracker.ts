import fs from 'node:fs'
import path from 'node:path'
import type { ModelPricing, Usage } from '../types.js'

export interface UsageRecord {
  ts: number
  sessionId: string
  providerId: string
  modelId: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** USD; null when unknown (e.g. subscription providers with no pricing). */
  cost: number | null
}

export interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cost: number
  /** True if any request in this bucket had unknown cost. */
  costPartial: boolean
}

export interface UsageSummary {
  session: UsageTotals
  today: UsageTotals
  allTime: UsageTotals
  byModel: Record<string, UsageTotals>
  last?: UsageRecord
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costPartial: false }
}

function add(t: UsageTotals, r: UsageRecord) {
  t.requests++
  t.promptTokens += r.promptTokens
  t.completionTokens += r.completionTokens
  t.cachedTokens += r.cachedTokens
  if (r.cost == null) t.costPartial = true
  else t.cost += r.cost
}

export function computeCost(usage: Usage, pricing?: ModelPricing): number | null {
  if (typeof usage.cost === 'number') return usage.cost
  if (!pricing) return null
  return usage.promptTokens * pricing.prompt + usage.completionTokens * pricing.completion
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Records every model request. Persisted as append-only JSONL so totals survive restarts.
 * Pass `file: null` for in-memory only (tests, CLI).
 */
export class UsageTracker {
  private records: UsageRecord[] = []

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          this.records.push(JSON.parse(line))
        } catch {
          /* skip corrupt line */
        }
      }
    }
  }

  record(r: UsageRecord): void {
    this.records.push(r)
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, JSON.stringify(r) + '\n')
    }
  }

  summary(sessionId?: string, now = Date.now()): UsageSummary {
    const s: UsageSummary = { session: emptyTotals(), today: emptyTotals(), allTime: emptyTotals(), byModel: {} }
    const dayStart = startOfDay(now)
    for (const r of this.records) {
      add(s.allTime, r)
      if (r.ts >= dayStart) add(s.today, r)
      if (sessionId && r.sessionId === sessionId) add(s.session, r)
      const key = `${r.providerId}:${r.modelId}`
      add((s.byModel[key] ??= emptyTotals()), r)
    }
    s.last = this.records.at(-1)
    return s
  }

  /** Totals per local calendar day (YYYY-MM-DD), newest first. */
  byDay(): { day: string; totals: UsageTotals }[] {
    const map = new Map<string, UsageTotals>()
    for (const r of this.records) {
      const d = new Date(r.ts)
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!map.has(day)) map.set(day, emptyTotals())
      add(map.get(day)!, r)
    }
    return [...map].map(([day, totals]) => ({ day, totals })).sort((a, b) => b.day.localeCompare(a.day))
  }

  /** Totals for one chat, broken down by model. */
  bySession(sessionId: string): { total: UsageTotals; byModel: Record<string, UsageTotals> } {
    const total = emptyTotals()
    const byModel: Record<string, UsageTotals> = {}
    for (const r of this.records) {
      if (r.sessionId !== sessionId) continue
      add(total, r)
      add((byModel[`${r.providerId}:${r.modelId}`] ??= emptyTotals()), r)
    }
    return { total, byModel }
  }

  all(): readonly UsageRecord[] {
    return this.records
  }

  clear(): void {
    this.records = []
    if (this.file) fs.rmSync(this.file, { force: true })
  }

  toCsv(): string {
    const head = 'timestamp,session,provider,model,prompt_tokens,completion_tokens,cached_tokens,cost_usd'
    const rows = this.records.map((r) =>
      [new Date(r.ts).toISOString(), r.sessionId, r.providerId, r.modelId, r.promptTokens, r.completionTokens, r.cachedTokens, r.cost ?? ''].join(','),
    )
    return [head, ...rows].join('\n')
  }
}

export type BudgetStatus = { ok: true } | { ok: false; which: 'session' | 'daily'; limit: number; spent: number }

export function checkBudget(
  summary: UsageSummary,
  limits: { sessionBudgetUsd: number | null; dailyBudgetUsd: number | null },
): BudgetStatus {
  if (limits.sessionBudgetUsd != null && summary.session.cost >= limits.sessionBudgetUsd)
    return { ok: false, which: 'session', limit: limits.sessionBudgetUsd, spent: summary.session.cost }
  if (limits.dailyBudgetUsd != null && summary.today.cost >= limits.dailyBudgetUsd)
    return { ok: false, which: 'daily', limit: limits.dailyBudgetUsd, spent: summary.today.cost }
  return { ok: true }
}
