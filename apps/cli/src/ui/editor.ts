// The composer's text buffer: plain functions over { text, cursor } so they are easy to test.

export interface Buffer {
  text: string
  /** Index into text, 0..text.length. */
  cursor: number
}

export const empty: Buffer = { text: '', cursor: 0 }

export const insert = (b: Buffer, s: string): Buffer => ({ text: b.text.slice(0, b.cursor) + s + b.text.slice(b.cursor), cursor: b.cursor + s.length })

export const backspace = (b: Buffer): Buffer =>
  b.cursor === 0 ? b : { text: b.text.slice(0, b.cursor - 1) + b.text.slice(b.cursor), cursor: b.cursor - 1 }

export const del = (b: Buffer): Buffer => (b.cursor >= b.text.length ? b : { text: b.text.slice(0, b.cursor) + b.text.slice(b.cursor + 1), cursor: b.cursor })

export const left = (b: Buffer): Buffer => ({ ...b, cursor: Math.max(0, b.cursor - 1) })
export const right = (b: Buffer): Buffer => ({ ...b, cursor: Math.min(b.text.length, b.cursor + 1) })

function lineStart(text: string, i: number) {
  return text.lastIndexOf('\n', i - 1) + 1
}
function lineEnd(text: string, i: number) {
  const n = text.indexOf('\n', i)
  return n === -1 ? text.length : n
}

export const home = (b: Buffer): Buffer => ({ ...b, cursor: lineStart(b.text, b.cursor) })
export const end = (b: Buffer): Buffer => ({ ...b, cursor: lineEnd(b.text, b.cursor) })

/** Moves up a line, keeping the column; null when already on the first line (caller shows history). */
export function up(b: Buffer): Buffer | null {
  const start = lineStart(b.text, b.cursor)
  if (start === 0) return null
  const col = b.cursor - start
  const prevStart = lineStart(b.text, start - 1)
  return { ...b, cursor: Math.min(prevStart + col, start - 1) }
}

/** Moves down a line; null when already on the last line. */
export function down(b: Buffer): Buffer | null {
  const end_ = lineEnd(b.text, b.cursor)
  if (end_ === b.text.length) return null
  const col = b.cursor - lineStart(b.text, b.cursor)
  return { ...b, cursor: Math.min(end_ + 1 + col, lineEnd(b.text, end_ + 1)) }
}

/** Ctrl+W: deletes the word before the cursor (and the spaces after it). */
export function deleteWord(b: Buffer): Buffer {
  let i = b.cursor
  while (i > 0 && /\s/.test(b.text[i - 1])) i--
  while (i > 0 && !/\s/.test(b.text[i - 1])) i--
  return { text: b.text.slice(0, i) + b.text.slice(b.cursor), cursor: i }
}

/** Ctrl+U: deletes from the start of the line to the cursor. */
export function deleteToLineStart(b: Buffer): Buffer {
  const s = lineStart(b.text, b.cursor)
  if (s === b.cursor && s > 0) return backspace(b)
  return { text: b.text.slice(0, s) + b.text.slice(b.cursor), cursor: s }
}

/** Word left/right (Alt+←/→). */
export function wordLeft(b: Buffer): Buffer {
  let i = b.cursor
  while (i > 0 && /\s/.test(b.text[i - 1])) i--
  while (i > 0 && !/\s/.test(b.text[i - 1])) i--
  return { ...b, cursor: i }
}
export function wordRight(b: Buffer): Buffer {
  let i = b.cursor
  while (i < b.text.length && /\s/.test(b.text[i])) i++
  while (i < b.text.length && !/\s/.test(b.text[i])) i++
  return { ...b, cursor: i }
}

/** The token being typed at the cursor if it starts with `/` (at the very start) or `@`. */
export function activeToken(b: Buffer): { kind: 'slash' | 'mention'; query: string; start: number } | null {
  const before = b.text.slice(0, b.cursor)
  const slash = /^\/([\w:-]*)$/.exec(before)
  if (slash) return { kind: 'slash', query: slash[1], start: 0 }
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: 'mention', query: at[2], start: b.cursor - at[2].length - 1 }
  return null
}

/** Replaces the token that starts at `start` (up to the cursor) with `replacement`. */
export function replaceToken(b: Buffer, start: number, replacement: string): Buffer {
  return { text: b.text.slice(0, start) + replacement + b.text.slice(b.cursor), cursor: start + replacement.length }
}

/** Large pastes become a placeholder so the composer stays readable; expanded on send. */
export const PASTE_CHARS = 1000
export const PASTE_LINES = 12

export function pasteLabel(text: string, n: number): string {
  const lines = text.split('\n').length
  return lines > 1 ? `[Pasted ${lines} lines${n > 1 ? ` #${n}` : ''}]` : `[Pasted ${text.length} chars${n > 1 ? ` #${n}` : ''}]`
}

export function expandPastes(text: string, pastes: Map<string, string>): string {
  let out = text
  for (const [label, content] of pastes) out = out.split(label).join(content)
  return out
}

/** Subsequence match with a score (lower is better), for `/` and `@` popups. */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t.startsWith(q)) return 0
  const idx = t.indexOf(q)
  if (idx >= 0) return 1 + idx / 100
  let ti = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    gaps += found - ti
    ti = found + 1
  }
  return 2 + gaps / 10
}

/** Indices of `query`'s characters inside `target` (for highlighting); empty when none. */
export function fuzzyIndices(query: string, target: string): number[] {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const sub = t.indexOf(q)
  if (q && sub >= 0) return Array.from({ length: q.length }, (_, i) => sub + i)
  const out: number[] = []
  let ti = 0
  for (const ch of q) {
    const f = t.indexOf(ch, ti)
    if (f === -1) return []
    out.push(f)
    ti = f + 1
  }
  return out
}
