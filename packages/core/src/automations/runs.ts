import fs from 'node:fs'
import { blocked } from '../mail/presets.js'

export type RunTrigger = 'time' | 'manual' | 'mail' | 'chain' | 'chat'
export type RunStatus = 'running' | 'done' | 'failed'
export type DraftStatus = 'pending' | 'sending' | 'sent' | 'skipped' | 'failed'

/** An email an automation (or a chat) wrote. */
export interface MailDraft {
  id: string
  account: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  /** Message-ID and References of the email it answers. */
  inReplyTo?: string
  references?: string[]
  status: DraftStatus
  error?: string
  createdAt: number
  sentAt?: number
  /** Sent without review because the automation sends automatically. */
  auto?: boolean
}

/** One run in the Automations inbox. */
export interface AutomationRun {
  id: string
  /** The schedule's id; '' for drafts written in an ordinary chat. */
  automationId: string
  name: string
  sessionId: string
  trigger: RunTrigger
  startedAt: number
  finishedAt: number | null
  status: RunStatus
  error?: string
  /** The end of the run's last reply. */
  summary: string
  read: boolean
  drafts: MailDraft[]
}

const KEEP = 300
const DAY = 86_400_000

/** Why a draft may not go out automatically, or null when it may. */
export function autoSendBlock(
  d: Pick<MailDraft, 'to' | 'cc'>,
  o: { blocklist: readonly string[]; maxPerRun: number; maxPerDay: number; sentInRun: number; sentToday: number },
): string | null {
  const bad = [...d.to, ...d.cc].find((a) => blocked(a, o.blocklist))
  if (bad) return `${bad} is on the blocklist`
  if (o.sentInRun >= o.maxPerRun) return `this run already sent ${o.maxPerRun} (its limit)`
  if (o.sentToday >= o.maxPerDay) return `automations already sent ${o.maxPerDay} today (the daily limit)`
  return null
}

/** The runs, saved as one JSON file. Newest first. */
export class RunStore {
  private runs: AutomationRun[]

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.runs = this.load()
  }

  private load(): AutomationRun[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(raw)) return []
      // A run still "running" in the file was cut off when the app closed; so was an email still "sending".
      return (raw as AutomationRun[]).map((r): AutomationRun => ({
        ...r,
        ...(r.status === 'running' ? { status: 'failed', error: r.error ?? 'The app closed during the run.', finishedAt: r.finishedAt ?? r.startedAt } : {}),
        drafts: (r.drafts ?? []).map((d): MailDraft => (d.status === 'sending' ? { ...d, status: 'failed', error: 'The app closed while sending; check Sent before retrying.' } : d)),
      }))
    } catch {
      return []
    }
  }

  private save() {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.runs, null, 1))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error('Could not save automation runs:', e)
    }
  }

  list(): AutomationRun[] {
    return this.runs
  }

  get(id: string): AutomationRun | undefined {
    return this.runs.find((r) => r.id === id)
  }

  bySession(sessionId: string): AutomationRun | undefined {
    return this.runs.find((r) => r.sessionId === sessionId)
  }

  start(r: Pick<AutomationRun, 'automationId' | 'name' | 'sessionId' | 'trigger'>): AutomationRun {
    const run: AutomationRun = { ...r, id: `run-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, startedAt: this.now(), finishedAt: null, status: 'running', summary: '', read: false, drafts: [] }
    this.runs.unshift(run)
    this.prune()
    this.save()
    return run
  }

  finish(id: string, outcome: { status: 'done' | 'failed'; summary?: string; error?: string }) {
    const r = this.get(id)
    if (!r) return
    r.status = outcome.status
    r.finishedAt = this.now()
    if (outcome.summary != null) r.summary = outcome.summary
    if (outcome.error) r.error = outcome.error
    r.read = false
    this.save()
  }

  addDraft(runId: string, d: Omit<MailDraft, 'id' | 'status' | 'createdAt'>): MailDraft {
    const r = this.get(runId)
    if (!r) throw new Error('That run is gone.')
    const draft: MailDraft = { ...d, id: `d-${this.now().toString(36)}-${r.drafts.length}`, status: 'pending', createdAt: this.now() }
    r.drafts.push(draft)
    r.read = false
    this.save()
    return draft
  }

  draft(runId: string, draftId: string): MailDraft {
    const d = this.get(runId)?.drafts.find((x) => x.id === draftId)
    if (!d) throw new Error('That draft is gone.')
    return d
  }

  updateDraft(runId: string, draftId: string, patch: Partial<Pick<MailDraft, 'to' | 'cc' | 'subject' | 'body' | 'status' | 'error' | 'sentAt' | 'auto'>>): MailDraft {
    const d = this.draft(runId, draftId)
    if (d.status === 'sent' && patch.status !== 'sent') throw new Error('That email was already sent.')
    Object.assign(d, patch)
    if (patch.status && patch.status !== 'failed') delete d.error
    this.save()
    return d
  }

  /** Emails sent automatically in the last 24 hours, across all runs. */
  autoSentToday(): number {
    const since = this.now() - DAY
    let n = 0
    for (const r of this.runs) for (const d of r.drafts) if (d.status === 'sent' && d.auto && (d.sentAt ?? 0) >= since) n++
    return n
  }

  sentIn(runId: string): number {
    return this.get(runId)?.drafts.filter((d) => d.status === 'sent' && d.auto).length ?? 0
  }

  markRead(id: string | 'all') {
    for (const r of this.runs) if (id === 'all' || r.id === id) r.read = true
    this.save()
  }

  remove(id: string) {
    this.runs = this.runs.filter((r) => r.id !== id)
    this.save()
  }

  /** Runs that want attention: unread, or with drafts waiting. */
  unread(): number {
    return this.runs.filter((r) => !r.read || r.drafts.some((d) => d.status === 'pending')).length
  }

  /** Drops the oldest runs past KEEP, but never one with drafts still waiting. */
  private prune() {
    if (this.runs.length <= KEEP) return
    const keep: AutomationRun[] = []
    for (const r of this.runs) if (keep.length < KEEP || r.drafts.some((d) => d.status === 'pending')) keep.push(r)
    this.runs = keep
  }
}

/** The run's summary: the end of the last assistant reply, as plain text. */
export function runSummary(reply: string, max = 600): string {
  const text = reply.replace(/```[\s\S]*?```/g, '').replace(/[#*_`>]+/g, '').replace(/\n{2,}/g, '\n').trim()
  return text.length > max ? `…${text.slice(-max)}` : text
}
