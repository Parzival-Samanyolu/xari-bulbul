import { z } from 'zod'
import { splitReply } from './imessage.js'

// Pure pieces of the WhatsApp gateway: which messages count as prompts, echo suppression, reply
// formatting and the JSON-lines protocol spoken with the bridge process
// (`apps/desktop/resources/whatsapp-bridge/bridge.mjs`). The owner/self-chat model follows Hermes
// Agent's WhatsApp gateway (MIT, Copyright (c) 2025 Nous Research); the code is our own.

// ---------------------------------------------------------------- JIDs

/** `4915112345678:12@s.whatsapp.net` → `4915112345678@s.whatsapp.net` (the device part dropped). */
export function bareJid(jid: string | null | undefined): string {
  return String(jid ?? '')
    .trim()
    .replace(/:\d+(?=@)/, '')
    .toLowerCase()
}

/** The user part of a JID: `4915112345678` or a LID number. */
export function jidUser(jid: string | null | undefined): string {
  return bareJid(jid).split('@')[0] ?? ''
}

/** Groups, status updates, broadcast lists and channels: never a self-chat. */
export function isGroupLike(jid: string | null | undefined): boolean {
  return /@(g\.us|broadcast|newsletter)$/.test(bareJid(jid)) || bareJid(jid).startsWith('status@')
}

/** The linked account: its phone JID and, on newer accounts, its LID. */
export interface WhatsAppMe {
  id: string
  lid: string | null
  name?: string | null
}

/**
 * Whether `chat` is the account's own "Message yourself" chat. WhatsApp may address it by the
 * phone JID (`<number>@s.whatsapp.net`) or the LID (`<lid>@lid`); `alt` is the other form when
 * the bridge knows it.
 */
export function isSelfChat(chat: string, me: WhatsAppMe | null, alt?: string | null): boolean {
  if (!me) return false
  const mine = new Set<string>()
  const phone = jidUser(me.id)
  if (phone) mine.add(`${phone}@s.whatsapp.net`)
  const lid = jidUser(me.lid)
  if (lid) mine.add(`${lid}@lid`)
  if (!mine.size) return false
  const forms = [chat, alt].filter((j): j is string => !!j)
  if (forms.some(isGroupLike)) return false
  return forms.some((j) => mine.has(bareJid(j)))
}

// ---------------------------------------------------------------- echoes

/**
 * Ids of messages the gateway sent, newest kept, oldest dropped past `max`. Replies land in the
 * same self-chat the prompts come from, so their echoes must never run as prompts.
 */
export class OutboundIds {
  private ids = new Set<string>()

  constructor(private readonly max = 512) {}

  remember(id: string | null | undefined) {
    if (!id) return
    this.ids.delete(id)
    this.ids.add(id)
    while (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string)
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.ids.has(id)
  }

  get size() {
    return this.ids.size
  }
}

export interface InboundMessage {
  id: string
  chat: string
  chatAlt?: string | null
  fromMe: boolean
  text: string
  /** ms since 1970. */
  at: number
}

export type GateResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-mine' | 'group' | 'not-self-chat' | 'echo' | 'prefix' | 'duplicate' | 'empty' | 'old' | 'not-linked' }

/**
 * Whether a message from the bridge is a prompt: your own message (fromMe) in your own
 * "Message yourself" chat, not one the gateway sent, not seen before, recent and not empty.
 * Messages from anyone else, and anything in a group, are never prompts.
 */
export function gateMessage(
  m: InboundMessage,
  ctx: { me: WhatsAppMe | null; outbound: OutboundIds; seen?: OutboundIds; prefix: string; now: number; maxAgeMs?: number },
): GateResult {
  if (!ctx.me) return { ok: false, reason: 'not-linked' }
  if (isGroupLike(m.chat) || (m.chatAlt && isGroupLike(m.chatAlt))) return { ok: false, reason: 'group' }
  if (!m.fromMe) return { ok: false, reason: 'not-mine' }
  if (!isSelfChat(m.chat, ctx.me, m.chatAlt)) return { ok: false, reason: 'not-self-chat' }
  if (ctx.outbound.has(m.id)) return { ok: false, reason: 'echo' }
  const prefix = ctx.prefix.trim()
  if (prefix && m.text.trimStart().startsWith(prefix)) return { ok: false, reason: 'prefix' }
  if (ctx.seen?.has(m.id)) return { ok: false, reason: 'duplicate' }
  if (ctx.now - m.at > (ctx.maxAgeMs ?? 10 * 60_000)) return { ok: false, reason: 'old' }
  const text = m.text.trim()
  if (!text) return { ok: false, reason: 'empty' }
  return { ok: true, text }
}

// ---------------------------------------------------------------- replies

/**
 * Markdown in WhatsApp's own formatting: *bold*, _italic_, ~strike~, ```code```, `inline`.
 * Headings become bold lines, bullets "•", links "text (url)". Code blocks are left as they are.
 */
export function toWhatsApp(md: string): string {
  const parts = md.replace(/\r\n/g, '\n').split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/^```[^\n]*\n/, '```').replace(/\n?```$/, '```')
      return formatProse(part)
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const B = '\u0001'
function formatProse(s: string): string {
  return (
    s
      .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, t: string) => `${B}${t.replace(/\*\*|__/g, '')}${B}`)
      .replace(/^>\s?/gm, '')
      .replace(/^(\s*)[*+-]\s+(?=\S)/gm, '$1• ')
      .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, u: string) => (t === u ? u : `${t} (${u})`))
      // Bold first, through a marker, so the italic rule below doesn't see its asterisks.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, `${B}$2${B}`)
      .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/gm, '$1_$2_')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '~$1~')
      .replaceAll(B, '*')
  )
}

/** Room for the prefix and a closed code fence inside the 3500-char budget. */
export const WHATSAPP_MAX_CHARS = 3500
export const WHATSAPP_MAX_PARTS = 5

/**
 * A reply as at most 5 WhatsApp messages of about 3500 chars, each starting with `prefix`.
 * A code block cut between two parts is closed at the end of one and reopened in the next.
 */
export function whatsappParts(reply: string, prefix: string, opts: { maxChars?: number; maxParts?: number } = {}): string[] {
  const max = (opts.maxChars ?? WHATSAPP_MAX_CHARS) - prefix.length - 8
  const parts = splitReply(toWhatsApp(reply), { maxChars: Math.max(200, max), maxParts: opts.maxParts ?? WHATSAPP_MAX_PARTS })
  let open = false
  return parts.map((p) => {
    let text = open ? `\`\`\`${p}` : p
    open = ((text.match(/```/g)?.length ?? 0) % 2) === 1
    if (open) text = `${text}\`\`\``
    return `${prefix}${text}`
  })
}

// ---------------------------------------------------------------- protocol

const MeSchema = z.object({ id: z.string(), lid: z.string().nullable().optional(), name: z.string().nullable().optional() })

export const BridgeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('qr'), qr: z.string(), svg: z.string().optional() }),
  z.object({ type: z.literal('pairing_code'), code: z.string() }),
  z.object({ type: z.literal('connected'), me: MeSchema }),
  z.object({ type: z.literal('disconnected'), reason: z.number().nullable().optional(), retryInMs: z.number().optional() }),
  z.object({ type: z.literal('qr_timeout') }),
  z.object({ type: z.literal('logged_out') }),
  z.object({ type: z.literal('replaced') }),
  z.object({
    type: z.literal('message'),
    id: z.string(),
    chat: z.string(),
    chatAlt: z.string().nullable().optional(),
    fromMe: z.boolean(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('result'),
    id: z.number(),
    ok: z.boolean(),
    messageIds: z.array(z.string()).optional(),
    code: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('log'), level: z.string(), msg: z.string() }),
])

export type BridgeEvent = z.infer<typeof BridgeEventSchema>

/** One stdout line from the bridge, or null for anything that isn't a known event. */
export function parseBridgeLine(line: string): BridgeEvent | null {
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try {
    const r = BridgeEventSchema.safeParse(JSON.parse(s))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export type BridgeCommand =
  | { cmd: 'send'; id: number; to: string; text: string }
  | { cmd: 'typing'; to: string; on: boolean }
  | { cmd: 'pair'; id: number; phone: string }
  | { cmd: 'logout'; id: number }
  | { cmd: 'stop' }

export function encodeCommand(c: BridgeCommand): string {
  return `${JSON.stringify(c)}\n`
}

/**
 * Splits a byte stream into lines. Feed it chunks; it calls `onLine` for each full line and
 * keeps the rest. Over-long lines (a broken bridge) are dropped rather than kept growing.
 */
export class LineSplitter {
  private buf = ''

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLine = 4 * 1024 * 1024,
  ) {}

  push(chunk: string | Buffer) {
    this.buf += chunk.toString()
    let i: number
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      if (line.trim()) this.onLine(line)
    }
    if (this.buf.length > this.maxLine) this.buf = ''
  }
}

export const WA_APPROVAL_TEXT = (subject: string) => `Needs your approval in Xarı Bülbül: ${subject}`.trim()
export const WA_TEST_TEXT = 'Xarı Bülbül is connected.'
