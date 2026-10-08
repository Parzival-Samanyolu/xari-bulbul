import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useTheme, type Palette } from '../theme/palette.js'

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'li'; marker: string; indent: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; lines: string[] }
  | { kind: 'blank' }

/** A small Markdown reader for terminal output: headings, lists, quotes, fences, tables, inline marks. */
export function parseBlocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      const close = fence[2]
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(close); i++) code.push(lines[i].slice(Math.min(fence[1].length, lines[i].length - lines[i].trimStart().length)))
      out.push({ kind: 'code', lang: fence[3], lines: code })
      continue
    }
    if (!line.trim()) {
      if (out.at(-1)?.kind !== 'blank') out.push({ kind: 'blank' })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ kind: 'h', level: h[1].length, text: h[2].replace(/\s+#+\s*$/, '') })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'hr' })
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li[3])
      const marker = task ? (task[1] === ' ' ? '☐' : '☑') : /\d/.test(li[2]) ? li[2] : '•'
      out.push({ kind: 'li', marker, indent: Math.floor(li[1].length / 2), text: task ? task[2] : li[3] })
      continue
    }
    if (line.startsWith('>')) {
      out.push({ kind: 'quote', text: line.replace(/^>\s?/, '') })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [line]
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(lines[++i])
      out.push({ kind: 'table', lines: rows })
      continue
    }
    // Paragraph: join soft-wrapped lines.
    const prev = out.at(-1)
    if (prev?.kind === 'p') prev.text += '\n' + line
    else out.push({ kind: 'p', text: line })
  }
  while (out.at(-1)?.kind === 'blank') out.pop()
  while (out[0]?.kind === 'blank') out.shift()
  return out
}

/** Inline `code`, **bold**, *italic*, ~~strike~~ and [links](url). */
export function Inline({ text, color }: { text: string; color?: string }) {
  const t = useTheme()
  return <Text color={color}>{inlineNodes(text, t)}</Text>
}

function inlineNodes(text: string, t: Palette): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<![\w_])_([^_\s][^_]*?)_(?!\w)|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let k = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) out.push(<Text key={k++} color={t.accent}>{m[2]}</Text>)
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<Text key={k++} bold>{m[3] ?? m[4]}</Text>)
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<Text key={k++} italic>{m[5] ?? m[6]}</Text>)
    else if (m[7] !== undefined) out.push(<Text key={k++} strikethrough>{m[7]}</Text>)
    else if (m[8] !== undefined)
      out.push(
        <Text key={k++}>
          <Text underline color={t.info}>{m[8]}</Text>
          {m[9] !== m[8] && <Text color={t.muted}> ({m[9]})</Text>}
        </Text>,
      )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const t = useTheme()
  const blocks = parseBlocks(text)
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'blank':
            return <Text key={i}> </Text>
          case 'h':
            return (
              <Text key={i} bold color={b.level <= 2 ? t.accent : undefined}>
                {inlineNodes(b.text, t)}
              </Text>
            )
          case 'hr':
            return (
              <Text key={i} color={t.muted}>
                {'─'.repeat(24)}
              </Text>
            )
          case 'li':
            return (
              <Box key={i} paddingLeft={b.indent * 2}>
                <Text color={t.muted}>{b.marker} </Text>
                <Box flexShrink={1}>
                  <Text>{inlineNodes(b.text, t)}</Text>
                </Box>
              </Box>
            )
          case 'quote':
            return (
              <Box key={i}>
                <Text color={t.muted}>│ </Text>
                <Text italic>{inlineNodes(b.text, t)}</Text>
              </Box>
            )
          case 'code':
            return (
              <Box key={i} flexDirection="column">
                {b.lang && <Text color={t.muted}>{b.lang}</Text>}
                {b.lines.map((l, j) => (
                  <Box key={j}>
                    <Text color={t.muted}>▏ </Text>
                    <Text>{l || ' '}</Text>
                  </Box>
                ))}
              </Box>
            )
          case 'table':
            return (
              <Box key={i} flexDirection="column">
                {b.lines.map((l, j) => (
                  <Text key={j} color={/^\s*\|[\s:|-]+\|\s*$/.test(l) ? t.muted : undefined}>
                    {l}
                  </Text>
                ))}
              </Box>
            )
          default:
            return <Text key={i}>{inlineNodes(b.text, t)}</Text>
        }
      })}
    </Box>
  )
}

/**
 * Splits streamed text into a part that is safe to print for good (complete blocks, not inside an
 * open code fence) and the rest, which keeps streaming in the live area.
 */
export function splitCommittable(text: string): [done: string, rest: string] {
  let inFence = false
  let cut = 0
  const lines = text.split('\n')
  let pos = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    pos += line.length + 1
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    // A blank line outside a fence ends a block.
    if (!inFence && !line.trim() && i > 0) cut = pos
  }
  return [text.slice(0, cut), text.slice(cut)]
}
