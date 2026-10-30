import fs from 'node:fs'
import { normalizeSender } from './senders.js'

// Pure pieces of the iMessage gateway: senders, message text, replies and the AppleScript that
// sends them. The polling and the agent wiring live in `imessage-gateway.ts`.

export { allowedSender, normalizeHandle, normalizeSender } from './senders.js'

// ---------------------------------------------------------------- message text

/**
 * The text of an `attributedBody` blob: an NSAttributedString in Apple's typedstream format.
 * Recent macOS leaves `message.text` null and stores the text only here. The string follows the
 * `NSString` class name as a `+` (C string) with a length: one byte below 0x80, 0x81 + two
 * bytes, or 0x82 + four bytes (little-endian). Returns null when there's no string.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || !blob.length) return null
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  let at = buf.indexOf('NSString')
  while (at !== -1) {
    // A few bytes (version, type markers) sit between the class name and the '+'.
    const plus = buf.indexOf(0x2b, at + 8)
    if (plus !== -1 && plus - (at + 8) <= 8) {
      const text = readString(buf, plus + 1)
      if (text != null) return text
    }
    at = buf.indexOf('NSString', at + 8)
  }
  return null
}

function readString(buf: Buffer, p: number): string | null {
  if (p >= buf.length) return null
  const b = buf[p]
  let len: number
  let start: number
  if (b === 0x81) {
    if (p + 3 > buf.length) return null
    len = buf.readUInt16LE(p + 1)
    start = p + 3
  } else if (b === 0x82) {
    if (p + 5 > buf.length) return null
    len = buf.readUInt32LE(p + 1)
    start = p + 5
  } else if (b < 0x80) {
    len = b
    start = p + 1
  } else return null
  if (start + len > buf.length) return null
  return buf.subarray(start, start + len).toString('utf8')
}

/** The message's text: `text`, else the decoded `attributedBody`; attachment placeholders removed. */
export function messageText(row: { text: string | null; body: Uint8Array | null }): string {
  const raw = row.text ?? decodeAttributedBody(row.body) ?? ''
  return raw.replace(/￼/g, '').trim()
}

/** chat.db dates count from 2001-01-01 (Apple's reference date). */
export const APPLE_EPOCH_MS = 978_307_200_000

// ---------------------------------------------------------------- replies

/** Markdown made readable as a plain text message. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*)[*+-]\s+(?=\S)/gm, '$1• ')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, u: string) => (t === u ? u : `${t} (${u})`))
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/gm, '$1$2')
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,!?:;]|$)/gm, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const CONTINUED_NOTE = '…(continued in the app)'

/**
 * A reply as at most `maxParts` messages of at most `maxChars` each, cut at paragraph, then
 * sentence, then line, then word boundaries. A longer reply ends with "…(continued in the app)".
 */
export function splitReply(text: string, opts: { maxChars?: number; maxParts?: number } = {}): string[] {
  const max = opts.maxChars ?? 1500
  const maxParts = opts.maxParts ?? 5
  const parts = chunk(text.trim(), max)
  if (parts.length <= maxParts) return parts
  const kept = parts.slice(0, maxParts)
  const room = max - CONTINUED_NOTE.length - 1
  const last = kept[maxParts - 1]
  kept[maxParts - 1] = `${last.length > room ? chunk(last, room)[0] : last}\n${CONTINUED_NOTE}`
  return kept
}

function chunk(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    const cut = cutPoint(window, max)
    const head = rest.slice(0, cut).trimEnd()
    if (head) out.push(head)
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

/** Where to cut `window` (max + 1 chars) so the head is at most `max` chars. */
function cutPoint(window: string, max: number): number {
  const min = Math.floor(max * 0.4)
  const para = window.lastIndexOf('\n\n', max)
  if (para >= min) return para
  let sentence = -1
  for (const m of window.matchAll(/[.!?…。]["')\]]*\s/g)) {
    const end = m.index + m[0].length - 1
    if (end <= max) sentence = end
  }
  if (sentence >= min) return sentence
  const line = window.lastIndexOf('\n', max)
  if (line >= min) return line
  const space = window.lastIndexOf(' ', max)
  if (space >= min) return space
  // No boundary: a hard cut, kept off the middle of a surrogate pair.
  const code = window.charCodeAt(max - 1)
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max
}

export const APPROVAL_TEXT = (subject: string) => `Needs your approval in Xarı Bülbül: ${subject}`.trim()
export const TEST_TEXT = 'Xarı Bülbül is connected.'

// ---------------------------------------------------------------- sending

/**
 * Sends `item 2 of argv` to `item 1 of argv` over iMessage. The recipient and text arrive as
 * arguments, never spliced into the script, so nothing in a reply can run as AppleScript.
 */
export const SEND_SCRIPT = [
  'on run argv',
  'set theRecipient to item 1 of argv',
  'set theText to item 2 of argv',
  'tell application "Messages"',
  'set theService to 1st account whose service type = iMessage',
  'set theTarget to participant theRecipient of theService',
  'send theText to theTarget',
  'end tell',
  'end run',
]

/** Arguments for `osascript` (run with execFile, no shell). */
export function osascriptArgs(recipient: string, text: string): string[] {
  const to = normalizeSender(recipient)
  // A leading '-' would be read as an osascript option; normalized senders never start with one.
  if (!to) throw new Error(`Not a phone number or email: ${recipient}`)
  return [...SEND_SCRIPT.flatMap((line) => ['-e', line]), to, text]
}

/** What went wrong sending, in words for Settings. `automation` = macOS blocked control of Messages. */
export function sendErrorKind(message: string): 'automation' | 'other' {
  return /-1743|not authori[sz]ed to send apple events|not allowed to send apple events/i.test(message) ? 'automation' : 'other'
}

// ---------------------------------------------------------------- cursor

export interface GatewayFileState {
  imessage?: { cursor?: number }
}

/** `<dataDir>/gateways.json`; an unreadable file counts as empty. */
export function readGatewayState(file: string): GatewayFileState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

export function writeGatewayState(file: string, state: GatewayFileState): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------- queueing

/**
 * Runs jobs one at a time per key, in order; different keys run side by side. A message that
 * arrives while the sender's previous one is still running waits for it.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(job, job)
    const tail = next.catch(() => {})
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }

  /** Keys with a job running or waiting. */
  busy(): string[] {
    return [...this.tails.keys()]
  }
}

/**
 * Texts the gateway sent recently. Messages to your own number or Apple ID come back as
 * incoming messages, so a reply would otherwise start another turn.
 */
export class RecentlySent {
  private sent: { text: string; at: number }[] = []

  constructor(private readonly ttlMs = 10 * 60_000) {}

  add(text: string, now = Date.now()) {
    this.sent.push({ text: key(text), at: now })
    this.trim(now)
  }

  /** True once per sent text: the echo is consumed. */
  isEcho(text: string, now = Date.now()): boolean {
    this.trim(now)
    const i = this.sent.findIndex((s) => s.text === key(text))
    if (i === -1) return false
    this.sent.splice(i, 1)
    return true
  }

  private trim(now: number) {
    this.sent = this.sent.filter((s) => now - s.at < this.ttlMs).slice(-200)
  }
}

const key = (text: string) => text.replace(/\s+/g, ' ').trim()
