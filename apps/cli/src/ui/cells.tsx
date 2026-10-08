import { Box, Text } from 'ink'
import type { TodoItem, ToolDisplay, ToolResult } from '@harness/core'
import { useTheme } from '../theme/palette.js'
import { clip, duration, tokens, usd } from './format.js'
import { Markdown } from './Markdown.js'

export interface ToolCellData {
  callId: string
  name: string
  subject: string
  input: unknown
  progress?: string
  startedAt: number
  result?: ToolResult
  durationMs?: number
  denied?: boolean
}

export type Cell = { id: string } & (
  | { kind: 'header' }
  | { kind: 'user'; text: string; files?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; tool: ToolCellData; expanded?: boolean }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'todos'; todos: TodoItem[] }
  | { kind: 'turn'; ms: number; requests: number; promptTokens: number; completionTokens: number; cost: number; partial: boolean; reason: string }
  | { kind: 'card'; title: string; rows: [string, string][]; lines?: string[] }
  | { kind: 'divider'; label: string }
)

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never
/** A cell before it gets an id. */
export type CellInput = DistributiveOmit<Cell, 'id'>

/** How many output lines a finished command shows before "+N lines". */
export const EXEC_HEAD = 2
export const EXEC_TAIL = 3
/** Diff lines shown before "+N lines". */
export const DIFF_LINES = 40

export function UserCell({ text, files }: { text: string; files?: string[] }) {
  const t = useTheme()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={t.accent} bold>
          ›{' '}
        </Text>
        <Box flexShrink={1}>
          <Text>{text}</Text>
        </Box>
      </Box>
      {!!files?.length && <Text color={t.muted}>  attached {files.join(', ')}</Text>}
    </Box>
  )
}

export function AssistantCell({ text }: { text: string }) {
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Markdown text={text} />
    </Box>
  )
}

export function NoticeCell({ level, text }: { level: 'info' | 'warn' | 'error'; text: string }) {
  const t = useTheme()
  const color = level === 'error' ? t.danger : level === 'warn' ? t.warn : t.muted
  const mark = level === 'error' ? '✗' : level === 'warn' ? '!' : '·'
  return (
    <Box marginTop={level === 'info' ? 0 : 1}>
      <Text color={color}>{mark} </Text>
      <Box flexShrink={1}>
        <Text color={level === 'info' ? t.muted : color}>{text}</Text>
      </Box>
    </Box>
  )
}

export function TodosCell({ todos }: { todos: TodoItem[] }) {
  const t = useTheme()
  const done = todos.filter((x) => x.status === 'completed').length
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={t.accent}>• </Text>
        <Text bold>Checklist</Text>
        <Text color={t.muted}>
          {' '}
          {done}/{todos.length}
        </Text>
      </Text>
      {todos.map((x, i) => (
        <Text key={i}>
          <Text color={t.muted}>{i === 0 ? '  └ ' : '    '}</Text>
          {x.status === 'completed' ? (
            <Text color={t.muted} strikethrough>
              ✔ {x.content}
            </Text>
          ) : x.status === 'in_progress' ? (
            <Text color={t.accent} bold>
              ▣ {x.content}
            </Text>
          ) : (
            <Text>□ {x.content}</Text>
          )}
        </Text>
      ))}
    </Box>
  )
}

export function TurnCell(c: Extract<Cell, { kind: 'turn' }>) {
  const t = useTheme()
  const parts = [`Worked for ${duration(c.ms)}`]
  if (c.requests) parts.push(`${c.requests} request${c.requests === 1 ? '' : 's'}`, `${tokens(c.promptTokens)} in · ${tokens(c.completionTokens)} out`, usd(c.cost, c.partial))
  if (c.reason !== 'done') parts.push(c.reason === 'aborted' ? 'interrupted' : c.reason === 'max_steps' ? 'step limit reached' : c.reason)
  return (
    <Box marginTop={1}>
      <Text color={t.muted}>─ {parts.join(' · ')}</Text>
    </Box>
  )
}

export function CardCell({ title, rows, lines }: { title: string; rows: [string, string][]; lines?: string[] }) {
  const t = useTheme()
  const w = Math.max(0, ...rows.map(([k]) => k.length))
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={t.border} paddingX={1}>
      <Text bold color={t.accent}>
        {title}
      </Text>
      {rows.map(([k, v], i) => (
        <Box key={i}>
          <Box width={w + 2} flexShrink={0}>
            <Text color={t.muted}>{k}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text>{v}</Text>
          </Box>
        </Box>
      ))}
      {lines?.map((l, i) => (
        <Text key={`l${i}`}>{l}</Text>
      ))}
    </Box>
  )
}

export function DividerCell({ label }: { label: string }) {
  const t = useTheme()
  return (
    <Box marginTop={1}>
      <Text color={t.muted}>── {label} ──</Text>
    </Box>
  )
}

// ---------- tools ----------

const VERB: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'Listed',
  glob: 'Searched files',
  grep: 'Searched',
  web_fetch: 'Fetched',
  web_search: 'Searched the web',
  task: 'Delegated',
  remember: 'Remembered',
  forget: 'Forgot',
  bash_output: 'Checked',
  kill_job: 'Stopped',
}

/** "• Ran npm test" with condensed output, exit status and duration. */
export function ExecCell({ tool, expanded, live }: { tool: ToolCellData; expanded?: boolean; live?: boolean }) {
  const t = useTheme()
  const running = !tool.result
  const content = tool.result?.content ?? tool.progress ?? ''
  const exit = /\n?\[exit code: (\w+)\]\s*$/.exec(content)
  const body = content
    .replace(/\n?\[exit code: \w+\]\s*$/, '')
    .replace(/^Error: /, '')
    .trimEnd()
  const ok = !running && !tool.result?.isError
  const bullet = running ? t.accent : tool.denied ? t.muted : ok ? t.ok : t.danger
  const verb = running ? 'Running' : tool.denied ? 'Not run' : 'Ran'
  // A command that never ran has no output worth showing; "not approved" says it all.
  const lines = body && !tool.denied ? body.split('\n') : []
  let shown: (string | null)[] = lines
  if (!expanded && lines.length > EXEC_HEAD + EXEC_TAIL + 1) shown = [...lines.slice(0, EXEC_HEAD), null, ...lines.slice(-EXEC_TAIL)]
  if (live && !expanded) shown = lines.slice(-EXEC_TAIL)
  const cmdLines = tool.subject.split('\n')
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={bullet}>• </Text>
        <Text bold>{verb} </Text>
        <Box flexShrink={1}>
          <Text>{cmdLines[0]}</Text>
        </Box>
      </Box>
      {cmdLines.slice(1, 3).map((l, i) => (
        <Text key={i}>
          <Text color={t.muted}>  │ </Text>
          {l}
        </Text>
      ))}
      {cmdLines.length > 3 && <Text color={t.muted}>  │ … {cmdLines.length - 3} more lines</Text>}
      {shown.map((l, i) => (
        <Box key={`o${i}`}>
          <Text color={t.muted}>{i === 0 ? '  └ ' : '    '}</Text>
          <Box flexShrink={1}>
            {l === null ? (
              <Text color={t.muted}>… +{lines.length - EXEC_HEAD - EXEC_TAIL} lines (ctrl+o to expand)</Text>
            ) : (
              <Text color={t.muted}>{l || ' '}</Text>
            )}
          </Box>
        </Box>
      ))}
      {!running && (
        <Text color={t.muted}>
          {shown.length ? '    ' : '  └ '}
          {tool.denied ? 'not approved' : !lines.length ? '(no output) ' : ''}
          {!tool.denied && exit && exit[1] !== '0' ? <Text color={t.danger}>exit {exit[1]} </Text> : null}
          {tool.durationMs !== undefined && !tool.denied ? duration(tool.durationMs) : ''}
        </Text>
      )}
    </Box>
  )
}

interface DiffLine {
  sign: '+' | '-' | ' ' | '⋮'
  oldNo?: number
  newNo?: number
  text: string
}

/** Unified diff → numbered lines; hunks separated by ⋮. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  let o = 0
  let n = 0
  let first = true
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      if (!first) out.push({ sign: '⋮', text: '' })
      first = false
      o = Number(h[1])
      n = Number(h[2])
      continue
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:') || line.startsWith('===') || line.startsWith('\\')) continue
    if (first) continue
    if (line.startsWith('+')) out.push({ sign: '+', newNo: n++, text: line.slice(1) })
    else if (line.startsWith('-')) out.push({ sign: '-', oldNo: o++, text: line.slice(1) })
    else if (line.startsWith(' ') || line === '') {
      if (line === '' && out.length && out.at(-1)!.sign === '⋮') continue
      out.push({ sign: ' ', oldNo: o++, newNo: n++, text: line.slice(1) })
    }
  }
  while (out.length && out.at(-1)!.sign === ' ' && out.at(-1)!.text === '' && patch.endsWith('\n')) {
    out.pop()
    break
  }
  return out
}

export function DiffCell({ display, verb, expanded }: { display: Extract<ToolDisplay, { kind: 'diff' }>; verb: string; expanded?: boolean }) {
  const t = useTheme()
  const all = parsePatch(display.patch)
  const lines = expanded ? all : all.slice(0, DIFF_LINES)
  const width = String(Math.max(1, ...all.map((l) => l.newNo ?? l.oldNo ?? 0))).length
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={t.ok}>• </Text>
        <Text bold>{verb} </Text>
        <Text>{display.path}</Text>
        <Text color={t.muted}> (</Text>
        <Text color={t.ok}>+{display.added}</Text>
        <Text color={t.muted}> </Text>
        <Text color={t.danger}>-{display.removed}</Text>
        <Text color={t.muted}>)</Text>
      </Text>
      {lines.map((l, i) =>
        l.sign === '⋮' ? (
          <Text key={i} color={t.muted}>
            {' '.repeat(4 + width)}⋮
          </Text>
        ) : (
          <Box key={i}>
            <Text color={t.muted}>{'    ' + String(l.newNo ?? l.oldNo ?? '').padStart(width)} </Text>
            <Box flexShrink={1}>
              <Text
                backgroundColor={l.sign === '+' ? t.addBg : l.sign === '-' ? t.delBg : undefined}
                color={l.sign === ' ' ? t.muted : undefined}
              >
                <Text color={l.sign === '+' ? t.ok : l.sign === '-' ? t.danger : t.muted}>{l.sign}</Text>
                {l.text || ' '}
              </Text>
            </Box>
          </Box>
        ),
      )}
      {!expanded && all.length > DIFF_LINES && (
        <Text color={t.muted}>
          {'    '}… +{all.length - DIFF_LINES} lines (ctrl+o to expand)
        </Text>
      )}
    </Box>
  )
}

/** One-line summary for read, search, fetch, memory and other tools. */
export function GenericToolCell({ tool, expanded }: { tool: ToolCellData; expanded?: boolean }) {
  const t = useTheme()
  const running = !tool.result
  const failed = !!tool.result?.isError
  const verb = VERB[tool.name] ?? (tool.name.startsWith('mcp__') ? tool.name.split('__').slice(1).join(' › ') : tool.name)
  const bullet = running ? t.accent : tool.denied ? t.muted : failed ? t.danger : t.accent
  const first = tool.result?.content.split('\n')[0] ?? ''
  const summary = summarize(tool)
  const progress = (tool.progress ?? '').trimEnd().split('\n').filter(Boolean)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={bullet}>• </Text>
        <Text bold color={tool.name === 'task' ? undefined : undefined}>
          {running && tool.name === 'task' ? 'Delegating' : verb}{' '}
        </Text>
        <Box flexShrink={1}>
          <Text>{tool.subject}</Text>
        </Box>
      </Box>
      {tool.name === 'task' && running &&
        progress.slice(-4).map((l, i) => (
          <Text key={i} color={t.muted}>
            {i === 0 ? '  └ ' : '    '}
            {clip(l.trim(), 100)}
          </Text>
        ))}
      {!running && (failed || tool.denied) && (
        <Text color={tool.denied ? t.muted : t.danger}>  └ {tool.denied ? 'not approved' : clip(first.replace(/^Error: /, ''), 160)}</Text>
      )}
      {!running && !failed && !tool.denied && summary && <Text color={t.muted}>  └ {summary}</Text>}
      {expanded && tool.result && (
        <Box flexDirection="column" paddingLeft={4}>
          {tool.result.content.split('\n').map((l, i) => (
            <Text key={i} color={t.muted}>
              {l || ' '}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function summarize(tool: ToolCellData): string {
  const c = tool.result?.content ?? ''
  const n = c ? c.split('\n').filter(Boolean).length : 0
  switch (tool.name) {
    case 'read_file': {
      const shown = c.split('\n').filter((l) => /^\s*\d+→/.test(l)).length
      const more = /\((\d+) more lines/.exec(c)
      return more ? `${shown} lines (${more[1]} more)` : `${shown} lines`
    }
    case 'grep':
      return /^No matches/.test(c) ? 'no matches' : `${n} match${n === 1 ? '' : 'es'}`
    case 'glob':
      return /^No files/.test(c) ? 'no files' : `${n} file${n === 1 ? '' : 's'}`
    case 'list_dir':
      return c === '(empty directory)' ? 'empty' : `${n} entries`
    case 'web_search': {
      const k = (c.match(/^\d+\. /gm) ?? []).length
      return k ? `${k} result${k === 1 ? '' : 's'}` : 'no results'
    }
    case 'web_fetch':
      return `${tokens(c.length)} chars`
    case 'task':
      return `report: ${clip(c.trim(), 120)}`
    case 'todo_write':
      return ''
    default:
      return clip(c.trim(), 120)
  }
}

export function ToolCell({ tool, expanded, live }: { tool: ToolCellData; expanded?: boolean; live?: boolean }) {
  if (tool.name === 'bash') return <ExecCell tool={tool} expanded={expanded} live={live} />
  const d = tool.result?.display
  if (d?.kind === 'diff' && !tool.result?.isError) {
    return <DiffCell display={d} verb={tool.name === 'write_file' && d.removed === 0 ? 'Added' : 'Edited'} expanded={expanded} />
  }
  return <GenericToolCell tool={tool} expanded={expanded} />
}
