import type { ConnectionOptions } from 'node:tls'
import { ImapFlow, type SearchObject } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { MailAccount } from '../settings/schema.js'
import { mailId, type MailMessage, type MailSearch, type MailSummary } from './types.js'

const TIMEOUT = 30_000
const MAX_TEXT = 20_000

/** An email ready to go out. */
export interface OutgoingMail {
  to: string[]
  cc: string[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

const addr = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a.map((x) => x.text).join(', ') : (a?.text ?? ''))

/** Plain text for the model: the text part, else the HTML with tags taken out. */
export function messageText(text: string | undefined, html: string | false | undefined): string {
  let out = text?.trim() || (html ? htmlToText(html) : '')
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}\n… [cut at ${MAX_TEXT} characters]` : out
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** The IMAP search for a MailSearch. Several words must all appear. */
export function imapQuery(q: MailSearch): SearchObject {
  const s: SearchObject = {}
  if (q.unreadOnly) s.seen = false
  if (q.from?.trim()) s.from = q.from.trim()
  if (q.to?.trim()) s.to = q.to.trim()
  if (q.since?.trim()) {
    const d = new Date(`${q.since.trim()}T00:00:00`)
    if (!Number.isNaN(d.getTime())) s.since = d
  }
  if (q.query?.trim()) s.body = q.query.trim()
  if (!Object.keys(s).length) s.all = true
  return s
}

/** Talks to one account. Each call opens its own connection, so nothing stays logged in between runs. */
export class MailClient {
  constructor(
    private readonly account: MailAccount,
    private readonly password: string,
    /** TLS options for both servers; tests use this to trust a local self-signed certificate. */
    private readonly tls?: ConnectionOptions,
  ) {}

  private get user() {
    return this.account.username.trim() || this.account.address.trim()
  }

  private async imap<T>(fn: (c: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { host, port, secure } = this.account.imap
    if (!host) throw new Error(`${this.account.name} has no IMAP server set.`)
    const c = new ImapFlow({ host, port, secure, auth: { user: this.user, pass: this.password }, tls: this.tls, logger: false, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 2 * TIMEOUT })
    c.on('error', () => {})
    const abort = () => void c.close()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await c.connect()
      return await fn(c)
    } catch (e) {
      throw new Error(friendlyError(e as Error, 'IMAP'))
    } finally {
      signal?.removeEventListener('abort', abort)
      await c.logout().catch(() => c.close())
    }
  }

  /** Newest first. */
  async search(q: MailSearch, signal?: AbortSignal): Promise<MailSummary[]> {
    const folder = q.folder?.trim() || 'INBOX'
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100)
    return this.imap(async (c) => {
      const lock = await c.getMailboxLock(folder)
      try {
        const uids = ((await c.search(imapQuery(q), { uid: true })) || []).sort((a, b) => b - a).slice(0, limit)
        if (!uids.length) return []
        const out: MailSummary[] = []
        for await (const m of c.fetch(uids, { uid: true, envelope: true, flags: true, bodyParts: ['1'] }, { uid: true })) {
          const env = m.envelope
          const part = m.bodyParts?.get('1')?.toString('utf8') ?? ''
          out.push({
            id: mailId(this.account.id, folder, m.uid),
            account: this.account.id,
            from: env?.from?.map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ''))).join(', ') ?? '',
            to: env?.to?.map((a) => a.address ?? '').join(', ') ?? '',
            subject: env?.subject ?? '',
            date: env?.date ? new Date(env.date).toISOString() : '',
            unread: !m.flags?.has('\\Seen'),
            snippet: htmlToText(part).replace(/\s+/g, ' ').slice(0, 160),
          })
        }
        return out.sort((a, b) => b.date.localeCompare(a.date))
      } finally {
        lock.release()
      }
    }, signal)
  }

  async read(folder: string, uid: number, signal?: AbortSignal): Promise<MailMessage> {
    return this.imap(async (c) => {
      const lock = await c.getMailboxLock(folder)
      try {
        const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true })
        if (!m || !m.source) throw new Error(`No message ${uid} in ${folder}.`)
        const p = await simpleParser(m.source)
        const text = messageText(p.text, p.html)
        const refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : []
        return {
          id: mailId(this.account.id, folder, uid),
          account: this.account.id,
          from: addr(p.from),
          to: addr(p.to),
          cc: addr(p.cc),
          subject: p.subject ?? '',
          date: p.date ? p.date.toISOString() : '',
          unread: !m.flags?.has('\\Seen'),
          snippet: text.replace(/\s+/g, ' ').slice(0, 160),
          text,
          messageId: p.messageId ?? '',
          references: refs,
        }
      } finally {
        lock.release()
      }
    }, signal)
  }

  /** The highest UID in the folder now, the starting point for "new mail since". */
  async latestUid(folder = 'INBOX'): Promise<number> {
    return this.imap(async (c) => {
      const box = await c.mailboxOpen(folder, { readOnly: true })
      return Math.max(0, Number(box.uidNext) - 1)
    })
  }

  /** Messages that arrived after `afterUid`, oldest first. */
  async newSince(folder: string, afterUid: number, from = ''): Promise<MailSummary[]> {
    const all = await this.search({ folder, from: from || undefined, limit: 100 })
    return all.filter((m) => Number(m.id.slice(m.id.lastIndexOf('/') + 1)) > afterUid).reverse()
  }

  /** Sends, then files a copy in Sent where the server doesn't do that itself (Gmail does). Returns the Message-ID. */
  async send(mail: OutgoingMail): Promise<string> {
    const { host, port, secure } = this.account.smtp
    if (!host) throw new Error(`${this.account.name} has no SMTP server set.`)
    const sig = this.account.signature.trim()
    const opts = {
      from: { name: this.account.fromName.trim() || this.account.name, address: this.account.address.trim() },
      to: mail.to,
      cc: mail.cc.length ? mail.cc : undefined,
      subject: mail.subject,
      text: sig ? `${mail.text.trimEnd()}\n\n-- \n${sig}\n` : mail.text,
      inReplyTo: mail.inReplyTo || undefined,
      references: mail.references?.length ? mail.references : undefined,
    }
    const raw = await new MailComposer(opts).compile().build()
    const transport = nodemailer.createTransport({ host, port, secure, requireTLS: !secure, tls: this.tls, auth: { user: this.user, pass: this.password }, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 2 * TIMEOUT })
    let info
    try {
      info = await transport.sendMail({ envelope: { from: opts.from.address, to: [...mail.to, ...mail.cc] }, raw })
    } catch (e) {
      throw new Error(friendlyError(e as Error, 'SMTP'))
    } finally {
      transport.close()
    }
    if (this.account.provider !== 'gmail') await this.fileInSent(raw).catch(() => {})
    return info.messageId ?? ''
  }

  private async fileInSent(raw: Buffer) {
    await this.imap(async (c) => {
      const boxes = await c.list()
      const sent = boxes.find((b) => b.specialUse === '\\Sent')?.path ?? boxes.find((b) => /^(sent|sent items|sent messages)$/i.test(b.name))?.path
      if (sent) await c.append(sent, raw, ['\\Seen'])
    })
  }

  /** Logs in to both servers; throws with what failed. */
  async test(): Promise<void> {
    await this.imap(async (c) => {
      await c.mailboxOpen('INBOX', { readOnly: true })
    })
    const { host, port, secure } = this.account.smtp
    if (!host) throw new Error(`${this.account.name} has no SMTP server set.`)
    const transport = nodemailer.createTransport({ host, port, secure, requireTLS: !secure, tls: this.tls, auth: { user: this.user, pass: this.password }, connectionTimeout: TIMEOUT })
    try {
      await transport.verify()
    } catch (e) {
      throw new Error(friendlyError(e as Error, 'SMTP'))
    } finally {
      transport.close()
    }
  }
}

/** Login failures in words a person can act on. */
export function friendlyError(e: Error & { authenticationFailed?: boolean; responseText?: string; code?: string }, server: 'IMAP' | 'SMTP'): string {
  const text = `${e.responseText ?? ''} ${e.message ?? ''}`
  if (e.authenticationFailed || e.code === 'EAUTH' || /auth|credentials|password|login/i.test(text))
    return `${server} login was refused. Check the address and use an app password, not your normal password${/basic authentication|basicauth/i.test(text) ? ' (this server has turned off password logins)' : ''}. Server said: ${text.trim().slice(0, 200)}`
  if (e.code === 'ENOTFOUND') return `${server} server not found. Check the server name.`
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || /timeout/i.test(text)) return `Could not reach the ${server} server. Check the server name and port.`
  return `${server}: ${text.trim().slice(0, 300) || 'unknown error'}`
}
