// Terminal text: colours, visible width and wrapping that keeps colours intact.

const ESC = '\x1b['

/** Colours are off when NO_COLOR is set or output isn't a terminal (set once by the UI). */
let colorOn = true
export function setColor(on: boolean) {
  colorOn = on
}

const sgr = (open: string, close: string) => (s: string) => (colorOn && s ? `${ESC}${open}m${s}${ESC}${close}m` : s)

export const style = {
  bold: sgr('1', '22'),
  dim: sgr('2', '22'),
  italic: sgr('3', '23'),
  underline: sgr('4', '24'),
  inverse: sgr('7', '27'),
  red: sgr('31', '39'),
  green: sgr('32', '39'),
  yellow: sgr('33', '39'),
  blue: sgr('34', '39'),
  magenta: sgr('35', '39'),
  cyan: sgr('36', '39'),
  gray: sgr('90', '39'),
  /** The app's accent: the orchid's plum (256-colour, falls back gracefully). */
  accent: sgr('38;5;169', '39'),
  /** Lime, the orchid's second colour. */
  lime: sgr('38;5;149', '39'),
  bgAdd: sgr('48;5;22', '49'),
  bgDel: sgr('48;5;52', '49'),
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Columns a code point takes: 0 for combining marks and zero-width, 2 for wide (CJK, most emoji). */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || (cp >= 0xfe00 && cp <= 0xfe0e) || cp === 0x200d) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x2600 && cp <= 0x27bf && [0x2614, 0x2615, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf].includes(cp)) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

/** Columns `s` takes on screen, ignoring colour codes. */
export function width(s: string): number {
  let w = 0
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!)
  return w
}

/** Pieces of a styled string: escape codes and single characters, in order. */
function tokens(s: string): { esc?: string; ch?: string }[] {
  const out: { esc?: string; ch?: string }[] = []
  let last = 0
  for (const m of s.matchAll(ANSI_RE)) {
    for (const ch of s.slice(last, m.index)) out.push({ ch })
    out.push({ esc: m[0] })
    last = m.index! + m[0].length
  }
  for (const ch of s.slice(last)) out.push({ ch })
  return out
}

/** Cuts a styled string to `cols` columns, adding `…` when it had to cut. */
export function truncate(s: string, cols: number): string {
  if (width(s) <= cols) return s
  let w = 0
  let out = ''
  for (const t of tokens(s)) {
    if (t.esc) {
      out += t.esc
      continue
    }
    const cw = charWidth(t.ch!.codePointAt(0)!)
    if (w + cw > cols - 1) break
    out += t.ch
    w += cw
  }
  return `${out}…${colorOn ? `${ESC}0m` : ''}`
}

/**
 * Wraps a styled line to `cols` columns at spaces (long words are split). Colours carry over:
 * each wrapped line reopens the styles that were active and closes them at its end.
 */
export function wrap(line: string, cols: number): string[] {
  if (cols < 4) cols = 4
  if (width(line) <= cols) return [line]
  const out: string[] = []
  let cur: { esc?: string; ch?: string }[] = []
  let curW = 0
  let active: string[] = []
  let lastSpace = -1
  const open = () => active.join('')
  const flush = (upto: number) => {
    const part = cur.slice(0, upto)
    const text = part.map((t) => t.esc ?? t.ch).join('').replace(/\s+$/, '')
    out.push(text + (colorOn && active.length ? `${ESC}0m` : ''))
  }
  let carry = ''
  for (const t of tokens(line)) {
    if (t.esc) {
      cur.push(t)
      active = /\x1b\[0?m$/.test(t.esc) ? [] : [...active, t.esc]
      continue
    }
    const cw = charWidth(t.ch!.codePointAt(0)!)
    if (curW + cw > cols) {
      // A space that doesn't fit just ends the line.
      if (t.ch === ' ') {
        flush(cur.length)
        carry = open()
        cur = carry ? [{ esc: carry }] : []
        curW = 0
        lastSpace = -1
        continue
      }
      // The next line reopens whatever styles are active here.
      carry = open()
      if (lastSpace > 0) {
        const rest = cur.slice(lastSpace + 1).filter((x) => x.ch)
        flush(lastSpace)
        cur = carry ? [{ esc: carry }, ...rest] : rest
      } else {
        flush(cur.length)
        cur = carry ? [{ esc: carry }] : []
      }
      curW = cur.reduce((n, x) => n + (x.ch ? charWidth(x.ch.codePointAt(0)!) : 0), 0)
      lastSpace = -1
      if (t.ch === ' ' && curW === 0) continue
    }
    if (t.ch === ' ') lastSpace = cur.length
    cur.push(t)
    curW += cw
  }
  if (cur.some((t) => t.ch)) out.push(cur.map((t) => t.esc ?? t.ch).join(''))
  return out
}

/** Pads a styled string with spaces to `cols` columns. */
export function pad(s: string, cols: number): string {
  return s + ' '.repeat(Math.max(0, cols - width(s)))
}

export const cursor = {
  up: (n: number) => (n > 0 ? `${ESC}${n}A` : ''),
  down: (n: number) => (n > 0 ? `${ESC}${n}B` : ''),
  col: (n: number) => `${ESC}${n + 1}G`,
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
  clearDown: `${ESC}J`,
  clearLine: `${ESC}2K`,
}
