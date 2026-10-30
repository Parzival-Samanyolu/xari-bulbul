import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Settings } from '../settings/schema.js'
import { KeyedQueue } from './imessage.js'
import {
  type BridgeCommand,
  type BridgeEvent,
  LineSplitter,
  OutboundIds,
  WA_APPROVAL_TEXT,
  WA_TEST_TEXT,
  type WhatsAppMe,
  bareJid,
  encodeCommand,
  gateMessage,
  jidUser,
  parseBridgeLine,
  whatsappParts,
} from './whatsapp.js'
import { type InstallPlan, type Tooling, findTooling, installPlan, prepareBridge, progressText, runInstall, secureDir } from './whatsapp-install.js'

// Runs the WhatsApp bridge (a separate `node bridge.mjs` process) while the gateway is on and the
// app is open, and turns your own messages in "Message yourself" into turns in one chat.

export type WhatsAppConfig = Settings['gateways']['whatsapp']

export interface WhatsAppStatus {
  /**
   * off · needs-node (no Node.js 20+) · installing (npm) · starting · linking (QR or pairing code
   * shown) · connected · reconnecting · qr-expired · logged-out (link again) · replaced (another
   * copy took over the link) · error
   */
  state: 'off' | 'needs-node' | 'installing' | 'starting' | 'linking' | 'connected' | 'reconnecting' | 'qr-expired' | 'logged-out' | 'replaced' | 'error'
  message: string | null
  /** The QR code as SVG markup, while linking. */
  qrSvg: string | null
  /** The raw QR string (shown when there's no SVG). */
  qr: string | null
  /** "ABCD-EFGH", after "Link with phone number". */
  pairingCode: string | null
  /** The linked number, like +4915112345678. */
  account: string | null
  /** The latest install line, while installing. */
  progress: string | null
  /** A link for the message (the Node.js download page). */
  url: string | null
  runError: string | null
  sendError: string | null
  lastReceivedAt: number | null
  lastSentAt: number | null
  /** A message is running or waiting. */
  busy: boolean
}

/** The part of a child process the gateway uses; tests pass a fake. */
export interface BridgeProcess {
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

export interface WhatsAppGatewayDeps {
  dataDir: string
  /** The app's copy of the bridge (an extra resource, outside app.asar). */
  bridgeSource: string
  config: () => WhatsAppConfig
  /** Runs a message in the WhatsApp chat; resolves with the reply to send back (null = nothing). */
  run: (text: string) => Promise<string | null>
  onChange?: () => void
  tooling?: () => Promise<Tooling>
  install?: (plan: Extract<InstallPlan, { ok: true }>, onLine: (line: string) => void, signal: AbortSignal) => Promise<void>
  spawnBridge?: (node: string, script: string, args: string[], cwd: string) => BridgeProcess
  now?: () => number
  /** Delay before restarting a bridge that stopped on its own. */
  restartDelay?: (attempt: number) => number
}

/** Only what the bridge needs: no API keys or other secrets from the app's environment. */
export function bridgeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|SYSTEMROOT|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/
  return Object.fromEntries(Object.entries(env).filter(([k]) => keep.test(k)))
}

function defaultSpawn(node: string, script: string, args: string[], cwd: string): BridgeProcess {
  return spawn(node, [script, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: bridgeEnv() })
}

const OFF: WhatsAppStatus = {
  state: 'off',
  message: null,
  qrSvg: null,
  qr: null,
  pairingCode: null,
  account: null,
  progress: null,
  url: null,
  runError: null,
  sendError: null,
  lastReceivedAt: null,
  lastSentAt: null,
  busy: false,
}

/** States that wait for the user (Retry, Link again, Show a new code) instead of restarting. */
const HELD: WhatsAppStatus['state'][] = ['needs-node', 'qr-expired', 'logged-out', 'replaced', 'error']

export class WhatsAppGateway {
  private st: WhatsAppStatus = { ...OFF }
  private proc: BridgeProcess | null = null
  private starting: Promise<void> | null = null
  private installAbort: AbortController | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private typingTimer: NodeJS.Timeout | null = null
  private crashes = 0
  private me: WhatsAppMe | null = null
  /** Set while we stop the bridge on purpose; its exit is not a crash. */
  private stopping = false
  /** How the bridge said it is about to exit. */
  private exitAs: 'qr-expired' | 'logged-out' | 'replaced' | null = null
  private stderrTail: string[] = []
  private nextId = 1
  private pending = new Map<number, { resolve: (e: Extract<BridgeEvent, { type: 'result' }>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly outbound = new OutboundIds()
  private readonly seen = new OutboundIds(1000)
  private readonly queue = new KeyedQueue()
  private told = false
  private disposed = false

  constructor(private readonly d: WhatsAppGatewayDeps) {}

  get bridgeDir() {
    return path.join(this.d.dataDir, 'whatsapp-bridge')
  }

  get authDir() {
    return path.join(this.d.dataDir, 'whatsapp', 'auth')
  }

  private get now() {
    return this.d.now?.() ?? Date.now()
  }

  private set(next: Partial<WhatsAppStatus>) {
    this.st = { ...this.st, ...next }
    this.d.onChange?.()
  }

  status(): WhatsAppStatus {
    return { ...this.st, busy: this.queue.busy().length > 0 }
  }

  /** Starts or stops the bridge to match the settings. */
  sync(): void {
    if (this.disposed) return
    if (!this.d.config().enabled) {
      this.stopBridge()
      if (this.st.state !== 'off') this.set({ ...OFF, lastReceivedAt: this.st.lastReceivedAt, lastSentAt: this.st.lastSentAt })
      return
    }
    if (this.proc || this.starting || this.restartTimer || HELD.includes(this.st.state)) return
    this.start()
  }

  /** Starts again after a held state: Retry, Link again, Show a new code. */
  retry(): void {
    if (this.disposed || !this.d.config().enabled) return
    this.clearRestart()
    if (this.proc || this.starting) return
    this.set({ state: 'starting', message: 'Starting…', url: null, qr: null, qrSvg: null, pairingCode: null })
    this.start()
  }

  private start(): void {
    if (this.starting) return
    this.starting = this.prepareAndSpawn()
      .catch((e) => {
        if (this.disposed) return
        this.set({ state: 'error', message: (e as Error).message, progress: null })
      })
      .finally(() => {
        this.starting = null
      })
  }

  private async prepareAndSpawn(): Promise<void> {
    this.set({ state: 'installing', message: 'Checking for Node.js…', progress: null, url: null })
    const tooling = await (this.d.tooling ?? findTooling)()
    const plan = installPlan(tooling, this.bridgeDir)
    if (!plan.ok) {
      this.set({ state: 'needs-node', message: plan.message, url: plan.url, progress: null })
      return
    }
    const { needsInstall } = prepareBridge(this.d.bridgeSource, this.bridgeDir)
    if (needsInstall) {
      this.set({ state: 'installing', message: 'Downloading WhatsApp support (Baileys) with npm…', progress: 'Starting npm…' })
      const ac = new AbortController()
      this.installAbort = ac
      let fetched = 0
      let last = 0
      try {
        await (this.d.install ?? runInstall)(
          plan,
          (line) => {
            if (/^npm http fetch/i.test(line)) fetched++
            const text = progressText(line, fetched)
            // At most a few updates a second reach the window.
            if (text && this.now - last > 250) {
              last = this.now
              this.set({ progress: text })
            }
          },
          ac.signal,
        )
      } finally {
        this.installAbort = null
      }
    }
    if (this.disposed || !this.d.config().enabled) return
    secureDir(this.authDir)
    this.spawn(plan.node)
  }

  private spawn(node: string) {
    this.exitAs = null
    this.stopping = false
    this.stderrTail = []
    this.set({ state: 'starting', message: 'Connecting to WhatsApp…', progress: null })
    const child = (this.d.spawnBridge ?? defaultSpawn)(node, path.join(this.bridgeDir, 'bridge.mjs'), ['--auth', this.authDir], this.bridgeDir)
    this.proc = child
    const lines = new LineSplitter((line) => {
      const ev = parseBridgeLine(line)
      if (ev && this.proc === child) this.onEvent(ev)
    })
    child.stdout?.on('data', (c: Buffer) => lines.push(c))
    child.stderr?.on('data', (c: Buffer) => {
      for (const l of c.toString().split(/\r?\n/)) if (l.trim()) this.stderrTail = [...this.stderrTail, l.trim()].slice(-10)
    })
    child.stdin?.on('error', () => {})
    child.on('error', (e) => {
      if (this.proc !== child) return
      this.proc = null
      this.set({ state: 'error', message: `The WhatsApp bridge couldn't start: ${e.message}` })
    })
    child.on('exit', (code) => {
      if (this.proc === child) this.onExit(code)
    })
  }

  private onEvent(ev: BridgeEvent) {
    switch (ev.type) {
      case 'qr':
        return this.set({ state: 'linking', message: null, qr: ev.qr, qrSvg: ev.svg || null })
      case 'pairing_code':
        return this.set({ state: 'linking', message: null, pairingCode: ev.code })
      case 'connected':
        this.me = { id: ev.me.id, lid: ev.me.lid ?? null, name: ev.me.name ?? null }
        this.crashes = 0
        return this.set({ state: 'connected', message: null, qr: null, qrSvg: null, pairingCode: null, account: jidUser(ev.me.id) ? `+${jidUser(ev.me.id)}` : null })
      case 'disconnected': {
        const secs = Math.round((ev.retryInMs ?? 0) / 1000)
        return this.set({ state: 'reconnecting', message: `Lost the connection to WhatsApp${ev.reason ? ` (${ev.reason})` : ''}. Trying again${secs ? ` in ${secs} s` : ''}.` })
      }
      case 'qr_timeout':
        this.exitAs = 'qr-expired'
        return
      case 'logged_out':
        this.exitAs = 'logged-out'
        return
      case 'replaced':
        this.exitAs = 'replaced'
        return
      case 'message':
        return this.onMessage(ev)
      case 'result': {
        const p = this.pending.get(ev.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(ev.id)
        p.resolve(ev)
        return
      }
      case 'log':
        if (ev.level === 'error') this.stderrTail = [...this.stderrTail, ev.msg.split('\n')[0]].slice(-10)
        return
    }
  }

  private onExit(code: number | null) {
    this.proc = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('The WhatsApp bridge stopped.'))
    }
    this.pending.clear()
    this.stopTyping()
    if (this.stopping || this.disposed) return
    const as = this.exitAs
    this.exitAs = null
    const keep = { qr: null, qrSvg: null, pairingCode: null }
    if (as === 'logged-out') {
      this.forgetLink()
      return this.set({ ...keep, state: 'logged-out', account: null, message: 'WhatsApp unlinked this computer. Link again to keep using it.' })
    }
    if (as === 'qr-expired') return this.set({ ...keep, state: 'qr-expired', message: 'The code expired before it was scanned.' })
    if (as === 'replaced') return this.set({ ...keep, state: 'replaced', message: 'Another copy of Xarı Bülbül took over this WhatsApp link.' })
    if (!this.d.config().enabled) return
    // Crashed: restart with backoff.
    this.crashes++
    const delay = this.d.restartDelay?.(this.crashes) ?? Math.min(300_000, 2000 * 2 ** (this.crashes - 1))
    const why = this.stderrTail.at(-1)
    this.set({ ...keep, state: 'reconnecting', message: `The WhatsApp bridge stopped (exit ${code ?? '?'})${why ? `: ${why.slice(0, 200)}` : ''}. Restarting in ${Math.round(delay / 1000)} s.` })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.disposed && this.d.config().enabled && !this.proc) this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private write(c: BridgeCommand) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) throw new Error('WhatsApp isn’t running.')
    this.proc.stdin.write(encodeCommand(c))
  }

  private request(c: { cmd: 'send'; to: string; text: string } | { cmd: 'pair'; phone: string } | { cmd: 'logout' }, timeoutMs = 90_000) {
    const id = this.nextId++
    return new Promise<Extract<BridgeEvent, { type: 'result' }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('WhatsApp didn’t answer in time.'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ ...c, id } as BridgeCommand)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  // ---------------------------------------------------------------- messages

  private onMessage(ev: Extract<BridgeEvent, { type: 'message' }>) {
    const gate = gateMessage(ev, { me: this.me, outbound: this.outbound, seen: this.seen, prefix: this.d.config().prefix, now: this.now })
    if (!gate.ok) return
    this.seen.remember(ev.id)
    this.set({ lastReceivedAt: this.now })
    void this.dispatch(gate.text, bareJid(ev.chat))
  }

  /** Runs the text after any message still running, then sends the reply to `to`. */
  dispatch(text: string, to: string): Promise<void> {
    const job = this.queue.run('self', async () => {
      this.told = false
      this.d.onChange?.()
      this.startTyping(to)
      let reply: string | null
      try {
        reply = await this.d.run(text)
      } finally {
        this.stopTyping(to)
      }
      this.told = false
      this.set({ runError: null })
      if (reply?.trim()) await this.sendReply(to, reply)
    })
    return job
      .catch((e) => this.set({ runError: `The last message failed: ${(e as Error).message}` }))
      .finally(() => this.d.onChange?.())
  }

  private startTyping(to: string) {
    this.stopTyping()
    const tick = () => {
      try {
        this.write({ cmd: 'typing', to, on: true })
      } catch {
        /* not running: no typing to show */
      }
    }
    tick()
    // WhatsApp clears "typing…" after about 25 s.
    this.typingTimer = setInterval(tick, 10_000)
    this.typingTimer.unref?.()
  }

  private stopTyping(to?: string) {
    if (this.typingTimer) clearInterval(this.typingTimer)
    this.typingTimer = null
    if (!to) return
    try {
      this.write({ cmd: 'typing', to, on: false })
    } catch {
      /* not running */
    }
  }

  async sendReply(to: string, reply: string): Promise<void> {
    for (const part of whatsappParts(reply, this.d.config().prefix)) await this.sendText(to, part)
  }

  private async sendText(to: string, text: string): Promise<void> {
    if (!this.proc || this.st.state !== 'connected') throw new Error('WhatsApp isn’t connected.')
    try {
      const r = await this.request({ cmd: 'send', to, text })
      if (!r.ok) throw new Error(r.error || 'WhatsApp couldn’t send the message.')
      for (const id of r.messageIds ?? []) this.outbound.remember(id)
      this.set({ sendError: null, lastSentAt: this.now })
    } catch (e) {
      this.set({ sendError: `Couldn’t send to WhatsApp: ${(e as Error).message}` })
      throw e
    }
  }

  /** Your own chat, in the phone form. */
  private selfJid(): string {
    const user = jidUser(this.me?.id)
    if (!user) throw new Error('WhatsApp isn’t linked yet.')
    return `${user}@s.whatsapp.net`
  }

  /** Once per turn a WhatsApp message started: an approval or question waits in the app. */
  async needsAttention(subject: string): Promise<void> {
    if (this.told || !this.queue.busy().length) return
    this.told = true
    await this.sendText(this.selfJid(), `${this.d.config().prefix}${WA_APPROVAL_TEXT(subject)}`).catch(() => {})
  }

  /** "Xarı Bülbül is connected." in your "Message yourself" chat. */
  async sendTest(): Promise<void> {
    await this.sendText(this.selfJid(), `${this.d.config().prefix}${WA_TEST_TEXT}`)
  }

  // ---------------------------------------------------------------- linking

  /** Asks for an 8-character code to type on the phone instead of scanning the QR code. */
  async pairWithPhone(phone: string): Promise<string> {
    const digits = phone.replace(/[^\d]/g, '').replace(/^00/, '')
    if (!/^[1-9]\d{6,14}$/.test(digits)) throw new Error('Use the full number with the country code, like +4915112345678.')
    if (this.st.state !== 'linking') throw new Error('Wait for the QR code to appear, then try again.')
    const r = await this.request({ cmd: 'pair', phone: digits }, 60_000)
    if (!r.ok || !r.code) throw new Error(r.error || 'WhatsApp didn’t send a code.')
    this.set({ pairingCode: r.code })
    return r.code
  }

  /** Logs this computer out of WhatsApp and deletes the link. The bridge stays stopped until "Link again". */
  async unlink(): Promise<void> {
    this.clearRestart()
    this.installAbort?.abort()
    if (this.proc && this.st.state === 'connected') {
      this.stopping = true
      await this.request({ cmd: 'logout' }, 15_000).catch(() => {})
    }
    this.stopBridge()
    this.forgetLink()
    this.set({ state: 'logged-out', message: 'Not linked.', account: null, qr: null, qrSvg: null, pairingCode: null })
  }

  private forgetLink() {
    this.me = null
    fs.rmSync(path.join(this.d.dataDir, 'whatsapp', 'auth'), { recursive: true, force: true })
  }

  private stopBridge() {
    this.clearRestart()
    this.installAbort?.abort()
    this.stopTyping()
    const child = this.proc
    if (!child) return
    this.stopping = true
    this.proc = null
    this.me = null
    try {
      child.stdin?.write(encodeCommand({ cmd: 'stop' }))
      child.stdin?.end()
    } catch {
      /* already gone */
    }
    // Closing stdin makes the bridge exit; make sure it does.
    const t = setTimeout(() => child.kill(), 3000)
    t.unref?.()
    child.on('exit', () => clearTimeout(t))
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('WhatsApp was turned off.'))
    }
    this.pending.clear()
  }

  dispose() {
    this.disposed = true
    this.stopBridge()
  }
}
