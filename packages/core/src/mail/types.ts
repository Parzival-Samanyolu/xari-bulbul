/** One message in a search result. `id` is `<account>/<folder>/<uid>` and is passed back to mail_read or mail_draft. */
export interface MailSummary {
  id: string
  account: string
  from: string
  to: string
  subject: string
  date: string
  unread: boolean
  /** The first line or so of the text. */
  snippet: string
}

export interface MailMessage extends MailSummary {
  cc: string
  text: string
  /** Message-ID and References, for threading a reply. */
  messageId: string
  references: string[]
}

export interface MailSearch {
  /** Account id; omitted = every account the chat may use. */
  account?: string
  folder?: string
  /** Words anywhere in the message. */
  query?: string
  from?: string
  to?: string
  /** YYYY-MM-DD */
  since?: string
  unreadOnly?: boolean
  limit?: number
}

export interface DraftInput {
  account?: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  /** A message id from mail_search to reply to (threads the email). */
  replyTo?: string
}

/** What a draft became: waiting for review, sent, or refused (with why). */
export interface DraftOutcome {
  status: 'pending' | 'sent' | 'refused'
  message: string
}

/** The mail tools' view of the host. Absent when no account is set up, which hides the tools. */
export interface MailAccess {
  accounts(): { id: string; name: string; address: string }[]
  search(q: MailSearch, signal?: AbortSignal): Promise<MailSummary[]>
  read(id: string, signal?: AbortSignal): Promise<MailMessage>
  /** Queues an email; the host decides whether it waits for review or is sent now. */
  draft(d: DraftInput): Promise<DraftOutcome>
}

/** A mail id split into its parts. */
export function parseMailId(id: string): { account: string; folder: string; uid: number } {
  const first = id.indexOf('/')
  const last = id.lastIndexOf('/')
  const uid = Number(id.slice(last + 1))
  if (first < 1 || last <= first || !Number.isInteger(uid) || uid < 1) throw new Error(`"${id}" is not a mail id from mail_search.`)
  return { account: id.slice(0, first), folder: id.slice(first + 1, last), uid }
}

export const mailId = (account: string, folder: string, uid: number) => `${account}/${folder}/${uid}`
