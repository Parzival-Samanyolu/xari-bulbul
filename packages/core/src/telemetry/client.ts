import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Share info: anonymous usage counts and error reports, sent in batches to the collector in
// server/telemetry. Its validation is strict (unknown fields, nested props or a bad name reject
// the whole batch), so everything here is shaped to that contract before it is queued.
// Never sent: prompts, replies, code, file names, paths, keys, chat content.

export const TELEMETRY_URL = 'https://193-122-49-121.sslip.io/v1/events'

export const TELEMETRY_LIMITS = Object.freeze({
  maxEvents: 100,
  /** The server takes 64 KB; stay under it. */
  maxBodyBytes: 60_000,
  maxProps: 20,
  maxString: 500,
  /** Events kept while offline or held back; the oldest go first. */
  maxQueue: 500,
  /** Sends a failed batch is tried before it's dropped. */
  maxAttempts: 3,
  /** Error events per run, after de-duplication. */
  maxErrors: 25,
})

const EVENT_NAME = /^[a-z0-9_.:-]{1,64}$/
const PROP_KEY = /^[A-Za-z0-9_.:-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OS = /^(darwin|win32|linux|freebsd|openbsd|sunos|aix)$/
const ARCH = /^(arm64|x64|ia32|arm|ppc64|s390x|riscv64|loong64)$/

export type TelemetryProps = Record<string, string | number | boolean>

export interface TelemetryEvent {
  name: string
  ts: number
  props?: TelemetryProps
}

/** What the app's code calls; a no-op stand-in is fine where share info doesn't apply. */
export interface TelemetrySink {
  /** A counter: events with the same name and props are summed into one `{count}` event per send. */
  count(name: string, props?: TelemetryProps): void
}

/**
 * The collector URL. `XB_TELEMETRY=0` turns sending off, and so does running under a test
 * runner; `XB_TELEMETRY_URL` replaces the URL, and an empty value also turns it off.
 */
export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XB_TELEMETRY === '0') return ''
  if (env.VITEST || env.NODE_ENV === 'test') return ''
  if (env.XB_TELEMETRY_URL !== undefined) return env.XB_TELEMETRY_URL.trim()
  return TELEMETRY_URL
}

// ---------------------------------------------------------------- scrubbing

export interface ScrubContext {
  home?: string
  user?: string
  /** The app's own folder (Electron's app path): kept as `<app>` so stack frames stay readable. */
  appPath?: string
}

export function defaultScrubContext(appPath?: string): ScrubContext {
  let user: string | undefined
  try {
    user = os.userInfo().username
  } catch {
    /* no user database entry */
  }
  return { home: os.homedir(), user, appPath }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The forms a path can take in a message: as is, NFC/NFD, with either slash, and as a file URL. */
function pathForms(p: string): string[] {
  const out = new Set<string>()
  for (const v of [p, p.normalize('NFC'), p.normalize('NFD')]) {
    out.add(v)
    out.add(v.replace(/\\/g, '/'))
    out.add(v.replace(/\//g, '\\'))
    try {
      out.add(pathToFileURL(v).href)
      const enc = encodeURI(v.replace(/\\/g, '/'))
      out.add(enc)
      // pathToFileURL resolves against the current drive on Windows, so add the plain form too.
      out.add(`file://${enc.startsWith('/') ? '' : '/'}${enc}`)
    } catch {
      /* not a path */
    }
  }
  // Longest first, so a file URL is replaced before the bare path inside it.
  return [...out].filter((v) => v.length > 1).sort((a, b) => b.length - a.length)
}

function replaceAll(text: string, forms: string[], by: string, flags = 'g'): string {
  for (const f of forms) text = text.replace(new RegExp(escapeRe(f), flags), by)
  return text
}

/** Keeps `<app>/…` (the app's own files); any other path becomes `<path>`. */
const keepApp = (m: string) => (m.includes('<app>') ? m.replace(/^file:\/\/\/?/, '') : '<path>')

/**
 * Removes what could identify the user or their work from an error message or stack trace:
 * paths (all of them, except the app's own files), the home folder, the user name, emails and
 * key-like tokens. The result is at most 500 characters.
 */
export function scrubText(input: unknown, ctx: ScrubContext = {}): string {
  let t = String(input ?? '')
  if (ctx.appPath) t = replaceAll(t, pathForms(ctx.appPath), '<app>')
  // Quoted text with a slash in it is a path or a URL ("ENOENT: open '/Users/x/My Notes/a.txt'").
  t = t.replace(/(['"`])([^'"`\n]*[\\/][^'"`\n]*)\1/g, (m, q: string, inner: string) => (inner.startsWith('<app>') ? m : `${q}<path>${q}`))
  if (ctx.home && ctx.home.length > 1) t = replaceAll(t, pathForms(ctx.home), '~')
  t = t
    // file:// URLs (the renderer's stack frames)
    .replace(/file:\/\/[^\s'"()<>]*/g, keepApp)
    // Windows drive and UNC paths
    .replace(/(?<![\w<>])[A-Za-z]:[\\/][^\s'"()<>|*?:]*/g, '<path>')
    .replace(/\\\\[^\s'"()<>|*?:]+/g, '<path>')
    // ~/… and absolute POSIX paths; `<app>/out/…` is left alone (preceded by `>`).
    .replace(/~[\\/][^\s'"()<>,;:]*/g, '<path>')
    .replace(/(?<![\w<>.:/~\\-])\/(?=[^\s/])[^\s'"()<>,;:]*/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AIza|hf)[-_][A-Za-z0-9_-]{8,}/g, '<secret>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <secret>')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '<secret>')
  if (ctx.user && ctx.user.length >= 3) t = t.replace(new RegExp(`(?<!<)${escapeRe(ctx.user)}(?!>)`, 'gi'), '<user>')
  return t.slice(0, TELEMETRY_LIMITS.maxString)
}

// ---------------------------------------------------------------- shaping to the contract

/** Props the server accepts: flat scalars, valid keys, strings capped. Anything else is dropped. */
export function cleanProps(props: Record<string, unknown> | undefined): TelemetryProps | undefined {
  if (!props) return undefined
  const out: TelemetryProps = {}
  let n = 0
  for (const [k, v] of Object.entries(props)) {
    if (n >= TELEMETRY_LIMITS.maxProps) break
    if (!PROP_KEY.test(k) || k === '__proto__') continue
    if (typeof v === 'string') out[k] = v.slice(0, TELEMETRY_LIMITS.maxString)
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else continue
    n++
  }
  return n ? out : undefined
}

/** A version string the server accepts. */
export function cleanVersion(v: string): string {
  return v.replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32) || '0.0.0'
}

/** The install id in `<dataDir>/install-id`, made on first use. Random; not tied to the person or machine. */
export function installId(dataDir: string): string {
  const file = path.join(dataDir, 'install-id')
  try {
    const id = fs.readFileSync(file, 'utf8').trim()
    if (UUID.test(id)) return id.toLowerCase()
  } catch {
    /* first run */
  }
  const id = crypto.randomUUID()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `${id}\n`)
  return id
}

// ---------------------------------------------------------------- the client

export interface TelemetryOptions {
  dataDir: string
  appVersion: string
  /** Where batches go; empty = never send (see `telemetryUrl`). */
  url: string
  /** Read before every queue and send: the user's share-info switch. */
  enabled: () => boolean
  /** While false, events are kept but not sent (e.g. until first-run setup has shown the switch). */
  ready?: () => boolean
  fetch?: typeof fetch
  now?: () => number
  platform?: string
  arch?: string
  scrub?: ScrubContext
  /** How often queued events are sent. Default 5 minutes. */
  flushMs?: number
}

interface Queued extends TelemetryEvent {
  attempts: number
}

export class Telemetry implements TelemetrySink {
  private queue: Queued[] = []
  private counters = new Map<string, { name: string; ts: number; props?: TelemetryProps; count: number }>()
  private errorKeys = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private sending: Promise<void> | null = null
  private readonly platform: string
  private readonly arch: string

  constructor(private readonly o: TelemetryOptions) {
    this.platform = o.platform ?? process.platform
    this.arch = o.arch ?? process.arch
  }

  /** Sending is possible and the user allows it. */
  get active(): boolean {
    return !!this.o.url && OS.test(this.platform) && ARCH.test(this.arch) && this.o.enabled()
  }

  private get now(): number {
    return Math.floor((this.o.now ?? Date.now)())
  }

  /** Queues one event. Names must match the server's pattern; props are cleaned. */
  event(name: string, props?: Record<string, unknown>): void {
    if (!this.active) return this.drop()
    if (!EVENT_NAME.test(name)) return
    const clean = cleanProps(props)
    this.push({ name, ts: this.now, ...(clean && { props: clean }), attempts: 0 })
  }

  count(name: string, props?: TelemetryProps): void {
    if (!this.active) return this.drop()
    if (!EVENT_NAME.test(name)) return
    const clean = cleanProps(props)
    const key = `${name}\u0000${JSON.stringify(clean ?? {})}`
    const c = this.counters.get(key)
    if (c) c.count++
    else this.counters.set(key, { name, ts: this.now, props: clean, count: 1 })
  }

  /**
   * An error or crash (`name` starts with `error.` or `crash.`): the message and stack, scrubbed
   * and cut to 500 characters each. The same error is reported once per run.
   */
  error(name: string, err: unknown, props?: TelemetryProps): void {
    if (!this.active) return this.drop()
    const e = err instanceof Error ? err : null
    const message = scrubText(e ? `${e.name}: ${e.message}` : err, this.o.scrub)
    const stack = e?.stack ? scrubText(e.stack.split('\n').slice(1).join('\n').trim(), this.o.scrub) : ''
    const key = `${name}\u0000${message}\u0000${stack.slice(0, 200)}`
    if (this.errorKeys.has(key) || this.errorKeys.size >= TELEMETRY_LIMITS.maxErrors) return
    this.errorKeys.add(key)
    this.event(name, { ...props, message, ...(stack && { stack }) })
  }

  /** The switch was turned off: forget everything queued. */
  drop(): void {
    this.queue = []
    this.counters.clear()
  }

  /** Sends on a timer until `stop`. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), this.o.flushMs ?? 5 * 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private push(e: Queued) {
    this.queue.push(e)
    if (this.queue.length > TELEMETRY_LIMITS.maxQueue) this.queue.splice(0, this.queue.length - TELEMETRY_LIMITS.maxQueue)
  }

  /** Sends what's queued (counters folded in), in batches the server accepts. Never throws. */
  flush(): Promise<void> {
    this.sending ??= this.send().finally(() => (this.sending = null))
    return this.sending
  }

  private async send(): Promise<void> {
    if (!this.active) return this.drop()
    if (this.o.ready && !this.o.ready()) return
    for (const c of this.counters.values()) this.push({ name: c.name, ts: c.ts, props: { ...c.props, count: c.count }, attempts: 0 })
    this.counters.clear()
    if (!this.queue.length) return
    let id: string
    try {
      id = installId(this.o.dataDir)
    } catch {
      return
    }
    const head = { installId: id, appVersion: cleanVersion(this.o.appVersion), os: this.platform, arch: this.arch }
    const pending = this.queue
    this.queue = []
    const retry: Queued[] = []
    for (const batch of batches(head, pending)) {
      const body = JSON.stringify({ ...head, events: batch.map(({ attempts: _, ...e }) => e) })
      let status = 0
      try {
        const res = await (this.o.fetch ?? fetch)(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) })
        status = res.status
      } catch {
        /* offline */
      }
      if (status >= 200 && status < 300) continue
      // Rejected (400 invalid, 413 too big, 415) or rate limited (429): sending again won't help.
      if (status >= 400 && status < 500 && status !== 408) continue
      for (const e of batch) if (e.attempts + 1 < TELEMETRY_LIMITS.maxAttempts) retry.push({ ...e, attempts: e.attempts + 1 })
    }
    // Events queued while sending stay after the ones being retried.
    if (!this.active) return this.drop()
    this.queue = [...retry, ...this.queue].slice(-TELEMETRY_LIMITS.maxQueue)
  }
}

/** Splits events into batches of at most 100 that serialize under the body limit. */
function batches(head: object, events: Queued[]): Queued[][] {
  const base = JSON.stringify({ ...head, events: [] }).length
  const out: Queued[][] = []
  let cur: Queued[] = []
  let size = base
  for (const e of events) {
    const { attempts: _, ...plain } = e
    const n = Buffer.byteLength(JSON.stringify(plain)) + 1
    if (base + n > TELEMETRY_LIMITS.maxBodyBytes) continue
    if (cur.length >= TELEMETRY_LIMITS.maxEvents || size + n > TELEMETRY_LIMITS.maxBodyBytes) {
      out.push(cur)
      cur = []
      size = base
    }
    cur.push(e)
    size += n
  }
  if (cur.length) out.push(cur)
  return out
}
