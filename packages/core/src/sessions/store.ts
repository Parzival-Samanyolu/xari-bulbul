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
  /** Usage of the last request, used to decide when to compact. */
  lastPromptTokens?: number
}

export function newSession(cwd: string, model: ModelRef): Session {
  const now = Date.now()
  return { meta: { id: randomUUID(), title: 'New chat', cwd, model, createdAt: now, updatedAt: now }, messages: [], todos: [] }
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

  deleteAll(): void {
    for (const name of fs.readdirSync(this.dir)) if (name.endsWith('.json')) fs.rmSync(path.join(this.dir, name))
  }
}

export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 60 ? line.slice(0, 57) + '…' : line || 'New chat'
}
