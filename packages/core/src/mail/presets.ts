// Mail server presets and small helpers. No Node imports: the renderer uses these too (`@harness/core/mail-presets`).

export type MailProvider = 'gmail' | 'outlook' | 'custom'

export interface MailServer {
  host: string
  port: number
  /** true = TLS from the start (993/465); false = STARTTLS (143/587). */
  secure: boolean
}

export interface MailPreset {
  id: MailProvider
  label: string
  imap: MailServer
  smtp: MailServer
  /** Where to make an app password, and what to tell the user about it. */
  appPassword?: { url: string; hint: string }
}

export const MAIL_PRESETS: MailPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appPassword: {
      url: 'https://myaccount.google.com/apppasswords',
      hint: 'Turn on 2-Step Verification, then make an app password. Your normal Google password does not work here.',
    },
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    appPassword: {
      url: 'https://account.live.com/proofs/AppPassword',
      hint: 'Use an app password. Work accounts need IMAP and SMTP AUTH turned on by the admin; some Microsoft accounts only allow sign-in through a browser and will be refused here.',
    },
  },
  {
    id: 'custom',
    label: 'Own domain / other',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
  },
]

export function mailPreset(id: string): MailPreset {
  return MAIL_PRESETS.find((p) => p.id === id) ?? MAIL_PRESETS[MAIL_PRESETS.length - 1]
}

/** Keychain id of a mail account's password. */
export const mailSecretId = (accountId: string) => `mail:${accountId}`

/** Keychain id of a notes source's token (Notion). */
export const notesSecretId = (sourceId: string) => `notes:${sourceId}`

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

/** The bare address in `Name <a@b.c>` or `a@b.c`, lowercased; null if it isn't one. */
export function bareAddress(raw: string): string | null {
  const m = /<([^>]+)>/.exec(raw)
  const a = (m ? m[1] : raw).trim().replace(/^mailto:/i, '').toLowerCase()
  return EMAIL.test(a) ? a : null
}

/** Splits "a@b.c, Name <d@e.f>; g@h.i" into addresses. Throws naming the first one that isn't an address. */
export function parseAddressList(raw: string | string[]): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((s) => s.split(/[,;\n]/)).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const a = bareAddress(p)
    if (!a) throw new Error(`"${p}" is not an email address.`)
    if (!out.includes(a)) out.push(a)
  }
  return out
}

/** Whether `address` is on the blocklist: an exact address, or a domain written `@example.com` or `example.com`. */
export function blocked(address: string, blocklist: readonly string[]): boolean {
  const a = address.toLowerCase()
  const domain = a.slice(a.lastIndexOf('@') + 1)
  return blocklist.some((raw) => {
    const b = raw.trim().toLowerCase()
    if (!b) return false
    if (b.includes('@') && !b.startsWith('@')) return a === b
    const d = b.replace(/^@/, '')
    return domain === d || domain.endsWith(`.${d}`)
  })
}
