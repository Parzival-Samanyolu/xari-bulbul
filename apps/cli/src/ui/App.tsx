import fs from 'node:fs'
import path from 'node:path'
import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  expandSlashCommand,
  findFiles,
  loadAttachment,
  loadProjectInstructions,
  modelKey,
  providerReady,
  type Agent,
  type AgentEvent,
  type FileAttachment,
  type ImageAttachment,
  type ModelRef,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type Permissions,
  type Session,
  type UsageTotals,
  emptyTotals,
} from '@harness/core'
import type { Host } from '../host.js'
import { useTheme } from '../theme/palette.js'
import { Approval } from './Approval.js'
import { AssistantCell, CardCell, DividerCell, NoticeCell, TodosCell, ToolCell, TurnCell, UserCell, type Cell, type CellInput, type ToolCellData } from './cells.js'
import { BUILTIN_COMMANDS } from './commands.js'
import { Composer, type CommandInfo } from './Composer.js'
import { Footer, Shortcuts, Status } from './Footer.js'
import { ago, clip, MODE_HELP, MODE_LABEL, nextMode, parseMode, shortPath, tokens, usd } from './format.js'
import { Header } from './Header.js'
import { splitCommittable } from './Markdown.js'
import { ModelPicker } from './ModelPicker.js'
import { Popup } from './Popup.js'

export interface AppProps {
  host: Host
  session: Session
  mode: PermissionMode
  resumed?: boolean
  /** Fixed width for tests; otherwise the terminal's. */
  columns?: number
  /** Initial prompt to send right away (`xb "fix the tests"`). */
  prompt?: string
  /** Start with the resume picker open (`xb --resume` without an id). */
  openResume?: boolean
  onExit: (session: Session) => void
}

type PopupState = null | { kind: 'model' } | { kind: 'resume' } | { kind: 'shortcuts' } | { kind: 'login'; providerId: string }

interface Pending {
  req: PermissionRequest
  resolve: (a: PermissionAnswer) => void
}

let seq = 0
const cellId = () => `c${++seq}`

function loadHistory(file: string): string[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string)
      .slice(-500)
  } catch {
    return []
  }
}

/** The previous chat, condensed, so a resumed session shows where it left off. */
function replay(session: Session): Cell[] {
  const out: Cell[] = []
  const recent = session.messages.slice(-30)
  if (recent.length < session.messages.length) out.push({ id: cellId(), kind: 'divider', label: `${session.messages.length - recent.length} earlier messages not shown` })
  for (const m of recent) {
    if (m.role === 'user' && !m.synthetic && !m.content.startsWith('[Summary of the earlier conversation]')) out.push({ id: cellId(), kind: 'user', text: m.content })
    else if (m.role === 'assistant' && m.content.trim()) out.push({ id: cellId(), kind: 'assistant', text: m.content })
  }
  out.push({ id: cellId(), kind: 'divider', label: `resumed · ${ago(session.meta.updatedAt)}` })
  return out
}

export function App(p: AppProps) {
  const { host } = p
  const t = useTheme()
  const { exit } = useApp()
  const size = useWindowSize()
  const columns = p.columns ?? size.columns ?? 80

  const [session, setSession] = useState(p.session)
  const [mode, setMode] = useState<PermissionMode>(p.mode)
  const [items, setItems] = useState<Cell[]>(() => [{ id: cellId(), kind: 'header' }, ...(p.resumed ? replay(p.session) : [])])
  const [stream, setStream] = useState('')
  const [live, setLive] = useState<ToolCellData[]>([])
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [label, setLabel] = useState('Working')
  const [approvals, setApprovals] = useState<Pending[]>([])
  const [popup, setPopup] = useState<PopupState>(p.openResume ? { kind: 'resume' } : null)
  const [queued, setQueued] = useState<string[]>([])
  const [hint, setHint] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [usage, setUsage] = useState<{ session: UsageTotals; today: UsageTotals }>(() => {
    const s = host.usage.summary(p.session.meta.id)
    return { session: s.session, today: s.today }
  })
  const [context, setContext] = useState({ used: p.session.lastPromptTokens ?? 0, length: 0 })
  const [model, setModelState] = useState<ModelRef>(p.session.meta.model)
  const [, setToolsVersion] = useState(0)
  const history = useRef<string[]>(loadHistory(host.historyFile))

  const agentRef = useRef<Agent | null>(null)
  const permsRef = useRef<Permissions | null>(null)
  const streamRef = useRef('')
  const liveRef = useRef<ToolCellData[]>([])
  const lastTool = useRef<ToolCellData | null>(null)
  const turnStart = useRef<UsageTotals>(emptyTotals())
  const ctrlC = useRef(0)

  const push = (...cells: CellInput[]) => setItems((xs) => [...xs, ...cells.map((c) => ({ ...c, id: cellId() }) as Cell)])
  const notice = (level: 'info' | 'warn' | 'error', text: string) => push({ kind: 'notice', level, text })
  const setLiveTools = (fn: (xs: ToolCellData[]) => ToolCellData[]) => {
    liveRef.current = fn(liveRef.current)
    setLive(liveRef.current)
  }

  const contextLength = () =>
    host.settings.models.overrides[modelKey(model)]?.contextLength ??
    host.registry.cachedModel(model.providerId, model.modelId)?.contextLength ??
    host.settings.models.defaultContextLength

  // ---------- agent ----------

  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case 'turn_start':
        streamRef.current = ''
        setStream('')
        setLabel('Working')
        break
      case 'reasoning':
        setLabel('Thinking')
        break
      case 'text': {
        setLabel('Working')
        streamRef.current += e.delta
        const [done, rest] = splitCommittable(streamRef.current)
        if (done.trim()) push({ kind: 'assistant', text: done.trimEnd() })
        streamRef.current = rest
        setStream(rest)
        break
      }
      case 'stream_reset':
        streamRef.current = ''
        setStream('')
        break
      case 'message': {
        const m = e.message
        if (m.role === 'assistant') {
          const rest = streamRef.current.trim()
          if (rest) push({ kind: 'assistant', text: rest })
          streamRef.current = ''
          setStream('')
        } else if (m.role === 'user' && m.synthetic === 'review') {
          notice('info', 'Checking for unfinished steps before finishing')
        }
        break
      }
      case 'tool_start':
        if (e.name === 'todo_write') break
        setLiveTools((xs) => [...xs, { callId: e.callId, name: e.name, subject: e.subject, input: e.input, startedAt: Date.now() }])
        break
      case 'tool_progress':
        setLiveTools((xs) => xs.map((x) => (x.callId === e.callId ? { ...x, progress: ((x.progress ?? '') + e.text).slice(-8000) } : x)))
        break
      case 'tool_end': {
        if (e.name === 'todo_write') {
          if (e.result.isError) notice('warn', `Checklist update failed: ${clip(e.result.content, 160)}`)
          break
        }
        const cur = liveRef.current.find((x) => x.callId === e.callId)
        let result = e.result
        // Show edited files relative to the project, as the model sees them.
        if (result.display?.kind === 'diff' && path.isAbsolute(result.display.path)) {
          const rel = path.relative(host.cwd, result.display.path)
          if (!rel.startsWith('..')) result = { ...result, display: { ...result.display, path: rel } }
        }
        const done: ToolCellData = { ...(cur ?? { callId: e.callId, name: e.name, subject: '', input: {}, startedAt: Date.now() }), result, durationMs: e.durationMs, denied: e.denied }
        setLiveTools((xs) => xs.filter((x) => x.callId !== e.callId))
        lastTool.current = done
        push({ kind: 'tool', tool: done })
        break
      }
      case 'todos':
        push({ kind: 'todos', todos: e.todos })
        break
      case 'usage': {
        setUsage({ session: e.summary.session, today: e.summary.today })
        setContext({ used: e.contextTokens, length: e.contextLength })
        break
      }
      case 'compacted':
        notice('info', `Summarized ${e.removedMessages} earlier messages to free up context.`)
        setContext((c) => ({ ...c, used: 0 }))
        break
      case 'notice':
        notice(e.level, e.text)
        break
      case 'error':
        notice('error', e.message)
        break
      case 'turn_end': {
        const now = host.usage.summary(agentRef.current?.session.meta.id).session
        const s = turnStart.current
        push({
          kind: 'turn',
          ms: Date.now() - startedAtRef.current,
          requests: now.requests - s.requests,
          promptTokens: now.promptTokens - s.promptTokens,
          completionTokens: now.completionTokens - s.completionTokens,
          cost: now.cost - s.cost,
          partial: now.costPartial,
          reason: e.reason,
        })
        setLiveTools(() => [])
        setRunning(false)
        if (stoppedForInstructions.current) {
          stoppedForInstructions.current = false
          notice('info', 'Stopped. Tell Xarı Bülbül what to do instead.')
        }
        break
      }
    }
  }
  const startedAtRef = useRef(0)
  const stoppedForInstructions = useRef(false)

  const askPermission = (req: PermissionRequest) =>
    new Promise<PermissionAnswer>((resolve) => {
      setApprovals((xs) => [...xs, { req, resolve }])
    })

  const attach = (s: Session) => {
    agentRef.current?.dispose()
    const { agent, permissions } = host.createAgent(s, mode, { onEvent: (e) => onEventRef.current(e), askPermission })
    agentRef.current = agent
    permsRef.current = permissions
  }
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    attach(session)
    setContext((c) => ({ ...c, length: contextLength() }))
    host.registry.models(model.providerId).then(
      () => setContext((c) => ({ ...c, length: contextLength() })),
      () => {},
    )
    const off = host.onToolsChange(() => {
      agentRef.current?.updateSettings(host.settings, host.tools)
      setToolsVersion((v) => v + 1)
    })
    if (p.prompt) void send(p.prompt)
    return () => {
      off()
      agentRef.current?.dispose()
    }
  }, [])

  // Send queued messages once the turn is over.
  useEffect(() => {
    if (!running && queued.length) {
      const [next, ...rest] = queued
      setQueued(rest)
      void send(next)
    }
  }, [running, queued])

  // ---------- actions ----------

  /** `@path` mentions of existing files are attached (text files as content, images as images). */
  const mentions = (text: string): { files: FileAttachment[]; images: ImageAttachment[]; problems: string[] } => {
    const files: FileAttachment[] = []
    const images: ImageAttachment[] = []
    const problems: string[] = []
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const abs = path.resolve(host.cwd, m[1])
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || files.length + images.length >= 10) continue
      try {
        const a = loadAttachment(abs)
        if (a.kind === 'file') files.push(a.file)
        else images.push(a.image)
      } catch (e) {
        problems.push((e as Error).message)
      }
    }
    return { files, images, problems }
  }

  const send = async (text: string, display = text) => {
    const agent = agentRef.current
    if (!agent) return
    if (agent.running) return setQueued((q) => [...q, text])
    const problem = host.problem(agent.model)
    if (problem) {
      push({ kind: 'user', text: display })
      return notice('error', problem)
    }
    const { files, images, problems } = mentions(text)
    push({ kind: 'user', text: display, files: [...files, ...images].map((f) => f.name) })
    for (const pr of problems) notice('warn', pr)
    turnStart.current = host.usage.summary(agent.session.meta.id).session
    startedAtRef.current = Date.now()
    setStartedAt(startedAtRef.current)
    setRunning(true)
    try {
      await agent.send(text, { files, images })
    } catch (e) {
      notice('error', (e as Error).message)
      setRunning(false)
    }
    setSession({ ...agent.session })
  }

  const interrupt = () => {
    const agent = agentRef.current
    if (!agent?.running) return false
    agent.stop()
    setApprovals((xs) => {
      for (const a of xs) a.resolve({ type: 'deny', feedback: 'Interrupted by the user.' })
      return []
    })
    return true
  }

  /** Shift+Tab changes the mode quietly (the footer shows it); /mode also prints it. */
  const changeMode = (m: PermissionMode, announce = false) => {
    setMode(m)
    permsRef.current?.setMode(m)
    if (announce) notice('info', `Mode: ${MODE_LABEL[m]} (${MODE_HELP[m]})`)
  }

  const chooseModel = (ref: ModelRef) => {
    agentRef.current?.setModel(ref)
    setModelState(ref)
    host.rememberModel(ref)
    setPopup(null)
    host.registry.models(ref.providerId).then(
      () => setContext((c) => ({ ...c, length: contextLength() })),
      () => {},
    )
    const problem = host.problem(ref)
    notice(problem ? 'warn' : 'info', `Model: ${ref.modelId} (${host.provider(ref.providerId)?.name ?? ref.providerId})${problem ? `. ${problem}` : ''}`)
  }

  const newChat = () => {
    if (agentRef.current?.running) return notice('warn', 'Wait for the current turn to finish, or press esc first.')
    const s = host.newSession(model)
    setSession(s)
    attach(s)
    setUsage({ session: emptyTotals(), today: host.usage.summary().today })
    setContext((c) => ({ ...c, used: 0 }))
    push({ kind: 'divider', label: 'new chat' })
  }

  const resume = (id: string) => {
    setPopup(null)
    const s = host.store.load(id)
    if (!s) return notice('error', 'That chat could not be loaded.')
    setSession(s)
    setModelState(s.meta.model)
    attach(s)
    const sum = host.usage.summary(s.meta.id)
    setUsage({ session: sum.session, today: sum.today })
    setContext({ used: s.lastPromptTokens ?? 0, length: contextLength() })
    setItems((xs) => [...xs, ...replay(s)])
  }

  // ---------- slash commands ----------

  const userCommands: CommandInfo[] = host.ext.commands.map((c) => ({ name: c.name, description: c.description || 'Your command', args: '[args]', source: c.source }))
  const commands = useMemo(() => [...BUILTIN_COMMANDS, ...userCommands.filter((u) => !BUILTIN_COMMANDS.some((b) => b.name === u.name))], [host.ext.commands])

  const statusCard = () => {
    const agent = agentRef.current!
    const s = host.usage.summary(agent.session.meta.id)
    const ctxLen = contextLength()
    const instr = loadProjectInstructions(host.cwd, host.settings.agent.projectInstructionFiles).map((f) => f.file)
    const mcp = host.mcp.status()
    const keyRows = host.settings.providers
      .filter((pr) => pr.enabled)
      .map((pr) => {
        const src = host.keys.source(pr.id)
        const state = !pr.requiresKey ? 'no key needed' : src === 'env' ? 'from environment' : src === 'stored' ? `stored (${host.keys.storage})` : 'missing'
        return `${pr.name}: ${state}`
      })
    push({
      kind: 'card',
      title: 'Status',
      rows: [
        ['version', `Xarı Bülbül ${host.version} (xb)`],
        ['model', `${model.modelId} · ${host.provider(model.providerId)?.name ?? model.providerId}`],
        ['mode', `${MODE_LABEL[mode]} · ${MODE_HELP[mode]}`],
        ['directory', host.cwd],
        ['chat', `${agent.session.meta.title} · ${agent.session.meta.id.slice(0, 8)}`],
        ['context', `${tokens(context.used)} of ${tokens(ctxLen)} tokens (${ctxLen ? Math.round((context.used / ctxLen) * 100) : 0}%)`],
        ['this chat', `${s.session.requests} requests · ${tokens(s.session.promptTokens)} in · ${tokens(s.session.completionTokens)} out · ${tokens(s.session.cachedTokens)} cached · ${usd(s.session.cost, s.session.costPartial)}`],
        ['today', `${s.today.requests} requests · ${usd(s.today.cost, s.today.costPartial)}`],
        ['keys', keyRows.join(' · ')],
        ['instructions', instr.length ? instr.join(', ') : 'none (add AGENTS.md, or run /init)'],
        ['web search', (() => {
          const ws = host.settings.tools.webSearch
          if (ws.backend === 'duckduckgo') return 'DuckDuckGo (no key)'
          if (ws.backend === 'searxng') return `SearXNG ${ws.searxngUrl || '(no URL set)'}`
          return `${ws.backend === 'brave' ? 'Brave' : 'Tavily'}: ${host.keys.has(ws.backend) ? 'key set' : 'no key, run /login ' + ws.backend}`
        })()],
        ['mcp', mcp.length ? `${mcp.filter((m) => m.state === 'ready').length} of ${mcp.length} servers ready` : 'none configured'],
        ['extensions', `${host.ext.tools.length} tools · ${host.ext.commands.length} commands${host.ext.errors.length ? ` · ${host.ext.errors.length} errors` : ''}`],
        ['settings', path.join(host.dataDir, 'settings.json')],
      ],
    })
  }

  const usageCard = (args: string) => {
    const [sub, file] = args.split(/\s+/)
    if (sub === 'csv') {
      const target = path.resolve(host.cwd, file || `xb-usage-${new Date().toISOString().slice(0, 10)}.csv`)
      fs.writeFileSync(target, host.usage.toCsv())
      return notice('info', `Wrote ${host.usage.all().length} usage records to ${shortPath(target, 80)}`)
    }
    const id = agentRef.current!.session.meta.id
    const chat = host.usage.bySession(id)
    const s = host.usage.summary(id)
    const line = (label: string, x: UsageTotals): [string, string] => [
      label,
      `${x.requests} req · ${tokens(x.promptTokens)} in · ${tokens(x.completionTokens)} out · ${tokens(x.cachedTokens)} cached · ${usd(x.cost, x.costPartial)}`,
    ]
    const rows: [string, string][] = [line('this chat', chat.total)]
    for (const [k, v] of Object.entries(chat.byModel)) rows.push(line(`  ${clip(k, 34)}`, v))
    rows.push(line('today', s.today), line('all time', s.allTime))
    for (const d of host.usage.byDay().slice(0, 7)) rows.push(line(`  ${d.day}`, d.totals))
    const b = host.settings.usage
    rows.push(['budgets', `chat ${b.sessionBudgetUsd != null ? usd(b.sessionBudgetUsd) : 'none'} · daily ${b.dailyBudgetUsd != null ? usd(b.dailyBudgetUsd) : 'none'} · on limit: ${b.budgetAction}`])
    push({ kind: 'card', title: 'Usage', rows, lines: ['/usage csv [file] exports every request as CSV.'] })
  }

  const memoryCard = (args: string) => {
    const m = /^forget\s+(global|project)\s+(\d+)$/.exec(args.trim())
    if (m) {
      const facts = host.memory.list(m[1] as 'global' | 'project', host.cwd)
      const fact = facts[Number(m[2]) - 1]
      if (!fact) return notice('error', `No ${m[1]} memory #${m[2]}.`)
      host.memory.delete(m[1] as 'global' | 'project', host.cwd, fact)
      return notice('info', `Forgot: ${fact}`)
    }
    const g = host.memory.list('global', host.cwd)
    const pr = host.memory.list('project', host.cwd)
    push({
      kind: 'card',
      title: 'Memory',
      rows: [
        ['about you', g.length ? '' : '(none yet)'],
        ...g.map((f, i): [string, string] => [`  global ${i + 1}`, f]),
        ['this project', pr.length ? '' : '(none yet)'],
        ...pr.map((f, i): [string, string] => [`  project ${i + 1}`, f]),
        ['files', `${shortPath(host.memory.file('global', host.cwd), 70)} · ${shortPath(host.memory.file('project', host.cwd), 70)}`],
      ],
      lines: [host.settings.memory.enabled ? 'Ask the agent to remember something, or /memory forget <global|project> <n>.' : 'Memory is off (settings.json: memory.enabled).'],
    })
  }

  const mcpCard = () => {
    const st = host.mcp.status()
    push({
      kind: 'card',
      title: 'MCP servers',
      rows: st.length
        ? st.map((s): [string, string] => [s.name, `${s.state}${s.state === 'ready' ? ` · ${s.toolCount} tools` : ''}${s.error ? ` · ${clip(s.error, 120)}` : ''}`])
        : [['none', 'Add servers under mcp.servers in settings.json (stdio command or Streamable HTTP URL).']],
      lines: [`Tools appear as mcp__<server>__<tool>. Settings: ${shortPath(path.join(host.dataDir, 'settings.json'), 80)}`],
    })
  }

  const helpCard = () => {
    push({
      kind: 'card',
      title: 'Commands',
      rows: [
        ...commands.map((c): [string, string] => [`/${c.name}${c.args ? ` ${c.args}` : ''}`, c.description + (c.source && c.source !== 'builtin' ? ` (${c.source})` : '')]),
        ['', ''],
        ['your commands', `~/.harness/commands/*.md and .harness/commands/*.md ($ARGUMENTS is replaced)`],
        ['your tools', `~/.harness/tools/*.mjs (project tools only if tools.loadProjectExtensions is on)`],
        ['instructions', 'AGENTS.md, HARNESS.md or CLAUDE.md, nearest folder first'],
        ['settings', shortPath(path.join(host.dataDir, 'settings.json'), 80)],
      ],
      lines: ['Press ? on an empty prompt for keyboard shortcuts.'],
    })
  }

  const runCommand = (text: string): boolean => {
    const m = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(text.trim())
    if (!m) return false
    const [, name, args] = m
    switch (name) {
      case 'help':
        helpCard()
        return true
      case 'exit':
      case 'quit':
        quit()
        return true
      case 'clear':
      case 'new':
        newChat()
        return true
      case 'model':
        if (args.trim()) chooseModel(host.parseModel(args.trim()))
        else setPopup({ kind: 'model' })
        return true
      case 'mode': {
        const next = args.trim() ? parseMode(args.trim()) : nextMode(mode)
        if (!next) notice('error', `Unknown mode "${args.trim()}". Use ask, auto-edit, plan or full-auto.`)
        else changeMode(next, true)
        return true
      }
      case 'compact': {
        const agent = agentRef.current!
        if (agent.running) return notice('warn', 'Wait for the current turn to finish.'), true
        notice('info', 'Summarizing older messages…')
        agent.compact().then(
          (ok) => !ok && notice('info', 'Nothing to summarize yet.'),
          (e) => notice('error', (e as Error).message),
        )
        return true
      }
      case 'resume':
        if (args.trim()) {
          const s = host.findSession(args.trim())
          if (s) resume(s.meta.id)
          else notice('error', `No chat matches "${args.trim()}".`)
        } else setPopup({ kind: 'resume' })
        return true
      case 'status':
        statusCard()
        return true
      case 'usage':
        usageCard(args)
        return true
      case 'memory':
        memoryCard(args)
        return true
      case 'mcp':
        mcpCard()
        return true
      case 'login': {
        const id = args.trim() || model.providerId
        if (id === 'brave' || id === 'tavily') setPopup({ kind: 'login', providerId: id })
        else if (!host.provider(id)) notice('error', `Unknown provider "${id}". Providers: ${host.settings.providers.map((x) => x.id).join(', ')}`)
        else setPopup({ kind: 'login', providerId: id })
        return true
      }
      case 'init':
        void send(INIT_PROMPT)
        return true
    }
    const expanded = expandSlashCommand(text, host.ext.commands)
    if (expanded !== null) {
      void send(expanded)
      return true
    }
    notice('error', `Unknown command /${name}. Type / to see commands.`)
    return true
  }

  const submit = (text: string, display = text) => {
    history.current = [...history.current.filter((h) => h !== display), display].slice(-500)
    try {
      fs.appendFileSync(host.historyFile, JSON.stringify(display) + '\n')
    } catch {
      /* history is a convenience */
    }
    setDraft(undefined)
    if (popup?.kind === 'shortcuts') setPopup(null)
    if (text.startsWith('/') && runCommand(text)) return
    void send(text, display)
  }

  const [exiting, setExiting] = useState(false)
  const quit = () => {
    interrupt()
    p.onExit(agentRef.current?.session ?? session)
    // Clear the live area first so only the transcript stays in the scrollback.
    setExiting(true)
    setTimeout(() => exit(), 20)
  }

  const onCtrlC = (hadText: boolean) => {
    if (hadText) return
    if (popup) return setPopup(null)
    if (interrupt()) return
    const now = Date.now()
    if (now - ctrlC.current < 2000) return quit()
    ctrlC.current = now
    setHint('press ctrl+c again to quit')
    setTimeout(() => setHint(null), 2000)
  }

  const expandLast = () => {
    if (!lastTool.current) return notice('info', 'No tool output yet.')
    push({ kind: 'tool', tool: lastTool.current, expanded: true })
  }

  const approval = approvals[0]
  const answer = (a: PermissionAnswer, opts?: { interrupt?: boolean }) => {
    approval.resolve(a)
    setApprovals((xs) => xs.slice(1))
    if (opts?.interrupt) {
      stoppedForInstructions.current = true
      interrupt()
    }
  }

  const providerName = host.provider(model.providerId)?.name ?? model.providerId
  // The shortcut sheet is passive: the composer keeps the keyboard and closes it on the next key.
  const composerActive = !approval && (!popup || popup.kind === 'shortcuts')

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(c) => (
          <Box key={c.id} flexDirection="column" paddingX={1} width={columns}>
            {c.kind === 'header' ? (
              <Header
                version={host.version}
                model={model.modelId}
                provider={providerName}
                cwd={host.cwd}
                mode={mode}
                columns={columns - 2}
                problem={host.problem(model)}
                resumed={p.resumed ? `${p.session.meta.title} · ${ago(p.session.meta.updatedAt)}` : null}
                showLogo={host.settings.cli?.showLogo !== false}
              />
            ) : c.kind === 'user' ? (
              <UserCell text={c.text} files={c.files} />
            ) : c.kind === 'assistant' ? (
              <AssistantCell text={c.text} />
            ) : c.kind === 'tool' ? (
              <ToolCell tool={c.tool} expanded={c.expanded} />
            ) : c.kind === 'notice' ? (
              <NoticeCell level={c.level} text={c.text} />
            ) : c.kind === 'todos' ? (
              <TodosCell todos={c.todos} />
            ) : c.kind === 'turn' ? (
              <TurnCell {...c} />
            ) : c.kind === 'card' ? (
              <CardCell title={c.title} rows={c.rows} lines={c.lines} />
            ) : (
              <DividerCell label={c.label} />
            )}
          </Box>
        )}
      </Static>

      {!exiting && <Box flexDirection="column" paddingX={1} width={columns}>
        {stream.trim() && (
          <Box paddingLeft={2} marginTop={1}>
            <Text>{stream.trimEnd()}</Text>
          </Box>
        )}
        {live.map((tool) => (
          <ToolCell key={tool.callId} tool={tool} live />
        ))}
        {approval && <Approval key={approval.req.callId} req={approval.req} onAnswer={answer} />}
        {running && !approval && <Status startedAt={startedAt} label={label} queued={queued} />}
        {popup?.kind === 'model' && (
          <ModelPicker
            providers={host.settings.providers.filter((x) => x.enabled).map((x) => ({ id: x.id, name: x.name, ready: providerReady(x, host.keys.has(x.id)) }))}
            load={(id, refresh) => host.models(id, refresh)}
            current={model}
            favorites={host.settings.models.favorites}
            recent={host.settings.models.recent}
            picker={host.settings.models.picker}
            width={columns - 2}
            onChoose={chooseModel}
            onClose={() => setPopup(null)}
            onToggleFavorite={(r) => host.toggleFavorite(r)}
            onPickerChange={(patch) => host.setPicker(patch)}
          />
        )}
        {popup?.kind === 'resume' && <ResumePicker host={host} width={columns - 2} onChoose={resume} onClose={() => setPopup(null)} />}
        {popup?.kind === 'login' && (
          <LoginPrompt
            host={host}
            providerId={popup.providerId}
            onDone={(msg, ok) => {
              setPopup(null)
              notice(ok ? 'info' : 'error', msg)
            }}
          />
        )}
        {popup?.kind === 'shortcuts' && <Shortcuts />}
        <Composer
          active={composerActive}
          width={columns - 2}
          commands={commands}
          listFiles={() => findFiles(host.cwd, '**/*').then((fs_) => fs_.slice(0, 20_000))}
          history={history.current}
          draft={draft}
          placeholder={running ? 'Type to queue a follow-up' : undefined}
          onSubmit={submit}
          onEscape={() => {
            if (popup) return setPopup(null), true
            return interrupt()
          }}
          onCtrlC={onCtrlC}
          onCycleMode={() => changeMode(nextMode(mode))}
          onModelPicker={() => setPopup({ kind: 'model' })}
          onExpand={expandLast}
          onToggleShortcuts={() => setPopup(popup?.kind === 'shortcuts' ? null : { kind: 'shortcuts' })}
        />
        <Footer mode={mode} model={model.modelId} session={usage.session} today={usage.today} context={{ used: context.used, length: context.length || contextLength() }} columns={columns - 2} hint={hint} />
      </Box>}
    </Box>
  )
}

export const INIT_PROMPT = `Look through this repository and write an AGENTS.md at its root for coding agents working here (update it if it exists). Cover, briefly and specifically: what the project is, how to install, build, run, test and lint it (exact commands from the scripts and docs, not guesses), the layout of the main folders, code style and naming conventions you can see, and anything easy to get wrong. Keep it under about 80 lines. Do not invent commands you cannot find.`

function ResumePicker({ host, width, onChoose, onClose }: { host: Host; width: number; onChoose: (id: string) => void; onClose: () => void }) {
  const [all, setAll] = useState(false)
  const [sel, setSel] = useState(0)
  const metas = host.store.list(all ? undefined : { cwd: host.cwd }).slice(0, 200)
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose()
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1))
    if (key.downArrow) return setSel((s) => Math.min(metas.length - 1, s + 1))
    if (key.tab) {
      setAll((a) => !a)
      setSel(0)
      return
    }
    if (key.return && metas[sel]) onChoose(metas[sel].id)
  })
  return (
    <Popup
      title={all ? 'Resume a chat (all folders)' : 'Resume a chat in this folder'}
      rows={metas.map((m) => ({ key: m.id, label: clip(m.title, 50), detail: `${m.model.modelId}${all ? ` · ${shortPath(m.cwd, 30)}` : ''}`, note: ago(m.updatedAt) }))}
      selected={sel}
      width={width}
      maxRows={10}
      empty={all ? 'No saved chats yet.' : 'No chats in this folder yet. Tab shows all folders.'}
      footer={`⏎ resume · tab ${all ? 'this folder only' : 'all folders'} · esc close`}
    />
  )
}

/** Masked key entry; the key is stored in the OS keychain and tested right away. */
function LoginPrompt({ host, providerId, onDone }: { host: Host; providerId: string; onDone: (msg: string, ok: boolean) => void }) {
  const t = useTheme()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const search = providerId === 'brave' || providerId === 'tavily'
  const provider = host.provider(providerId) ?? { name: providerId === 'brave' ? 'Brave Search' : 'Tavily' }
  useInput((input, k) => {
    if (busy) return
    if (k.escape || (k.ctrl && input === 'c')) return onDone('Login cancelled.', true)
    if (k.return) {
      if (!key.trim()) return onDone('No key entered; nothing changed.', true)
      setBusy(true)
      try {
        host.setKey(providerId, key.trim())
      } catch (e) {
        return onDone((e as Error).message, false)
      }
      if (search) void host.testSearch(providerId as 'brave' | 'tavily').then((r) => onDone(`${provider.name}: ${r.message}`, r.ok))
      else void host.testProvider(providerId).then((r) => onDone(`${provider.name}: key saved (${host.keys.storage}). ${r.message}`, r.ok))
      return
    }
    if (k.backspace || k.delete) return setKey((s) => s.slice(0, -1))
    if (input && !k.ctrl && !k.meta) setKey((s) => s + input.trim())
  })
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={t.accent} paddingX={1}>
      <Text bold>API key for {provider.name}</Text>
      <Text color={t.muted}>Stored in your {host.keys.storage === 'file' ? 'data folder (no keychain found)' : 'OS keychain'}, shared with the desktop app.</Text>
      <Text>
        <Text color={t.accent}>key </Text>
        {'•'.repeat(Math.min(key.length, 40))}
        <Text inverse> </Text>
      </Text>
      <Text color={t.muted}>{busy ? 'Testing…' : 'paste the key · enter to save and test · esc to cancel'}</Text>
    </Box>
  )
}

