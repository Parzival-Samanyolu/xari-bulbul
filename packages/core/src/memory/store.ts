import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** `bot`: facts only one bot sees (bots with `memory: 'own'`); its key is the bot id instead of a folder. */
export type MemoryScope = 'project' | 'global' | 'bot'

/** Memory bound to one workspace (and bot), as handed to tools. */
export interface MemoryAccess {
  list(scope: MemoryScope): string[]
  add(scope: MemoryScope, fact: string): void
  remove(scope: MemoryScope, match: string): string
}

/**
 * Facts the agent keeps across chats, stored as Markdown bullet lists in app data:
 * `<dir>/global.md` and `<dir>/projects/<hash of the NFC folder path>.md`.
 * Nothing is written into the user's project.
 */
export class MemoryStore {
  constructor(
    readonly dir: string,
    /** Size limit per scope; hosts update it when settings change. */
    public maxChars = 6000,
  ) {}

  /** `cwd` is the folder for project memory and the bot id for bot memory. */
  file(scope: MemoryScope, cwd: string): string {
    if (scope === 'global') return path.join(this.dir, 'global.md')
    if (scope === 'bot') return path.join(this.dir, 'bots', `${cwd.replace(/[^\w-]/g, '_') || '_'}.md`)
    const key = crypto.createHash('sha256').update(cwd.normalize('NFC')).digest('hex').slice(0, 16)
    return path.join(this.dir, 'projects', `${key}.md`)
  }

  list(scope: MemoryScope, cwd: string): string[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file(scope, cwd), 'utf8')
    } catch {
      return []
    }
    return raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean)
  }

  add(scope: MemoryScope, cwd: string, fact: string): void {
    const clean = fact.replace(/\s*\r?\n\s*/g, ' ').trim()
    if (!clean) throw new Error('The fact is empty.')
    const facts = this.list(scope, cwd)
    if (facts.includes(clean)) return
    const size = [...facts, clean].reduce((n, f) => n + f.length + 3, 0)
    if (size > this.maxChars) {
      throw new Error(`Memory is full (${this.maxChars} characters for ${scope} memory); remove or merge entries first.`)
    }
    this.write(scope, cwd, [...facts, clean])
  }

  /** Removes the one fact containing `match` (case-insensitive) and returns it. */
  remove(scope: MemoryScope, cwd: string, match: string): string {
    const facts = this.list(scope, cwd)
    const needle = match.trim().toLowerCase()
    const hits = facts.filter((f) => f.toLowerCase().includes(needle))
    if (!needle || hits.length === 0) throw new Error(`No memory matches "${match}".`)
    if (hits.length > 1) throw new Error(`${hits.length} memories match "${match}"; be more specific:\n${hits.map((h) => `- ${h}`).join('\n')}`)
    this.write(
      scope,
      cwd,
      facts.filter((f) => f !== hits[0]),
    )
    return hits[0]
  }

  /** Removes a fact by its exact text (used by the Settings UI). */
  delete(scope: MemoryScope, cwd: string, fact: string): void {
    this.write(
      scope,
      cwd,
      this.list(scope, cwd).filter((f) => f !== fact),
    )
  }

  clear(scope: MemoryScope, cwd: string): void {
    fs.rmSync(this.file(scope, cwd), { force: true })
  }

  /** Memory for one folder; `botId` adds that bot's own memory (otherwise the bot scope is refused). */
  scoped(cwd: string, botId?: string): MemoryAccess {
    const key = (scope: MemoryScope) => {
      if (scope !== 'bot') return cwd
      if (!botId) throw new Error('This chat has no bot memory; use "project" or "global".')
      return botId
    }
    return {
      list: (scope) => (scope === 'bot' && !botId ? [] : this.list(scope, key(scope))),
      add: (scope, fact) => this.add(scope, key(scope), fact),
      remove: (scope, match) => this.remove(scope, key(scope), match),
    }
  }

  private write(scope: MemoryScope, cwd: string, facts: string[]) {
    const file = this.file(scope, cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const header = scope === 'global' ? '<!-- Xarı Bülbül: global memory -->' : scope === 'bot' ? `<!-- Xarı Bülbül: memory of bot ${cwd} -->` : `<!-- ${cwd.normalize('NFC')} -->`
    fs.writeFileSync(file, `${header}\n${facts.map((f) => `- ${f}`).join('\n')}\n`)
  }
}
