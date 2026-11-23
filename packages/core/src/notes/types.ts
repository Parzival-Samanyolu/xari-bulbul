export interface NoteHit {
  /** `<source id>/<ref>`, passed back to notes_read. */
  id: string
  source: string
  title: string
  snippet: string
  /** ISO date, when known. */
  modified: string
}

export interface Note extends NoteHit {
  text: string
}

/** The notes tools' view of the host. Absent when no source is set up, which hides the tools. */
export interface NotesAccess {
  sources(): { id: string; name: string; kind: string }[]
  search(query: string, opts?: { source?: string; limit?: number }, signal?: AbortSignal): Promise<NoteHit[]>
  read(id: string, signal?: AbortSignal): Promise<Note>
}

/** A note id split at the first `/` (refs like Obsidian paths contain more). */
export function parseNoteId(id: string): { source: string; ref: string } {
  const i = id.indexOf('/')
  if (i < 1 || i === id.length - 1) throw new Error(`"${id}" is not a note id from notes_search.`)
  return { source: id.slice(0, i), ref: id.slice(i + 1) }
}

const MAX_NOTE = 30_000

export function clipNote(text: string): string {
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}\n… [cut at ${MAX_NOTE} characters]` : text
}

/** Words of a query, lowercased; quotes keep phrases together. */
export function queryTerms(query: string): string[] {
  const out: string[] = []
  for (const m of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2]).trim())
  return out.filter(Boolean)
}

/** How well a note matches: every term must appear; title hits count more. 0 = no match. An empty query matches everything a little. */
export function scoreNote(terms: string[], title: string, text: string): number {
  if (!terms.length) return 1
  const t = title.toLowerCase()
  const b = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    const inTitle = t.includes(term)
    let n = 0
    for (let i = b.indexOf(term); i !== -1 && n < 50; i = b.indexOf(term, i + term.length)) n++
    if (!inTitle && !n) return 0
    score += (inTitle ? 10 : 0) + n
  }
  return score
}

/** About 200 characters around the first term found. */
export function snippetFor(terms: string[], text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - 60)
  return `${start ? '…' : ''}${flat.slice(start, start + 200)}${start + 200 < flat.length ? '…' : ''}`
}
