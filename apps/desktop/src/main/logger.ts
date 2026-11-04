// The app log: JSON lines in <data>/logs/app-YYYY-MM-DD.log, one file per local day.
// Files older than KEEP_DAYS are deleted at launch and when the day changes; a day's file stops
// growing at MAX_FILE_BYTES and the folder at MAX_TOTAL_BYTES. Every message is passed through
// redactSecrets first, and callers log ids and status codes, never prompts or file contents.

import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from '@harness/core'
import type { LogEntry, LogLevel } from '../shared/ipc'

const KEEP_DAYS = 7
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 30 * 1024 * 1024
const MAX_MESSAGE = 2000
/** Entries `read()` returns at most (newest first). */
const READ_LIMIT = 3000
const FILE = /^app-(\d{4}-\d{2}-\d{2})\.log$/

type Data = Record<string, string | number | boolean | null | undefined>

const dayOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function cleanData(data: Data | undefined): LogEntry['data'] {
  if (!data) return undefined
  const out: NonNullable<LogEntry['data']> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue
    out[k] = typeof v === 'string' ? redactSecrets(v).slice(0, 500) : v
  }
  return Object.keys(out).length ? out : undefined
}

/** One line of the exported text form. */
export function formatEntry(e: LogEntry): string {
  const data = e.data ? ` ${Object.entries(e.data).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ')}` : ''
  return `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.src}] ${e.msg}${data}`
}

class AppLog {
  private dir: string | null = null
  /** Entries logged before init(), written once the folder is known. */
  private early: LogEntry[] = []
  private day = ''
  private size = 0
  private full = false

  /** The logs folder, once known. */
  get folder(): string | null {
    return this.dir
  }

  init(dataDir: string) {
    this.dir = path.join(dataDir, 'logs')
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch {
      /* logging stays off; the app goes on */
    }
    this.prune()
    const early = this.early
    this.early = []
    for (const e of early) this.append(e)
  }

  debug(src: string, msg: string, data?: Data) {
    this.write('debug', src, msg, data)
  }
  info(src: string, msg: string, data?: Data) {
    this.write('info', src, msg, data)
  }
  warn(src: string, msg: string, data?: Data) {
    this.write('warn', src, msg, data)
  }
  error(src: string, msg: string, data?: Data) {
    this.write('error', src, msg, data)
  }

  write(level: LogLevel, src: string, msg: string, data?: Data) {
    const entry: LogEntry = { t: Date.now(), level, src, msg: redactSecrets(String(msg ?? '')).slice(0, MAX_MESSAGE) }
    const d = cleanData(data)
    if (d) entry.data = d
    if (!this.dir) {
      if (this.early.length < 500) this.early.push(entry)
      return
    }
    this.append(entry)
  }

  private append(e: LogEntry) {
    if (!this.dir) return
    const day = dayOf(e.t)
    const file = path.join(this.dir, `app-${day}.log`)
    if (day !== this.day) {
      if (this.day) this.prune()
      this.day = day
      this.full = false
      try {
        this.size = fs.statSync(file).size
      } catch {
        this.size = 0
      }
    }
    if (this.full) return
    let line = JSON.stringify(e) + '\n'
    if (this.size + line.length > MAX_FILE_BYTES) {
      // One last line says why the day's log stops here.
      this.full = true
      line = JSON.stringify({ t: e.t, level: 'warn', src: 'log', msg: `Today's log reached ${MAX_FILE_BYTES / 1024 / 1024} MB; later entries today are dropped.` } satisfies LogEntry) + '\n'
    }
    try {
      fs.appendFileSync(file, line)
      this.size += Buffer.byteLength(line)
    } catch {
      /* a full disk or a removed folder must not break the app */
    }
  }

  /** Log files, newest first. */
  private files(): string[] {
    if (!this.dir) return []
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => FILE.test(f))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** Deletes files older than KEEP_DAYS, then the oldest ones until the folder is under MAX_TOTAL_BYTES. */
  prune() {
    if (!this.dir) return
    const cutoff = dayOf(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000)
    let total = 0
    for (const f of this.files()) {
      const p = path.join(this.dir, f)
      try {
        const size = fs.statSync(p).size
        if (FILE.exec(f)![1] < cutoff || total + size > MAX_TOTAL_BYTES) fs.rmSync(p, { force: true })
        else total += size
      } catch {
        /* gone already */
      }
    }
  }

  /** The newest entries, newest first. */
  read(limit = READ_LIMIT): LogEntry[] {
    const out: LogEntry[] = []
    for (const f of this.files()) {
      let text = ''
      try {
        text = fs.readFileSync(path.join(this.dir!, f), 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i]) continue
        try {
          const e = JSON.parse(lines[i]) as LogEntry
          if (typeof e.t === 'number' && typeof e.msg === 'string') out.push(e)
        } catch {
          /* a torn line */
        }
      }
      if (out.length >= limit) break
    }
    return out
  }

  /** Every kept entry as plain text, oldest first. */
  exportText(): string {
    return this.read(Number.MAX_SAFE_INTEGER).reverse().map(formatEntry).join('\n') + '\n'
  }
}

/** The app's one log. Entries before init() are kept in memory and written then. */
export const log = new AppLog()

/** An error's message, for a log line. */
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
