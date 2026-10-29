import { z } from 'zod'
import type { Session } from '../sessions/store.js'
import type { ToolCall } from '../types.js'
import { defineTool } from './types.js'

export const SESSION_SEARCH_TOOL = 'session_search'

/** Saved chats read per search, newest first. */
const MAX_SCANNED = 200
const SNIPPETS_PER_CHAT = 3
const SNIPPET_CHARS = 160

interface Hit {
  title: string
  id: string
  cwd: string
  updatedAt: number
  /** Distinct query terms found, then total occurrences: the ranking. */
  terms: number
  count: number
  snippets: string[]
}

/** What a tool call was about: its string arguments (path, command, pattern…). */
function callSubject(call: ToolCall): string {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>
    const values = Object.values(args ?? {}).filter((v): v is string => typeof v === 'string')
    return `${call.name} ${values.join(' ')}`.trim()
  } catch {
    return call.name
  }
}

/** Searchable lines of a chat, labeled by who wrote them. Engine notes and tool output are left out. */
function texts(session: Session): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = []
  for (const m of session.messages) {
    if (m.role === 'user' && !m.synthetic) out.push({ label: 'user', text: m.content })
    else if (m.role === 'assistant') {
      if (m.content.trim()) out.push({ label: 'assistant', text: m.content })
      for (const call of m.toolCalls ?? []) out.push({ label: 'tool', text: callSubject(call) })
    }
  }
  return out
}

function count(haystack: string, term: string): number {
  let n = 0
  for (let i = haystack.indexOf(term); i !== -1; i = haystack.indexOf(term, i + term.length)) n++
  return n
}

/** A short, single-line excerpt centered on the first match. */
function snippet(text: string, at: number, length: number): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  const start = Math.max(0, at - Math.floor((SNIPPET_CHARS - length) / 2))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${flat(text.slice(start, end)).trim()}${end < text.length ? '…' : ''}`
}

function search(session: Session, terms: string[]): Pick<Hit, 'terms' | 'count' | 'snippets'> {
  const found = new Set<string>()
  let total = 0
  const snippets: string[] = []
  const lines = [{ label: 'title', text: session.meta.title }, ...texts(session)]
  for (const { label, text } of lines) {
    const lower = text.toLowerCase()
    let first = -1
    let firstLen = 0
    for (const term of terms) {
      const n = count(lower, term)
      if (!n) continue
      found.add(term)
      total += n
      const at = lower.indexOf(term)
      if (first === -1 || at < first) (first = at), (firstLen = term.length)
    }
    if (first !== -1 && label !== 'title' && snippets.length < SNIPPETS_PER_CHAT) snippets.push(`${label}: ${snippet(text, first, firstLen)}`)
  }
  return { terms: found.size, count: total, snippets }
}

export const sessionSearchTool = defineTool({
  name: SESSION_SEARCH_TOOL,
  description:
    'Search the user\'s past chats for a topic, error or decision. Use it when the user refers to earlier work ("like last time", "the bug we fixed") or when a past chat may already hold the answer. ' +
    'Matches words case-insensitively in user and assistant messages and tool calls; returns each chat\'s title, date, id and a few snippets.',
  input: z.object({
    query: z.string().min(1).describe('Words to look for; chats matching more of them rank first'),
    scope: z.enum(['project', 'all']).optional().describe('"project" (default) for chats in this folder, "all" for every folder'),
    limit: z.number().int().min(1).max(20).optional().describe('How many chats to return (default 5)'),
  }),
  kind: 'read',
  readOnly: true,
  subject: (i) => i.query,
  async execute(input, ctx) {
    if (!ctx.sessions) return { content: 'Past chats are not available here.', isError: true }
    const terms = [...new Set(input.query.toLowerCase().split(/\s+/).filter(Boolean))]
    if (!terms.length) return { content: 'Give some words to search for.', isError: true }
    const scope = input.scope ?? 'project'
    const metas = ctx.sessions.list(scope === 'project' ? { cwd: ctx.cwd } : undefined).filter((m) => m.id !== ctx.sessions!.exclude)
    const hits: Hit[] = []
    for (const meta of metas.slice(0, MAX_SCANNED)) {
      if (ctx.signal.aborted) break
      const session = ctx.sessions.load(meta.id)
      if (!session) continue
      const r = search(session, terms)
      if (r.count) hits.push({ title: meta.title, id: meta.id, cwd: meta.cwd, updatedAt: meta.updatedAt, ...r })
    }
    // Stable sort keeps newest first among equals.
    hits.sort((a, b) => b.terms - a.terms || b.count - a.count || b.updatedAt - a.updatedAt)
    const where = scope === 'project' ? 'in this folder' : 'in any folder'
    const capped = metas.length > MAX_SCANNED ? ` (searched the newest ${MAX_SCANNED} of ${metas.length})` : ''
    if (!hits.length) return { content: `No past chats ${where} mention "${input.query}"${capped}.` }
    const shown = hits.slice(0, input.limit ?? 5)
    const lines = [`${hits.length} past chat${hits.length === 1 ? '' : 's'} ${where} match "${input.query}"${capped}:`]
    shown.forEach((h, i) => {
      const date = new Date(h.updatedAt).toISOString().slice(0, 10)
      lines.push('', `${i + 1}. ${h.title} (${date}, id ${h.id}${scope === 'all' ? `, ${h.cwd}` : ''})`)
      for (const s of h.snippets) lines.push(`   - ${s}`)
    })
    return { content: lines.join('\n') }
  },
})
