import fs from 'node:fs'
import path from 'node:path'
import {
  autoSendBlock,
  blocked,
  bareAddress,
  MailClient,
  mailSecretId,
  notesSecretId,
  NotesHub,
  parseMailId,
  RunStore,
  type DraftInput,
  type DraftOutcome,
  type MailAccess,
  type MailAccount,
  type MailDraft,
  type MailMessage,
  type MailSummary,
  type NotesAccess,
  type RunTrigger,
  type Schedule,
  type Settings,
} from '@harness/core'
import { EDITION } from '../shared/edition'
import { log } from './logger'

export interface AutomationDeps {
  dataDir: string
  settings: () => Settings
  secret: (id: string) => string | undefined
  /** Starts an automation through the scheduler (which never overlaps two runs of one automation). False if it didn't start. */
  trigger: (automationId: string, why: RunTrigger, extra?: string) => boolean
  onChange: () => void
}

/** Where each mail-triggered automation left off: the newest UID it has seen. */
type MailWatch = Record<string, { key: string; lastUid: number; checkedAt: number }>

const TICK = 60_000

/**
 * The Automations inbox and the mail around it: which accounts and notes a chat may use, drafts
 * waiting for review, sending (on click, or right away for automations set to send automatically),
 * and new-mail triggers.
 */
export class Automations {
  readonly runs: RunStore
  private watch: MailWatch
  private timer: NodeJS.Timeout | null = null
  private checking = false

  constructor(private readonly d: AutomationDeps) {
    this.runs = new RunStore(path.join(d.dataDir, 'automation-runs.json'))
    this.watch = this.loadWatch()
  }

  private get file() {
    return path.join(this.d.dataDir, 'mail-triggers.json')
  }

  private loadWatch(): MailWatch {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private saveWatch() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.watch, null, 1))
    } catch (e) {
      log.warn('automations', `Could not save mail triggers: ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- accounts

  /** Enabled accounts with a saved password; for an automation, only the ones it lists (none listed = all). */
  accounts(only: readonly string[] = []): MailAccount[] {
    // Mail and notes are Qaqaş features; Xarı Bülbül's automations are for code.
    if (!EDITION.features.mail) return []
    return this.d.settings().mail.accounts.filter((a) => a.enabled && a.address.trim() && this.d.secret(mailSecretId(a.id)) && (!only.length || only.includes(a.id)))
  }

  private client(a: MailAccount): MailClient {
    const pw = this.d.secret(mailSecretId(a.id))
    if (!pw) throw new Error(`No password saved for ${a.name}.`)
    return new MailClient(a, pw)
  }

  private account(id: string): MailAccount {
    const a = this.d.settings().mail.accounts.find((x) => x.id === id)
    if (!a) throw new Error(`No mail account "${id}".`)
    return a
  }

  async testAccount(id: string): Promise<void> {
    await this.client(this.account(id)).test()
  }

  // ---------------------------------------------------------------- what a chat sees

  /**
   * The mail tools' access for one chat. `schedule` is set for automation runs: its account list,
   * and whether it sends automatically. Ordinary chats' drafts always wait for review.
   */
  mailFor(sessionId: string, schedule: Schedule | null, title: () => string): MailAccess | undefined {
    const allowed = () => this.accounts(schedule?.mailAccounts ?? [])
    if (!allowed().length) return undefined
    const pick = (id?: string) => {
      const list = allowed()
      const a = id ? list.find((x) => x.id === id) : list[0]
      if (!a) throw new Error(`Account "${id}" isn't available here. Accounts: ${list.map((x) => `${x.id} (${x.address})`).join(', ') || 'none'}.`)
      return a
    }
    return {
      accounts: () => allowed().map((a) => ({ id: a.id, name: a.name, address: a.address })),
      search: async (q, signal) => {
        const list = q.account ? [pick(q.account)] : allowed()
        const out: MailSummary[] = []
        const errors: string[] = []
        for (const a of list) {
          try {
            out.push(...(await this.client(a).search(q, signal)))
          } catch (e) {
            errors.push(`${a.name}: ${(e as Error).message}`)
          }
        }
        if (!out.length && errors.length) throw new Error(errors.join('\n'))
        return out.sort((x, y) => y.date.localeCompare(x.date)).slice(0, q.limit ?? 20)
      },
      read: async (id, signal) => {
        const { account, folder, uid } = parseMailId(id)
        return this.client(pick(account)).read(folder, uid, signal)
      },
      draft: (input) => this.draft(sessionId, schedule, title, input, pick),
    }
  }

  notesFor(schedule: Schedule | null): NotesAccess | undefined {
    if (!EDITION.features.mail) return undefined
    const only = schedule?.notes ?? []
    const sources = this.d.settings().notes.sources.filter((s) => s.enabled && (!only.length || only.includes(s.id)))
    if (!sources.length) return undefined
    return new NotesHub(sources, { secret: (id) => this.d.secret(notesSecretId(id)) })
  }

  /** The inbox entry a chat's drafts go to: the automation's run, or one made for the chat on its first draft. */
  private runFor(sessionId: string, title: () => string) {
    return this.runs.bySession(sessionId) ?? this.chatRun(sessionId, title())
  }

  private chatRun(sessionId: string, name: string) {
    const run = this.runs.start({ automationId: '', name: name || 'Chat', sessionId, trigger: 'chat' })
    this.runs.finish(run.id, { status: 'done' })
    return run
  }

  private async draft(sessionId: string, schedule: Schedule | null, title: () => string, input: DraftInput, pick: (id?: string) => MailAccount): Promise<DraftOutcome> {
    let original: MailMessage | null = null
    let account: MailAccount
    if (input.replyTo) {
      const ref = parseMailId(input.replyTo)
      account = pick(input.account ?? ref.account)
      original = await this.client(pick(ref.account)).read(ref.folder, ref.uid)
    } else account = pick(input.account)
    const to = input.to.length ? input.to : original ? [bareAddress(original.from)].filter((a): a is string => !!a) : []
    if (!to.length) return { status: 'refused', message: 'No recipient: give `to`.' }
    const subject = input.subject.trim() || (original ? (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`) : '')
    if (!subject) return { status: 'refused', message: 'Give the email a subject.' }
    const settings = this.d.settings()
    const run = this.runFor(sessionId, title)
    const draft = this.runs.addDraft(run.id, {
      account: account.id,
      to,
      cc: input.cc,
      subject,
      body: input.body,
      inReplyTo: original?.messageId || undefined,
      references: original ? [...original.references, original.messageId].filter(Boolean) : undefined,
      disclose: schedule?.send.discloseAi ?? false,
    })
    this.d.onChange()
    const review = `Saved to the Automations inbox for the user to review and send (to ${to.join(', ')}). Don't ask the user to send it or repeat it; they'll see it there.`
    if (schedule?.send.mode !== 'auto') return { status: 'pending', message: review }
    const why = autoSendBlock(draft, {
      blocklist: settings.mail.blocklist,
      maxPerRun: schedule.send.maxPerRun,
      maxPerDay: schedule.send.maxPerDay,
      sentInRun: this.runs.sentIn(run.id),
      sentToday: this.runs.autoSentToday(),
    })
    if (why) return { status: 'pending', message: `Not sent automatically because ${why}. ${review}` }
    try {
      await this.deliver(run.id, draft, true)
      return { status: 'sent', message: `Sent to ${to.join(', ')}.` }
    } catch (e) {
      return { status: 'pending', message: `Sending failed (${(e as Error).message}). It waits in the Automations inbox to retry.` }
    }
  }

  // ---------------------------------------------------------------- sending

  private async deliver(runId: string, draft: MailDraft, auto: boolean) {
    const bad = [...draft.to, ...draft.cc].find((a) => blocked(a, this.d.settings().mail.blocklist))
    if (bad) throw new Error(`${bad} is on the blocklist.`)
    this.runs.updateDraft(runId, draft.id, { status: 'sending' })
    this.d.onChange()
    try {
      const footer = draft.disclose ? this.d.settings().mail.aiDisclosure : undefined
      await this.client(this.account(draft.account)).send({ to: draft.to, cc: draft.cc, subject: draft.subject, text: draft.body, inReplyTo: draft.inReplyTo, references: draft.references, footer })
      this.runs.updateDraft(runId, draft.id, { status: 'sent', sentAt: Date.now(), auto })
      log.info('automations', 'Email sent', { auto, recipients: draft.to.length + draft.cc.length })
    } catch (e) {
      this.runs.updateDraft(runId, draft.id, { status: 'failed', error: (e as Error).message })
      log.warn('automations', `Email failed: ${(e as Error).message.slice(0, 200)}`)
      throw e
    } finally {
      this.d.onChange()
    }
  }

  /** Send on the user's click (after their edits, if any). */
  async send(runId: string, draftId: string): Promise<void> {
    const d = this.runs.draft(runId, draftId)
    if (d.status === 'sent' || d.status === 'sending') return
    await this.deliver(runId, d, false)
  }

  /** Sends every draft still waiting in a run, one at a time; returns how many failed. */
  async sendAll(runId: string): Promise<number> {
    let failed = 0
    for (const d of this.runs.get(runId)?.drafts ?? []) {
      if (d.status !== 'pending' && d.status !== 'failed') continue
      await this.deliver(runId, d, false).catch(() => failed++)
    }
    return failed
  }

  edit(runId: string, draftId: string, patch: { to?: string[]; cc?: string[]; subject?: string; body?: string; disclose?: boolean }) {
    this.runs.updateDraft(runId, draftId, patch)
  }

  skip(runId: string, draftId: string) {
    this.runs.updateDraft(runId, draftId, { status: 'skipped' })
  }

  // ---------------------------------------------------------------- new-mail triggers

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.checkMail(), TICK)
    setTimeout(() => void this.checkMail(), 10_000)
  }

  /** Checks each mail-triggered automation that is due; the first check only notes where the inbox is. */
  async checkMail(now = Date.now()) {
    if (this.checking) return
    this.checking = true
    try {
      const list = this.d.settings().schedules.filter((s) => s.enabled && s.trigger === 'mail' && s.mailTrigger.account && s.cwd.trim() && s.prompt.trim())
      const ids = new Set(list.map((s) => s.id))
      for (const id of Object.keys(this.watch)) if (!ids.has(id)) delete this.watch[id]
      for (const s of list) {
        const key = `${s.mailTrigger.account}|${s.mailTrigger.folder}`
        const w = this.watch[s.id]
        if (w && w.key === key && now - w.checkedAt < s.mailTrigger.everyMinutes * 60_000 - 5000) continue
        try {
          const client = this.client(this.account(s.mailTrigger.account))
          const folder = s.mailTrigger.folder || 'INBOX'
          if (!w || w.key !== key) {
            this.watch[s.id] = { key, lastUid: await client.latestUid(folder), checkedAt: now }
            continue
          }
          w.checkedAt = now
          const fresh = await client.newSince(folder, w.lastUid, s.mailTrigger.from.trim())
          if (!fresh.length) continue
          const list = fresh.map((m) => `- ${m.id} · From: ${m.from} · Subject: ${m.subject}`).join('\n')
          const extra = `New email that started this run (read each with mail_read):\n${list}`
          // Only move past these messages once a run has them; a run still going picks them up next time.
          if (this.d.trigger(s.id, 'mail', extra)) w.lastUid = Math.max(w.lastUid, ...fresh.map((m) => parseMailId(m.id).uid))
        } catch (e) {
          log.warn('automations', `Mail check failed: ${(e as Error).message.slice(0, 200)}`, { automation: s.id })
        }
      }
      this.saveWatch()
    } finally {
      this.checking = false
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
