// Replies arrive as Markdown. This renders the parts that matter in a terminal (headings, lists,
// code blocks, quotes, inline code, bold, italics, links) and leaves the rest as text.
import { style, width, wrap } from './ansi.js'

/** Inline styles: `code`, **bold**, *italic* / _italic_, [text](url). */
export function inline(s: string): string {
  const codes: string[] = []
  // Code spans first, so their content is never styled further.
  const hold = (styled: string) => {
    codes.push(styled)
    return `\u0000${codes.length - 1}\u0000`
  }
  // Code spans and links are set aside first: styling adds escape codes, and their "[" would
  // otherwise look like the start of a link.
  let out = s
    .replace(/`([^`]+)`/g, (_, c: string) => hold(style.cyan(c)))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, url: string) => hold(t === url ? style.underline(url) : `${t} ${style.dim(`(${url})`)}`))
  out = out
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => style.bold(t))
    .replace(/__([^_]+)__/g, (_, t) => style.bold(t))
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, (_, pre, t) => pre + style.italic(t))
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=[^_\w]|$)/g, (_, pre, t) => pre + style.italic(t))
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

/** Renders Markdown to terminal lines no wider than `cols`. */
export function renderMarkdown(md: string, cols: number): string[] {
  const out: string[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let fence: { mark: string; lang: string } | null = null
  const push = (line: string, indent = '', hang = indent) => {
    const wrapped = wrap(line, Math.max(10, cols - width(indent)))
    wrapped.forEach((w, i) => out.push((i === 0 ? indent : hang) + w))
  }
  for (const raw of lines) {
    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(raw)
    if (fence) {
      if (fenceMatch && fenceMatch[1].startsWith(fence.mark[0]) && fenceMatch[1].length >= fence.mark.length && !fenceMatch[2]) {
        fence = null
        continue
      }
      // Code keeps its own line breaks; long lines are cut rather than reflowed.
      const gutter = style.gray('│ ')
      const code = raw.replace(/\t/g, '  ')
      if (width(code) <= cols - 2) out.push(gutter + style.cyan(code))
      else for (const part of wrap(code, cols - 2)) out.push(gutter + style.cyan(part))
      continue
    }
    if (fenceMatch) {
      fence = { mark: fenceMatch[1], lang: fenceMatch[2] }
      if (fence.lang) out.push(style.gray(`│ ${fence.lang}`))
      continue
    }
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const text = inline(m[2])
      push(m[1].length <= 2 ? style.bold(style.accent(text)) : style.bold(text))
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(style.gray('─'.repeat(Math.min(cols, 40))))
    } else if ((m = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2)
      const box = m[3] ? (/x/i.test(m[3]) ? style.green('☑ ') : '☐ ') : ''
      const indent = '  '.repeat(depth)
      push(box + inline(m[4]), `${indent}${style.accent('•')} `, `${indent}  `)
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) {
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2)
      const indent = '  '.repeat(depth)
      const num = `${m[2]}.`
      push(inline(m[3]), `${indent}${style.accent(num)} `, `${indent}${' '.repeat(num.length + 1)}`)
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      push(style.italic(inline(m[1])), style.gray('┃ '))
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      // Tables: the separator row becomes a rule; cells stay as written.
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) out.push(style.gray('─'.repeat(Math.min(cols, width(line)))))
      else push(line.replace(/\|/g, style.gray('│')).trim())
    } else {
      push(inline(line))
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * Splits streamed Markdown into the part that will no longer change (it ends at a blank line
 * outside a code block) and the part still being written. The stable part can be printed for
 * good, so only the tail is redrawn while a long reply streams.
 */
export function splitStable(md: string): [string, string] {
  let inFence = false
  let cut = 0
  let pos = 0
  for (const line of md.split('\n')) {
    const end = pos + line.length + 1
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    // A blank line outside a fence ends a block; everything before it is final.
    if (!inFence && !line.trim() && end <= md.length) cut = end
    pos = end
  }
  return [md.slice(0, cut), md.slice(cut)]
}
