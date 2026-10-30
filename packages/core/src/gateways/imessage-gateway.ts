import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../settings/schema.js'
import {
  APPLE_EPOCH_MS,
  APPROVAL_TEXT,
  KeyedQueue,
  RecentlySent,
  TEST_TEXT,
  allowedSender,
  messageText,
  normalizeSender,
  osascriptArgs,
  readGatewayState,
  sendErrorKind,
  splitReply,
  stripMarkdown,
  writeGatewayState,
} from './imessage.js'

// Reads new texts from Messages' database, runs them through the agent and texts the reply back.
// Runs only while the app is open; the app decides which chat a sender's message goes to.

export type IMessageConfig = Settings['gateways']['imessage']

export const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')

export interface ChatDbRow {
  rowid: number
  /** `handle.id`: a phone number or email. */
  handle: string
  text: string | null
  /** `message.attributedBody`. */
  body: Uint8Array | null
  /** When it was sent, ms since 1970. */
  at: number
}

export interface ChatDb {
  maxRowid(): number
  /** Incoming one-to-one messages after `rowid`, oldest first. */
  since(rowid: number, limit: number): ChatDbRow[]
  close(): void
}

export type ChatDbOpener = (file: string) => ChatDb

/** Why the database couldn't be read. `no-access` = Full Disk Access is missing. */
export type ChatDbProblem = 'no-access' | 'missing' | 'other'

export class ChatDbError extends Error {
  constructor(
    readonly problem: ChatDbProblem,
    message: string,
  ) {
    super(message)
  }
}

const SINCE_SQL = `
SELECT m.ROWID AS rowid, h.id AS handle, m.text AS text, m.attributedBody AS body,
  CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END AS ms
FROM message m JOIN handle h ON h.ROWID = m.handle_id
WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.cache_roomnames IS NULL
  AND (m.item_type IS NULL OR m.item_type = 0)
ORDER BY m.ROWID LIMIT ?`

/** Opens chat.db read-only with `node:sqlite` (built into Electron's Node). */
export function openChatDb(file: string): ChatDb {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) throw new ChatDbError('other', 'This version of the app cannot read SQLite databases.')
  if (!fs.existsSync(file)) {
    // Without Full Disk Access, the Messages folder can't even be listed.
    const dir = path.dirname(file)
    try {
      fs.readdirSync(dir)
    } catch (e) {
      if (isPermissionError(e)) throw new ChatDbError('no-access', 'macOS blocked reading your messages.')
    }
    throw new ChatDbError('missing', 'No Messages database on this Mac. Sign in to Messages with your Apple ID first.')
  }
  let db: import('node:sqlite').DatabaseSync
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    // Opening is lazy for some errors; touch the schema now.
    db.prepare('SELECT 1 FROM message LIMIT 1').get()
  } catch (e) {
    throw classifyOpenError(e)
  }
  const since = db.prepare(SINCE_SQL)
  return {
    maxRowid: () => Number((db.prepare('SELECT MAX(ROWID) AS id FROM message').get() as { id: number | null } | undefined)?.id ?? 0),
    since: (rowid, limit) =>
      (since.all(rowid, limit) as { rowid: number; handle: string; text: string | null; body: Uint8Array | null; ms: number }[]).map((r) => ({
        rowid: Number(r.rowid),
        handle: String(r.handle ?? ''),
        text: r.text ?? null,
        body: r.body ?? null,
        at: Number(r.ms) + APPLE_EPOCH_MS,
      })),
    close: () => db.close(),
  }
}

function isPermissionError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/** SQLITE_CANTOPEN (14), SQLITE_AUTH (23), SQLITE_PERM (3), EPERM and EACCES mean macOS said no. */
export function classifyOpenError(e: unknown): ChatDbError {
  if (e instanceof ChatDbError) return e
  const err = e as { errcode?: number; code?: string; message?: string }
  const msg = String(err?.message ?? e)
  if (isPermissionError(e) || [3, 14, 23].includes(err?.errcode ?? -1) || /unable to open|authori[sz]ation denied|operation not permitted/i.test(msg)) {
    return new ChatDbError('no-access', 'macOS blocked reading your messages.')
  }
  return new ChatDbError('other', `Couldn't read the Messages database: ${msg}`)
}

/** Runs osascript with the arguments (no shell); rejects with its error text. */
export function runOsascript(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: 30_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()))
      else resolve()
    })
  })
}

export interface IMessageStatus {
  /** off · needs-setup (no sender or folder) · listening · no-access (Full Disk Access) · missing (no chat.db) · error */
  state: 'off' | 'needs-setup' | 'listening' | 'no-access' | 'missing' | 'error'
  message: string | null
  /** Whether macOS lets the app control Messages: unknown until the first send. */
  automation: 'unknown' | 'ok' | 'denied'
  /** The last send that failed, unless a later one worked. */
  sendError: string | null
  /** The last message that couldn't run, unless a later one did. */
  runError: string | null
  lastReceivedAt: number | null
  lastSentAt: number | null
  /** Senders with a message running or waiting. */
  busy: string[]
}

export interface IMessageGatewayDeps {
  /** `<dataDir>/gateways.json`: the last ROWID seen. */
  stateFile: string
  config: () => IMessageConfig
  /** Runs a message in the sender's chat; resolves with the reply to text back (null = nothing). */
  run: (sender: string, text: string) => Promise<string | null>
  onChange?: () => void
  openDb?: ChatDbOpener
  dbFile?: string
  /** Runs osascript; replaced in tests. */
  osascript?: (args: string[]) => Promise<void>
  now?: () => number
  platform?: NodeJS.Platform
  /** Older messages (sent while the app was closed) are skipped. */
  maxAgeMs?: number
  /** Whether to arm a poll timer; tests call `poll()` themselves. */
  timer?: boolean
}

export class IMessageGateway {
  private readonly queue = new KeyedQueue()
  private readonly recent = new RecentlySent()
  /** Senders already told about a pending approval this turn. */
  private told = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private timerSeconds = 0
  private polling = false
  private active = false
  private disposed = false
  private st: IMessageStatus = { state: 'off', message: null, automation: 'unknown', sendError: null, runError: null, lastReceivedAt: null, lastSentAt: null, busy: [] }

  constructor(private readonly d: IMessageGatewayDeps) {}

  private get now() {
    return this.d.now?.() ?? Date.now()
  }

  private changed() {
    this.d.onChange?.()
  }

  private set(next: Partial<IMessageStatus>) {
    this.st = { ...this.st, ...next }
  }

  status(): IMessageStatus {
    return { ...this.st, busy: this.queue.busy() }
  }

  /** Senders the config allows, normalized. */
  private senders(): string[] {
    return this.d.config().senders.map(normalizeSender).filter((s): s is string => !!s)
  }

  /** Starts, stops or re-times polling to match the settings. */
  sync(): void {
    if (this.disposed) return
    const cfg = this.d.config()
    const mac = (this.d.platform ?? process.platform) === 'darwin'
    if (!mac || !cfg.enabled) {
      if (this.active) this.clearCursor()
      this.active = false
      this.stopTimer()
      this.set({ state: 'off', message: null })
      return
    }
    this.active = true
    if (!this.senders().length || !cfg.cwd.trim()) {
      this.stopTimer()
      this.set({ state: 'needs-setup', message: !this.senders().length ? 'Add at least one allowed sender.' : 'Choose a folder for the chats.' })
      return
    }
    if (this.d.timer !== false && (!this.timer || this.timerSeconds !== cfg.pollSeconds)) {
      this.stopTimer()
      this.timerSeconds = cfg.pollSeconds
      this.timer = setInterval(() => void this.poll(), cfg.pollSeconds * 1000)
      this.timer.unref?.()
    }
    void this.poll()
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Turning the gateway off forgets the place, so turning it on again starts from now. */
  private clearCursor() {
    const state = readGatewayState(this.d.stateFile)
    if (!state.imessage) return
    delete state.imessage
    try {
      writeGatewayState(this.d.stateFile, state)
    } catch {
      /* the next start just begins from the saved place */
    }
  }

  /** Reads new messages once and starts a turn for each one from an allowed sender. */
  async poll(): Promise<void> {
    if (this.polling || this.disposed || !this.active) return
    const cfg = this.d.config()
    const senders = this.senders()
    if (!senders.length || !cfg.cwd.trim()) return
    this.polling = true
    const before = JSON.stringify(this.st)
    try {
      let db: ChatDb
      try {
        db = (this.d.openDb ?? openChatDb)(this.d.dbFile ?? CHAT_DB_PATH)
      } catch (e) {
        const err = classifyOpenError(e)
        this.set({ state: err.problem === 'no-access' ? 'no-access' : err.problem === 'missing' ? 'missing' : 'error', message: err.message })
        return
      }
      try {
        const saved = readGatewayState(this.d.stateFile)
        let cursor = saved.imessage?.cursor
        // First start: only messages from now on, no backlog.
        if (typeof cursor !== 'number') cursor = db.maxRowid()
        const start = cursor
        for (const row of db.since(cursor, 100)) {
          cursor = Math.max(cursor, row.rowid)
          const sender = allowedSender(row.handle, senders)
          if (!sender) continue
          if (this.now - row.at > (this.d.maxAgeMs ?? 10 * 60_000)) continue
          const text = messageText(row)
          if (!text || this.recent.isEcho(text, this.now)) continue
          this.set({ lastReceivedAt: this.now })
          this.dispatch(sender, text)
        }
        if (cursor !== start || saved.imessage?.cursor !== cursor) writeGatewayState(this.d.stateFile, { ...saved, imessage: { ...saved.imessage, cursor } })
        this.set({ state: 'listening', message: null })
      } catch (e) {
        this.set({ state: 'error', message: `Couldn't read new messages: ${(e as Error).message}` })
      } finally {
        db.close()
      }
    } finally {
      this.polling = false
      if (JSON.stringify(this.st) !== before) this.changed()
    }
  }

  /** Queues a message behind the sender's running turn, then texts the reply back. */
  dispatch(sender: string, text: string): Promise<void> {
    const job = this.queue.run(sender, async () => {
      this.told.delete(sender)
      this.changed()
      const reply = await this.d.run(sender, text)
      this.told.delete(sender)
      this.set({ runError: null })
      if (reply?.trim()) await this.sendReply(sender, reply)
    })
    return job
      .catch((e) => {
        this.set({ runError: `The last text from ${sender} failed: ${(e as Error).message}` })
      })
      .finally(() => this.changed())
  }

  /** Once per turn: tells the sender an approval or question waits in the app. */
  async needsAttention(sender: string, subject: string): Promise<void> {
    // Only for turns a text started; you're at the app for the ones you typed there.
    if (this.told.has(sender) || !this.queue.busy().includes(sender)) return
    this.told.add(sender)
    await this.sendText(sender, APPROVAL_TEXT(subject)).catch(() => {})
  }

  async sendReply(sender: string, reply: string): Promise<void> {
    for (const part of splitReply(stripMarkdown(reply))) await this.sendText(sender, part)
  }

  /** "Xarı Bülbül is connected." to the first allowed sender. */
  async sendTest(): Promise<void> {
    const to = this.senders()[0]
    if (!to) throw new Error('Add an allowed sender first.')
    await this.sendText(to, TEST_TEXT)
  }

  private async sendText(to: string, text: string): Promise<void> {
    if ((this.d.platform ?? process.platform) !== 'darwin') throw new Error('iMessage works only on macOS.')
    const args = osascriptArgs(to, text)
    this.recent.add(text, this.now)
    try {
      await (this.d.osascript ?? runOsascript)(args)
      this.set({ automation: 'ok', sendError: null, lastSentAt: this.now })
    } catch (e) {
      const msg = (e as Error).message
      const denied = sendErrorKind(msg) === 'automation'
      this.set({
        automation: denied ? 'denied' : this.st.automation,
        sendError: denied ? 'macOS blocked the app from controlling Messages.' : `Messages couldn't send: ${msg}`,
      })
      throw new Error(denied ? 'macOS blocked the app from controlling Messages. Allow it in System Settings › Privacy & Security › Automation.' : `Messages couldn't send: ${msg}`)
    } finally {
      this.changed()
    }
  }

  dispose() {
    this.disposed = true
    this.stopTimer()
  }
}
