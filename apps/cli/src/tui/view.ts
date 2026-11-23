// How things look: engine events and prompts turned into terminal lines. No state, no I/O.
import type { PermissionMode, PermissionRequest, QuestionRequest, ToolResult, TodoItem } from '@harness/core'
import { pad, style, truncate, width, wrap } from './ansi.js'
import { renderMarkdown } from './markdown.js'

/** The orchid, Xarı's mark, as a glyph. */
export const MARK = '✿'

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'Edit',
  list_dir: 'List',
  glob: 'Find',
  grep: 'Search',
  bash: 'Run',
  bash_output: 'Output',
  kill_job: 'Stop job',
  web_search: 'Web search',
  web_fetch: 'Fetch',
  browser: 'Browser',
  browser_read: 'Browser',
  todo_write: 'Checklist',
  ask_user: 'Question',
  task: 'Subagent',
  remember: 'Remember',
  forget: 'Forget',
  skill: 'Skill',
  save_skill: 'Save skill',
  session_search: 'Past chats',
}

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

export const MODES: { id: PermissionMode; label: string; paint: (s: string) => string }[] = [
  { id: 'ask', label: 'Ask', paint: style.gray },
  { id: 'acceptEdits', label: 'Auto-edit', paint: style.lime },
  { id: 'plan', label: 'Plan', paint: style.blue },
  { id: 'auto', label: 'Full auto', paint: style.red },
]

export const modeOf = (id: PermissionMode) => MODES.find((m) => m.id === id) ?? MODES[0]

export function banner(o: { version: string; model: string; mode: PermissionMode; cwd: string; resumed?: string; cols: number }): string[] {
  const m = modeOf(o.mode)
  const home = process.env.HOME
  const cwd = home && o.cwd.startsWith(home) ? `~${o.cwd.slice(home.length)}` : o.cwd
  return [
    '',
    `${style.accent(MARK)} ${style.bold('Xarı')} ${style.gray(`v${o.version}`)}${o.resumed ? style.gray(`  ·  resumed “${o.resumed}”`) : ''}`,
    `  ${style.gray('model')} ${o.model}  ${style.gray('·')}  ${m.paint(m.label)}  ${style.gray('·')}  ${truncate(cwd, Math.max(10, o.cols - 40))}`,
    style.gray('  /help for commands · shift+tab changes mode · esc stops'),
    '',
  ]
}

/** Your message, as it stays in the transcript. */
export function userMessage(text: string, cols: number): string[] {
  const out: string[] = []
  text.split('\n').forEach((line, i) => {
    wrap(line, cols - 2).forEach((w, j) => out.push(`${i === 0 && j === 0 ? style.accent('›') : ' '} ${style.bold(w)}`))
  })
  out.push('')
  return out
}

/** A piece of the reply: the first piece of a reply gets the mark, the rest line up under it. */
export function replyLines(md: string, cols: number, first: boolean): string[] {
  const lines = renderMarkdown(md, cols - 2)
  return lines.map((l, i) => (i === 0 && first ? `${style.lime(MARK)} ${l}` : `  ${l}`))
}

export function thinkingLine(text: string, seconds: number, cols: number): string {
  const tail = text.replace(/\s+/g, ' ').trim().slice(-200)
  return style.gray(truncate(`  ◇ thinking ${seconds}s  ${style.italic(tail)}`, cols))
}

export type ToolState = 'running' | 'ok' | 'error' | 'denied'

export function toolLine(name: string, subject: string, state: ToolState, cols: number, spin = ''): string {
  const dot = state === 'running' ? style.accent(spin || '◆') : state === 'ok' ? style.green('◆') : state === 'denied' ? style.yellow('◇') : style.red('◆')
  return truncate(`${dot} ${style.bold(toolLabel(name))} ${style.gray(subject)}`, cols)
}

/** The diff a tool returned, coloured, at most `max` lines. */
export function diffLines(patch: string, cols: number, max = 24): string[] {
  const body = patch.split('\n').filter((l) => !/^(Index:|={3,}|---|\+\+\+)/.test(l))
  const out: string[] = []
  for (const l of body) {
    if (out.length >= max) {
      out.push(style.gray(`    … ${body.length - max} more lines`))
      break
    }
    const t = truncate(l, cols - 4)
    if (l.startsWith('@@')) out.push(`    ${style.gray(t)}`)
    else if (l.startsWith('+')) out.push(`    ${style.green(t)}`)
    else if (l.startsWith('-')) out.push(`    ${style.red(t)}`)
    else if (l.trim()) out.push(`    ${style.gray(t)}`)
  }
  return out
}

/** What a finished tool call shows under its line. */
export function toolResultLines(name: string, result: ToolResult, denied: boolean, cols: number, cwd = ''): string[] {
  const arrow = style.gray('  ↳ ')
  if (denied) return [arrow + style.yellow(truncate(firstLine(result.content) || 'Not allowed.', cols - 4))]
  if (result.isError) return [arrow + style.red(truncate(firstLine(result.content), cols - 4))]
  if (result.display?.kind === 'diff') {
    const d = result.display
    const file = cwd && d.path.startsWith(`${cwd}/`) ? d.path.slice(cwd.length + 1) : d.path
    return [truncate(arrow + `${style.green(`+${d.added}`)} ${style.red(`-${d.removed}`)} ${style.gray(file)}`, cols), ...diffLines(d.patch, cols)]
  }
  const content = result.content.replace(/\s+$/, '')
  const lines = content ? content.split('\n') : []
  if (name === 'bash' || name === 'bash_output') {
    if (!lines.length) return [arrow + style.gray('(no output)')]
    const tail = lines.slice(-4)
    return [...(lines.length > 4 ? [arrow + style.gray(`… ${lines.length - 4} lines above`)] : []), ...tail.map((l, i) => (i === 0 && lines.length <= 4 ? arrow : '    ') + style.gray(truncate(l, cols - 4)))]
  }
  if (name === 'todo_write' || name === 'ask_user') return []
  if (!lines.length) return [arrow + style.gray('done')]
  return [arrow + style.gray(truncate(lines[0], cols - 20) + (lines.length > 1 ? `  (${lines.length} lines)` : ''))]
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

export function todoLines(todos: TodoItem[], cols: number): string[] {
  return todos.map((t) => {
    const box = t.status === 'completed' ? style.green('☑') : t.status === 'in_progress' ? style.accent('▣') : style.gray('☐')
    const text = t.status === 'completed' ? style.gray(t.content) : t.status === 'in_progress' ? style.bold(t.content) : t.content
    return truncate(`  ${box} ${text}`, cols)
  })
}

/** A rounded box in the accent colour, used for approvals and questions. */
function box(title: string, body: string[], cols: number): string[] {
  const inner = Math.max(20, cols - 4)
  const top = style.accent(`╭─ ${title} ${'─'.repeat(Math.max(0, inner - width(title) - 1))}╮`)
  const bottom = style.accent(`╰${'─'.repeat(inner + 2)}╯`)
  const side = style.accent('│')
  return [top, ...body.flatMap((l) => (width(l) > inner ? wrap(l, inner) : [l])).map((l) => `${side} ${pad(truncate(l, inner), inner)} ${side}`), bottom]
}

export interface Choice {
  label: string
  hint?: string
}

function choiceLines(choices: Choice[], selected: number, checked?: Set<number>): string[] {
  return choices.map((c, i) => {
    const pointer = i === selected ? style.accent('❯') : ' '
    const mark = checked ? (checked.has(i) ? style.green('◉ ') : style.gray('○ ')) : `${style.gray(`${i + 1}.`)} `
    const label = i === selected ? style.bold(c.label) : c.label
    return `${pointer} ${mark}${label}${c.hint ? `  ${style.gray(c.hint)}` : ''}`
  })
}

/** What an approval shows: the command, the file and its change, or the request as JSON. */
function preview(req: PermissionRequest, cols: number): string[] {
  const input = (req.input ?? {}) as Record<string, unknown>
  if (typeof input.command === 'string') return input.command.split('\n').slice(0, 8).map((l) => style.cyan(`$ ${l}`))
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : typeof input.old_string === 'string' ? [input] : []
  if (edits.length) {
    const out: string[] = []
    for (const e of edits.slice(0, 3)) {
      for (const l of String(e.old_string ?? '').replace(/\n$/, '').split('\n').slice(0, 6)) out.push(style.red(`- ${l}`))
      for (const l of String(e.new_string ?? '').replace(/\n$/, '').split('\n').slice(0, 6)) out.push(style.green(`+ ${l}`))
    }
    return out
  }
  if (typeof input.content === 'string') {
    const ls = input.content.replace(/\n$/, '').split('\n')
    return [...ls.slice(0, 8).map((l) => style.green(`+ ${l}`)), ...(ls.length > 8 ? [style.gray(`  … ${ls.length - 8} more lines`)] : [])]
  }
  const json = JSON.stringify(req.input)
  return json && json !== '{}' ? [style.gray(truncate(json, cols * 2))] : []
}

export const permissionChoices = (req: PermissionRequest): Choice[] => [
  { label: 'Yes' },
  { label: 'Yes, and don’t ask again this session', hint: req.suggestedRule },
  { label: 'No, tell Xarı what to do instead', hint: 'type it, then Enter' },
]

export function permissionBox(req: PermissionRequest, selected: number, cols: number): string[] {
  const body = [`${style.bold(toolLabel(req.tool))} ${req.subject}`, ...(req.reason ? [style.gray(req.reason)] : []), '', ...preview(req, cols - 6), '', ...choiceLines(permissionChoices(req), selected)]
  return box('Allow?', body, cols)
}

export function questionBox(q: QuestionRequest, selected: number, checked: Set<number> | undefined, cols: number): string[] {
  const choices = q.options.map((o) => ({ label: o }))
  const help = q.multiSelect ? 'space picks · enter sends · or type an answer' : 'enter picks · or type an answer'
  return box('Question', [q.question, '', ...choiceLines(choices, selected, q.multiSelect ? checked : undefined), '', style.gray(help)], cols)
}

/** A plain list to pick from (/resume, /model). */
export function pickerLines(title: string, choices: Choice[], selected: number, cols: number): string[] {
  const visible = 10
  const start = Math.max(0, Math.min(selected - 4, choices.length - visible))
  const shown = choices.slice(start, start + visible)
  return box(title, [...choiceLines(shown, selected - start), ...(choices.length > visible ? [style.gray(`${selected + 1} of ${choices.length} · ↑↓ to move · enter picks · esc closes`)] : [style.gray('↑↓ to move · enter picks · esc closes')])], cols)
}

/** The prompt between two rules, with the cursor position in its lines. */
export function inputLines(text: string[], cols: number, placeholder: string, busy: boolean): string[] {
  const rule = style.gray('─'.repeat(cols))
  const marker = busy ? style.gray('›') : style.accent('›')
  if (text.length === 1 && !text[0]) return [rule, `${marker} ${style.gray(placeholder)}`, rule]
  return [rule, ...text.map((l, i) => `${i === 0 ? marker : ' '} ${l}`), rule]
}

export function footer(o: { mode: PermissionMode; model: string; contextPct: number | null; cost: number; queued: number; hint: string; cols: number }): string {
  const m = modeOf(o.mode)
  const left = `  ${m.paint(`⏵ ${m.label}`)}${style.gray(' · shift+tab')}${o.queued ? style.accent(`  · ${o.queued} queued`) : ''}${o.hint ? style.gray(`  · ${o.hint}`) : ''}`
  const ctx = o.contextPct == null ? '' : o.contextPct >= 80 ? style.yellow(`${o.contextPct}% context`) : style.gray(`${o.contextPct}% context`)
  const right = [style.gray(o.model), ctx, o.cost > 0 ? style.gray(`$${o.cost < 0.01 ? o.cost.toFixed(4) : o.cost.toFixed(2)}`) : ''].filter(Boolean).join(style.gray(' · '))
  const gap = o.cols - width(left) - width(right) - 1
  return gap >= 2 ? left + ' '.repeat(gap) + right : truncate(left, o.cols)
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function statusLine(spin: string, label: string, seconds: number, tokens: number, cols: number): string {
  const t = tokens ? ` · ↓ ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : ''
  return truncate(`${style.accent(spin)} ${label} ${style.gray(`(${seconds}s${t} · esc to stop)`)}`, cols)
}

export const HELP: [string, string][] = [
  ['/help', 'this list'],
  ['/new, /clear', 'start a new chat'],
  ['/resume', 'open an earlier chat in this folder'],
  ['/model [name]', 'show or switch the model (provider/model)'],
  ['/mode [mode]', 'ask, acceptEdits, plan or auto (shift+tab cycles)'],
  ['/compact', 'summarize older messages to free context'],
  ['/undo', 'put back the files the last turn changed'],
  ['/cost', 'tokens and cost for this chat and today'],
  ['/exit', 'quit (or ctrl+d)'],
]

export const KEYS: [string, string][] = [
  ['enter', 'send · alt+enter or ctrl+j for a new line'],
  ['esc', 'stop the agent · twice to clear the prompt'],
  ['↑ ↓', 'earlier prompts'],
  ['tab', 'complete a / command'],
  ['ctrl+c', 'stop, clear, then quit'],
  ['ctrl+l', 'clear the screen'],
]

export function helpLines(extra: { name: string; description: string }[], cols: number): string[] {
  const row = ([k, v]: [string, string]) => truncate(`  ${style.accent(pad(k, 16))} ${v}`, cols)
  return [
    style.bold('Commands'),
    ...HELP.map(row),
    ...(extra.length ? ['', style.bold('Your commands and skills'), ...extra.map((c) => row([`/${c.name}`, c.description]))] : []),
    '',
    style.bold('Keys'),
    ...KEYS.map(row),
    '',
  ]
}
