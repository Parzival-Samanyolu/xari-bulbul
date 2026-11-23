import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type { NotesSource } from '../settings/schema.js'
import { clipNote, parseNoteId, queryTerms, scoreNote, snippetFor, type Note, type NoteHit, type NotesAccess } from './types.js'

interface Backend {
  search(terms: string[], limit: number, signal?: AbortSignal): Promise<NoteHit[]>
  read(ref: string, signal?: AbortSignal): Promise<Note>
}

// ---------------------------------------------------------------- Obsidian (a folder of Markdown files)

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 2_000_000

export class ObsidianVault implements Backend {
  constructor(
    private readonly id: string,
    private readonly dir: string,
  ) {}

  private root(): string {
    const root = path.resolve(this.dir)
    if (!this.dir.trim() || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Obsidian vault folder not found: ${this.dir || '(not set)'}`)
    return root
  }

  async search(terms: string[], limit: number): Promise<NoteHit[]> {
    const root = this.root()
    const files = await fg('**/*.md', { cwd: root, ignore: ['.obsidian/**', '.trash/**', '**/node_modules/**'], dot: false, onlyFiles: true, followSymbolicLinks: false })
    const hits: (NoteHit & { score: number })[] = []
    for (const rel of files.slice(0, MAX_FILES)) {
      const abs = path.join(root, rel)
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
        if (st.size > MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      const title = path.basename(rel, '.md')
      const text = fs.readFileSync(abs, 'utf8')
      const score = scoreNote(terms, `${title} ${rel}`, text)
      if (score) hits.push({ id: `${this.id}/${rel}`, source: this.id, title, snippet: snippetFor(terms, text), modified: st.mtime.toISOString(), score })
    }
    // Best match first; ties go to the newest note.
    return hits.sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified)).slice(0, limit).map(({ score: _, ...h }) => h)
  }

  async read(ref: string): Promise<Note> {
    const root = this.root()
    const abs = path.resolve(root, ref)
    if (path.relative(root, abs).startsWith('..') || path.isAbsolute(path.relative(root, abs))) throw new Error('That note is outside the vault.')
    if (!fs.existsSync(abs)) throw new Error(`No note ${ref} in the vault.`)
    const text = fs.readFileSync(abs, 'utf8')
    return { id: `${this.id}/${ref}`, source: this.id, title: path.basename(ref, '.md'), snippet: snippetFor([], text), modified: fs.statSync(abs).mtime.toISOString(), text: clipNote(text) }
  }
}

// ---------------------------------------------------------------- Apple Notes (macOS, through osascript)

type RunScript = (script: string, args: string[], signal?: AbortSignal) => Promise<string>

const osascript: RunScript = (script, args, signal) =>
  new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, signal }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr || err.message}`
        reject(new Error(/not allowed|-1743|not authorized/i.test(msg) ? 'Xarı Bülbül may not control Notes yet. Allow it in System Settings › Privacy & Security › Automation.' : `Apple Notes: ${msg.trim().slice(0, 300)}`))
      } else resolve(stdout)
    })
  })

// Every note's id, name, folder, date and text in one call; per-note calls are far slower.
const LIST_NOTES = `function run(argv) {
  const Notes = Application('Notes')
  const folder = argv[0]
  const src = folder ? Notes.folders.byName(folder).notes : Notes.notes
  const ids = src.id(), names = src.name(), texts = src.plaintext(), dates = src.modificationDate()
  const out = []
  for (let i = 0; i < ids.length; i++) out.push({ id: ids[i], title: names[i], text: texts[i], modified: dates[i] ? dates[i].toISOString() : '' })
  return JSON.stringify(out)
}`

const READ_NOTE = `function run(argv) {
  const n = Application('Notes').notes.byId(argv[0])
  return JSON.stringify({ id: n.id(), title: n.name(), text: n.plaintext(), modified: n.modificationDate().toISOString() })
}`

interface AppleNote {
  id: string
  title: string
  text: string
  modified: string
}

export class AppleNotes implements Backend {
  private cache: { at: number; notes: AppleNote[] } | null = null

  constructor(
    private readonly id: string,
    private readonly folder: string,
    private readonly run: RunScript = osascript,
    private readonly platform: string = process.platform,
  ) {}

  private async all(signal?: AbortSignal): Promise<AppleNote[]> {
    if (this.platform !== 'darwin') throw new Error('Apple Notes can only be read on a Mac.')
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.notes
    const notes = JSON.parse(await this.run(LIST_NOTES, this.folder ? [this.folder] : [], signal)) as AppleNote[]
    this.cache = { at: Date.now(), notes }
    return notes
  }

  async search(terms: string[], limit: number, signal?: AbortSignal): Promise<NoteHit[]> {
    const notes = await this.all(signal)
    return notes
      .map((n) => ({ n, score: scoreNote(terms, n.title, n.text) }))
      .filter((x) => x.score)
      .sort((a, b) => b.score - a.score || b.n.modified.localeCompare(a.n.modified))
      .slice(0, limit)
      .map(({ n }) => ({ id: `${this.id}/${n.id}`, source: this.id, title: n.title, snippet: snippetFor(terms, n.text), modified: n.modified }))
  }

  async read(ref: string, signal?: AbortSignal): Promise<Note> {
    if (this.platform !== 'darwin') throw new Error('Apple Notes can only be read on a Mac.')
    const n = JSON.parse(await this.run(READ_NOTE, [ref], signal)) as AppleNote
    return { id: `${this.id}/${n.id}`, source: this.id, title: n.title, snippet: snippetFor([], n.text), modified: n.modified, text: clipNote(n.text) }
  }
}

// ---------------------------------------------------------------- Notion (REST API with an integration token)

const NOTION = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

type Fetch = typeof fetch

interface RichText {
  plain_text?: string
}

/** A page's title from whichever property is the title. */
export function notionTitle(page: { properties?: Record<string, { type?: string; title?: RichText[] }> }): string {
  for (const p of Object.values(page.properties ?? {})) if (p?.type === 'title') return (p.title ?? []).map((t) => t.plain_text ?? '').join('') || 'Untitled'
  return 'Untitled'
}

/** One block as a line of text, Markdown-ish. */
export function notionBlockText(block: Record<string, any>): string {
  const type = block.type as string
  const data = block[type] ?? {}
  const text = ((data.rich_text ?? data.text ?? []) as RichText[]).map((t) => t.plain_text ?? '').join('')
  switch (type) {
    case 'heading_1':
      return `# ${text}`
    case 'heading_2':
      return `## ${text}`
    case 'heading_3':
      return `### ${text}`
    case 'bulleted_list_item':
      return `- ${text}`
    case 'numbered_list_item':
      return `1. ${text}`
    case 'to_do':
      return `- [${data.checked ? 'x' : ' '}] ${text}`
    case 'quote':
      return `> ${text}`
    case 'code':
      return `\`\`\`\n${text}\n\`\`\``
    case 'child_page':
      return `[page: ${data.title ?? ''}]`
    case 'divider':
      return '---'
    default:
      return text
  }
}

export class NotionPages implements Backend {
  constructor(
    private readonly id: string,
    private readonly token: () => string | undefined,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const token = this.token()
    if (!token) throw new Error('No Notion token saved for this source (Settings › Automations › Notes).')
    const res = await this.fetchImpl(`${NOTION}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as { message?: string }
    if (!res.ok) throw new Error(res.status === 401 ? 'Notion refused the token.' : res.status === 404 ? 'Notion page not found. Share it with your integration (••• › Connections).' : `Notion: ${json.message ?? res.status}`)
    return json
  }

  async search(terms: string[], limit: number, signal?: AbortSignal): Promise<NoteHit[]> {
    const json = await this.call('POST', '/search', { query: terms.join(' '), page_size: Math.min(limit, 100), filter: { property: 'object', value: 'page' } }, signal)
    return (json.results ?? []).slice(0, limit).map((p: any) => ({ id: `${this.id}/${p.id}`, source: this.id, title: notionTitle(p), snippet: p.url ?? '', modified: p.last_edited_time ?? '' }))
  }

  private async blocks(blockId: string, depth: number, signal?: AbortSignal): Promise<string[]> {
    const lines: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const json = await this.call('GET', `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, undefined, signal)
      for (const b of json.results ?? []) {
        const line = notionBlockText(b)
        if (line) lines.push(depth ? `${'  '.repeat(depth)}${line}` : line)
        if (b.has_children && depth < 2 && b.type !== 'child_page') lines.push(...(await this.blocks(b.id, depth + 1, signal)))
      }
      if (!json.has_more) break
      cursor = json.next_cursor
    }
    return lines
  }

  async read(ref: string, signal?: AbortSignal): Promise<Note> {
    const page = await this.call('GET', `/pages/${ref}`, undefined, signal)
    const text = (await this.blocks(ref, 0, signal)).join('\n')
    return { id: `${this.id}/${ref}`, source: this.id, title: notionTitle(page), snippet: page.url ?? '', modified: page.last_edited_time ?? '', text: clipNote(text) }
  }
}

// ---------------------------------------------------------------- all sources together

export interface NotesHubOptions {
  /** Notion tokens by source id. */
  secret: (sourceId: string) => string | undefined
  runScript?: RunScript
  platform?: string
  fetch?: Fetch
}

/** Searches and reads every enabled source (or the allowed ones). */
export class NotesHub implements NotesAccess {
  private backends = new Map<string, Backend>()

  constructor(
    private readonly list: NotesSource[],
    private readonly o: NotesHubOptions,
  ) {
    for (const s of list) {
      if (!s.enabled) continue
      if (s.kind === 'obsidian') this.backends.set(s.id, new ObsidianVault(s.id, s.path))
      else if (s.kind === 'apple') this.backends.set(s.id, new AppleNotes(s.id, s.folder, o.runScript, o.platform))
      else this.backends.set(s.id, new NotionPages(s.id, () => o.secret(s.id), o.fetch))
    }
  }

  sources() {
    return this.list.filter((s) => this.backends.has(s.id)).map((s) => ({ id: s.id, name: s.name, kind: s.kind }))
  }

  async search(query: string, opts: { source?: string; limit?: number } = {}, signal?: AbortSignal): Promise<NoteHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
    const ids = opts.source ? [opts.source] : [...this.backends.keys()]
    const terms = queryTerms(query)
    const out: NoteHit[] = []
    const errors: string[] = []
    for (const id of ids) {
      const b = this.backends.get(id)
      if (!b) throw new Error(`No notes source "${id}". Sources: ${[...this.backends.keys()].join(', ') || 'none'}.`)
      try {
        out.push(...(await b.search(terms, limit, signal)))
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`)
      }
    }
    if (!out.length && errors.length) throw new Error(errors.join('\n'))
    return out.slice(0, limit * ids.length)
  }

  async read(id: string, signal?: AbortSignal): Promise<Note> {
    const { source, ref } = parseNoteId(id)
    const b = this.backends.get(source)
    if (!b) throw new Error(`No notes source "${source}".`)
    return b.read(ref, signal)
  }
}
