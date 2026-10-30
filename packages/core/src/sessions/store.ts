import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ModelRef, TodoItem } from '../types.js'
import type { ToolDisplay } from '../tools/types.js'

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  model: ModelRef
  createdAt: number
  updatedAt: number
  /** The bot this chat was started with (Settings › Bots). Kept when bots are turned off. */
  botId?: string
  /** One line of the last message, kept for bot chats (the Bots tab shows it). */
  preview?: string
  /** Mixture of Agents for this chat (the composer toggle). Unset follows `moa.enabled`. */
  moa?: boolean
  /** Set on chats a gateway runs, e.g. "imessage:+15551234567" (one chat per sender) or "whatsapp:self". */
  gateway?: string
}

export interface Session {
  meta: SessionMeta
  /** Conversation history without the system prompt (it's rebuilt every request). */
  messages: ChatMessage[]
  todos: TodoItem[]
  /** Rich tool output (diffs) keyed by tool call id, so reopened sessions still show them. */
  displays?: Record<string, ToolDisplay>
  /** Tool calls the user denied. */
  denied?: string[]
  /** Files as they were before each turn's edits, so a turn can be reverted. */
  checkpoints?: Checkpoint[]
  /** A note for the model, sent with the next user message (e.g. files the user reverted). */
  pendingNote?: string
  /** Usage of the last request, used to decide when to compact. */
  lastPromptTokens?: number
}

export interface Checkpoint {
  /** Index in `messages` of the user message that started the turn. */
  at: number
  /** Absolute path → content before the turn's first edit, or null if the turn created the file. */
  files: Record<string, string | null>
}

export function newSession(cwd: string, model: ModelRef, opts: { botId?: string } = {}): Session {
  const now = Date.now()
  return { meta: { id: randomUUID(), title: 'New chat', cwd, model, createdAt: now, updatedAt: now, ...(opts.botId ? { botId: opts.botId } : {}) }, messages: [], todos: [] }
}

/** One JSON file per session. Written atomically (tmp + rename). */
export class SessionStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private file(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid session id')
    return path.join(this.dir, `${id}.json`)
  }

  save(session: Session): void {
    session.meta.updatedAt = Date.now()
    const target = this.file(session.meta.id)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(session))
    fs.renameSync(tmp, target)
  }

  load(id: string): Session | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8'))
    } catch {
      return null
    }
  }

  list(filter?: { cwd?: string }): SessionMeta[] {
    const metas: SessionMeta[] = []
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as Session
        // Compare in NFC: macOS can hand back the same folder name in a different Unicode form (ı, ü…).
        if (!filter?.cwd || s.meta.cwd.normalize('NFC') === filter.cwd.normalize('NFC')) metas.push(s.meta)
      } catch {
        /* skip corrupt */
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  delete(id: string): void {
    fs.rmSync(this.file(id), { force: true })
  }

  /** Deletes chats last changed before `before` (ms since epoch), except those `keep` returns true for. Returns the deleted ids. */
  prune(before: number, keep: (id: string) => boolean = () => false): string[] {
    const gone: string[] = []
    for (const meta of this.list()) {
      if (meta.updatedAt >= before || keep(meta.id)) continue
      this.delete(meta.id)
      gone.push(meta.id)
    }
    return gone
  }

  deleteAll(): void {
    for (const name of fs.readdirSync(this.dir)) if (name.endsWith('.json')) fs.rmSync(path.join(this.dir, name))
  }
}

export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 60 ? line.slice(0, 57) + '…' : line || 'New chat'
}
