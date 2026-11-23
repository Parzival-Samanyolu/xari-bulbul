// Xarı's interactive terminal: the transcript scrolls like normal terminal output, and only the
// bottom (what's streaming, running tools, approvals and the prompt) is redrawn.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Agent, AgentEvent, PermissionAnswer, PermissionMode, PermissionRequest, QuestionRequest, Session } from '@harness/core'
import pkg from '../../package.json'
import type { Host } from '../host.js'
import { setColor, style, truncate, width } from './ansi.js'
import { LineEditor } from './editor.js'
import { splitStable } from './markdown.js'
import { Screen, type Frame } from './screen.js'
import * as v from './view.js'

export interface InteractiveOptions {
  /** Sent as the first message (positional words on the command line). */
  initialPrompt?: string
  /** A new chat, or the one picked by --continue / --resume. */
  session: Session
}

interface Key {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

type Overlay =
  | { kind: 'permission'; req: PermissionRequest; selected: number; resolve: (a: PermissionAnswer) => void }
  | { kind: 'question'; req: QuestionRequest; selected: number; checked: Set<number>; resolve: (s: string) => void }
  | { kind: 'picker'; title: string; choices: v.Choice[]; selected: number; pick: (i: number) => void }

interface RunningTool {
  name: string
  subject: string
  progress: string
}

const BUILTIN = new Set(['help', 'new', 'clear', 'resume', 'model', 'mode', 'compact', 'undo', 'cost', 'exit', 'quit'])

/** Runs the chat until the user quits; resolves with the process exit code. */
export async function runInteractive(host: Host, opts: InteractiveOptions): Promise<number> {
  const out = process.stdout
  const stdin = process.stdin
  setColor(!process.env.NO_COLOR && out.isTTY !== false)
  const screen = new Screen(out)
  const historyFile = path.join(host.dataDir, 'cli-history.json')
  const editor = new LineEditor(readHistory(historyFile))
  const version = pkg.version

  let session = opts.session
  let agent!: Agent
  let mode: PermissionMode = host.settings.permissions.mode
  let overlay: Overlay | null = null
  let running = false
  let turnStarted = 0
  let tokensOut = 0
  let spin = 0
  let reply = { text: '', printed: false }
  let thinking = ''
  let tools = new Map<string, RunningTool>()
  let contextPct: number | null = null
  let cost = 0
  let hint = ''
  let lastCtrlC = 0
  let lastEsc = 0
  const queue: string[] = []
  let done: (code: number) => void = () => {}
  const finished = new Promise<number>((r) => (done = r))

  // ---------------------------------------------------------------- drawing

  const modelName = () => `${agent.model.providerId}/${agent.model.modelId}`

  /** The live region: what's in progress, any open approval or question, the prompt and the status line. */
  const frame = (): Frame => {
    const cols = screen.cols
    const lines: string[] = []
    if (reply.text.trim()) lines.push(...v.replyLines(reply.text, cols, !reply.printed))
    else if (running && thinking && !tools.size) lines.push(v.thinkingLine(thinking, Math.round((Date.now() - turnStarted) / 1000), cols))
    for (const t of tools.values()) {
      lines.push(v.toolLine(t.name, t.subject, 'running', cols, v.SPINNER[spin % v.SPINNER.length]))
      for (const p of t.progress.split('\n').filter(Boolean).slice(-3)) lines.push(style.gray(truncate(`    ${p}`, cols)))
    }
    if (running && !overlay) {
      const label = tools.size ? 'Working' : reply.text ? 'Writing' : thinking ? 'Thinking' : 'Waiting for the model'
      lines.push('', v.statusLine(v.SPINNER[spin % v.SPINNER.length], label, Math.round((Date.now() - turnStarted) / 1000), tokensOut, cols))
    }
    if (overlay?.kind === 'permission') lines.push('', ...v.permissionBox(overlay.req, overlay.selected, cols))
    else if (overlay?.kind === 'question') lines.push('', ...v.questionBox(overlay.req, overlay.selected, overlay.checked, cols))
    else if (overlay?.kind === 'picker') lines.push('', ...v.pickerLines(overlay.title, overlay.choices, overlay.selected, cols))
    if (lines.length) lines.push('')

    // The prompt, wrapped by hand so the caret can be placed exactly.
    const textCols = cols - 2
    const visual: string[] = []
    let caret = { row: 0, col: 2 }
    const pos = editor.cursor()
    editor.lines().forEach((line, i) => {
      const chunks = chunk(line, textCols)
      if (i === pos.row) {
        const before = [...line].slice(0, pos.col).join('')
        const w = width(before)
        const r = Math.min(Math.floor(w / textCols), chunks.length - 1 + (w > 0 && w % textCols === 0 && w / textCols === chunks.length ? 1 : 0))
        caret = { row: visual.length + r, col: 2 + (w - r * textCols) }
        if (r >= chunks.length) chunks.push('')
      }
      visual.push(...chunks)
    })
    const placeholder = overlay?.kind === 'permission' ? 'Or type what to do instead' : overlay?.kind === 'question' ? 'Type an answer, or pick one above' : running ? 'Type to queue a message' : 'Ask Xarı to do something · /help'
    const inputTop = lines.length
    lines.push(...v.inputLines(visual, cols, placeholder, running))
    caret.row += inputTop + 1

    // / commands that match what's typed so far.
    const typed = editor.text
    if (/^\/\S*$/.test(typed) && !overlay) {
      for (const c of commandMatches(typed.slice(1)).slice(0, 6)) lines.push(truncate(`  ${style.accent(`/${c.name}`)}  ${style.gray(c.description)}`, cols))
    }
    lines.push(v.footer({ mode, model: modelName(), contextPct, cost, queued: queue.length, hint, cols }))
    return { lines, cursor: caret }
  }

  let scheduled = false
  const render = () => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      screen.render(frame())
    })
  }
  /** Prints lines into the transcript for good, then redraws the live region under them. */
  const print = (lines: string[]) => screen.print(lines, frame())

  // ---------------------------------------------------------------- the agent

  const commandMatches = (prefix: string) => {
    const all = [
      ...v.HELP.map(([c, d]) => ({ name: c.split(/[ ,]/)[0].slice(1), description: d })),
      ...host.slashCommands().filter((c) => !BUILTIN.has(c.name)),
    ]
    return all.filter((c) => c.name.startsWith(prefix.toLowerCase()))
  }

  const flushReply = () => {
    if (reply.text.trim()) print([...v.replyLines(reply.text, screen.cols, !reply.printed), ''])
    reply = { text: '', printed: false }
  }

  const onEvent = (e: AgentEvent) => {
    const cols = screen.cols
    switch (e.type) {
      case 'turn_start':
        running = true
        turnStarted = Date.now()
        tokensOut = 0
        thinking = ''
        break
      case 'text': {
        reply.text += e.delta
        tokensOut += Math.ceil(e.delta.length / 4)
        // Finished paragraphs go to the transcript; only the one being written stays live.
        const [stable, rest] = splitStable(reply.text)
        if (stable.trim()) {
          const first = !reply.printed
          reply = { text: rest, printed: true }
          print([...v.replyLines(stable, cols, first), ''])
          return
        }
        break
      }
      case 'reasoning':
        thinking += e.delta
        tokensOut += Math.ceil(e.delta.length / 4)
        break
      case 'stream_reset':
        reply = { text: '', printed: reply.printed }
        thinking = ''
        break
      case 'message':
        if (e.message.role === 'assistant') flushReply()
        break
      case 'tool_start':
        flushReply()
        tools.set(e.callId, { name: e.name, subject: e.subject, progress: '' })
        break
      case 'tool_progress': {
        const t = tools.get(e.callId)
        if (t) t.progress = (t.progress + e.text).slice(-2000)
        break
      }
      case 'tool_end': {
        const t = tools.get(e.callId)
        tools.delete(e.callId)
        const state: v.ToolState = e.denied ? 'denied' : e.result.isError ? 'error' : 'ok'
        print([v.toolLine(e.name, t?.subject ?? '', state, cols), ...v.toolResultLines(e.name, e.result, !!e.denied, cols, session.meta.cwd), ''])
        return
      }
      case 'todos':
        if (e.todos.length) print([style.gray('  Checklist'), ...v.todoLines(e.todos, cols), ''])
        return
      case 'usage':
        contextPct = e.contextLength ? Math.round((e.contextTokens / e.contextLength) * 100) : null
        cost = e.summary.session.cost
        break
      case 'compacted':
        print([style.gray(`  ◇ Summarized ${e.removedMessages} older messages to free up context`), ''])
        return
      case 'notice':
        print([(e.level === 'warn' ? style.yellow : style.gray)(`  ${e.text}`)])
        return
      case 'fallback':
        print([style.yellow(`  ${e.text}`)])
        return
      case 'error':
        flushReply()
        print([style.red(`  ✕ ${e.message}`), ''])
        return
      case 'memory':
        if (e.added.length) print([style.gray(`  ◇ Remembered: ${e.added.map((f) => f.fact).join('; ')}`)])
        return
      case 'turn_end': {
        flushReply()
        running = false
        thinking = ''
        tools = new Map()
        const why: Record<string, string> = { aborted: 'Stopped.', max_steps: 'Stopped at the step limit. Say “continue” to go on.', budget: 'Stopped: the budget limit was reached.', repeating: 'Stopped: it kept repeating the same step.', error: '' }
        if (e.reason !== 'done' && why[e.reason]) print([style.yellow(`  ${why[e.reason]}`), ''])
        // Messages typed while it worked go next, one turn each.
        const next = queue.shift()
        if (next) setImmediate(() => void send(next))
        break
      }
    }
    render()
  }

  const askPermission = (req: PermissionRequest) =>
    new Promise<PermissionAnswer>((resolve) => {
      out.write('\x07') // a bell, so an approval waiting in another window gets noticed
      overlay = { kind: 'permission', req, selected: 0, resolve }
      render()
    })

  const askUser = (req: QuestionRequest) =>
    new Promise<string>((resolve) => {
      overlay = { kind: 'question', req, selected: 0, checked: new Set(), resolve }
      render()
    })

  const attach = (s: Session) => {
    agent?.dispose()
    session = s
    agent = host.createAgent(s, { onEvent, askPermission, askUser, mode })
    contextPct = null
    cost = host.usage.summary(s.meta.id).session.cost
  }

  const send = async (text: string) => {
    if (running) {
      queue.push(text)
      render()
      return
    }
    print(v.userMessage(text, screen.cols))
    try {
      await agent.send(host.expandPrompt(text, session.meta.cwd))
    } catch (err) {
      running = false
      print([style.red(`  ✕ ${(err as Error).message}`), ''])
    }
    render()
  }

  // ---------------------------------------------------------------- commands

  const setMode = (m: PermissionMode) => {
    mode = m
    host.setMode(agent, m)
    const info = v.modeOf(m)
    flash(`${info.label} mode`)
  }

  const flash = (text: string) => {
    hint = text
    render()
    setTimeout(() => {
      if (hint === text) {
        hint = ''
        render()
      }
    }, 2500)
  }

  const runCommand = async (line: string): Promise<boolean> => {
    const m = /^\/(\S+)\s*(.*)$/s.exec(line.trim())
    if (!m) return false
    const [, name, arg] = m
    const cols = screen.cols
    switch (name) {
      case 'help':
        print(v.helpLines(host.slashCommands().filter((c) => !BUILTIN.has(c.name)), cols))
        return true
      case 'exit':
      case 'quit':
        quit()
        return true
      case 'new':
      case 'clear':
        if (running) agent.stop()
        attach(host.newSession(agent.model))
        print([style.gray('  ◇ New chat'), ''])
        return true
      case 'mode': {
        const want = v.MODES.find((x) => x.id.toLowerCase() === arg.trim().toLowerCase() || x.label.toLowerCase() === arg.trim().toLowerCase())
        if (arg.trim() && !want) print([style.yellow(`  Modes: ${v.MODES.map((x) => x.id).join(', ')}`)])
        else setMode(want?.id ?? nextMode(mode))
        return true
      }
      case 'model':
        if (arg.trim()) {
          try {
            agent.setModel(host.resolveModel(arg.trim()))
            print([style.gray(`  ◇ Model: ${modelName()}`), ''])
            const keyHint = host.keyHint(agent.model.providerId)
            if (keyHint) print([style.yellow(`  ${keyHint}`)])
          } catch (err) {
            print([style.red(`  ✕ ${(err as Error).message}`)])
          }
        } else {
          const models = await host.models(agent.model.providerId).catch(() => [])
          if (!models.length) print([style.gray(`  Model: ${modelName()}. Switch with /model provider/model`)])
          else
            overlay = {
              kind: 'picker',
              title: `Model · ${agent.model.providerId}`,
              choices: models.slice(0, 200).map((x) => ({ label: x.id, hint: x.free ? 'free' : x.contextLength ? `${Math.round(x.contextLength / 1000)}k` : undefined })),
              selected: Math.max(0, models.findIndex((x) => x.id === agent.model.modelId)),
              pick: (i) => {
                agent.setModel({ providerId: agent.model.providerId, modelId: models[i].id })
                print([style.gray(`  ◇ Model: ${modelName()}`), ''])
              },
            }
        }
        return true
      case 'resume': {
        const chats = host.listSessions(session.meta.cwd).filter((s) => s.id !== session.meta.id && !s.botId)
        if (!chats.length) {
          print([style.gray('  No earlier chats in this folder.')])
          return true
        }
        overlay = {
          kind: 'picker',
          title: 'Resume a chat',
          choices: chats.map((s) => ({ label: s.title, hint: ago(s.updatedAt) })),
          selected: 0,
          pick: (i) =>
            void host.loadSession(chats[i].id).then((s) => {
              if (!s) return print([style.red('  ✕ That chat is gone.')])
              attach(s)
              print(transcript(s, screen.cols))
            }),
        }
        return true
      }
      case 'compact':
        if (running) return print([style.yellow('  Wait for the turn to finish first.')]), true
        print([style.gray('  ◇ Summarizing older messages…')])
        await agent.compact().then(
          (ok) => !ok && print([style.gray('  Nothing to summarize yet.')]),
          (err) => print([style.red(`  ✕ ${(err as Error).message}`)]),
        )
        return true
      case 'undo': {
        const cp = agent.checkpoints.at(-1)
        if (!cp) return print([style.gray('  Nothing to undo: no files changed in this chat yet.')]), true
        try {
          const restored = agent.revert(cp.at)
          print([style.green(`  ↶ Put back ${restored.length} file${restored.length === 1 ? '' : 's'}`), ...restored.map((f) => style.gray(`    ${path.relative(session.meta.cwd, f) || f}`)), ''])
        } catch (err) {
          print([style.red(`  ✕ ${(err as Error).message}`)])
        }
        return true
      }
      case 'cost': {
        const s = host.usage.summary(session.meta.id)
        const row = (label: string, t: typeof s.session) => `  ${pad(label, 10)} ${t.requests} requests · ${fmtTokens(t.promptTokens)} in · ${fmtTokens(t.completionTokens)} out · $${t.cost.toFixed(4)}${t.costPartial ? ' (some prices unknown)' : ''}`
        print([row('This chat', s.session), row('Today', s.today), ''])
        return true
      }
      default:
        return false
    }
  }

  // ---------------------------------------------------------------- keys

  let pasting = false
  let pasted = ''

  const onKey = (str: string | undefined, key: Key = {}) => {
    if (key.name === 'paste-start') return void (pasting = true)
    if (key.name === 'paste-end') {
      pasting = false
      editor.insert(pasted)
      pasted = ''
      return render()
    }
    if (pasting) {
      pasted += key.name === 'return' || key.name === 'enter' ? '\n' : (str ?? key.sequence ?? '')
      return
    }
    if (key.ctrl && key.name === 'c') return ctrlC()
    if (key.ctrl && key.name === 'd' && editor.empty && !overlay) return quit()
    if (key.ctrl && key.name === 'l') {
      out.write('\x1b[2J\x1b[3J\x1b[H')
      return screen.refresh()
    }
    if (overlay && handleOverlayKey(str, key)) return render()
    if (key.name === 'tab' && key.shift) return setMode(nextMode(mode))
    if (key.name === 'escape') {
      if (running) {
        agent.stop()
        return flash('Stopping…')
      }
      if (!editor.empty && Date.now() - lastEsc < 600) editor.clear()
      lastEsc = Date.now()
      return render()
    }
    if (key.name === 'tab') {
      const m = /^\/(\S*)$/.exec(editor.text)
      const first = m && commandMatches(m[1])[0]
      if (first) editor.set(`/${first.name} `)
      return render()
    }
    if (key.name === 'return' && !key.meta && !key.shift) return void submit()
    if (key.name === 'enter' || (key.name === 'return' && (key.meta || key.shift)) || (key.ctrl && key.name === 'j')) editor.insert('\n')
    else if (key.name === 'backspace') key.meta || key.ctrl ? editor.killWord() : editor.backspace()
    else if (key.name === 'delete') editor.del()
    else if (key.name === 'left') key.meta || key.ctrl ? editor.wordLeft() : editor.left()
    else if (key.name === 'right') key.meta || key.ctrl ? editor.wordRight() : editor.right()
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) editor.home()
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) editor.end()
    else if (key.name === 'up') editor.up()
    else if (key.name === 'down') editor.down()
    else if (key.ctrl && key.name === 'u') editor.killBefore()
    else if (key.ctrl && key.name === 'k') editor.killAfter()
    else if (key.ctrl && key.name === 'w') editor.killWord()
    else if (key.meta && key.name === 'b') editor.wordLeft()
    else if (key.meta && key.name === 'f') editor.wordRight()
    else if (str && !key.ctrl && !(key.meta && str.length === 1 && key.name)) editor.insert(str)
    render()
  }

  /** Keys an open approval, question or list takes; false lets the prompt have it. */
  const handleOverlayKey = (str: string | undefined, key: Key): boolean => {
    const o = overlay!
    const count = o.kind === 'permission' ? 3 : o.kind === 'question' ? o.req.options.length : o.choices.length
    if (key.name === 'up') return (o.selected = (o.selected + count - 1) % count), true
    if (key.name === 'down') return (o.selected = (o.selected + 1) % count), true
    if (key.name === 'escape') return closeOverlay(), true
    if (o.kind === 'picker') {
      if (key.name === 'return') {
        overlay = null
        o.pick(o.selected)
      }
      return true
    }
    if (o.kind === 'permission') {
      // Shortcuts only while nothing is typed; typing means "no, do this instead".
      if (editor.empty && str && /^[123yan]$/i.test(str) && !key.ctrl) {
        const i = { 1: 0, 2: 1, 3: 2, y: 0, a: 1, n: 2 }[str.toLowerCase() as '1'] ?? 0
        if (i === 2) return (o.selected = 2), true
        return answerPermission(i), true
      }
      if (key.name === 'return' && !key.meta) {
        answerPermission(editor.empty ? o.selected : 2)
        return true
      }
      if (str && !key.ctrl && !key.meta && key.name !== 'return') o.selected = 2
      return false
    }
    // A question.
    if (o.req.multiSelect && key.name === 'space' && editor.empty) {
      if (!o.checked.delete(o.selected)) o.checked.add(o.selected)
      return true
    }
    if (editor.empty && str && /^[1-9]$/.test(str) && Number(str) <= count && !o.req.multiSelect) {
      answerQuestion(o.req.options[Number(str) - 1])
      return true
    }
    if (key.name === 'return' && !key.meta) {
      const typed = editor.text.trim()
      const picked = o.req.multiSelect ? [...o.checked].sort().map((i) => o.req.options[i]).join(', ') : o.req.options[o.selected]
      if (typed) editor.submit()
      answerQuestion(typed || picked || '')
      return true
    }
    return false
  }

  const answerPermission = (choice: number) => {
    const o = overlay
    if (o?.kind !== 'permission') return
    overlay = null
    if (choice === 0) o.resolve({ type: 'allow' })
    else if (choice === 1) o.resolve({ type: 'allowAlways' })
    else {
      const feedback = editor.text.trim()
      if (feedback) editor.submit()
      o.resolve({ type: 'deny', feedback: feedback || undefined })
    }
  }

  const answerQuestion = (answer: string) => {
    const o = overlay
    if (o?.kind !== 'question') return
    overlay = null
    if (answer) print([style.gray(`  ↳ ${answer}`)])
    o.resolve(answer)
  }

  const closeOverlay = () => {
    const o = overlay
    overlay = null
    if (o?.kind === 'permission') o.resolve({ type: 'deny' })
    else if (o?.kind === 'question') o.resolve('')
  }

  const ctrlC = () => {
    if (overlay) return closeOverlay(), render()
    if (running) {
      agent.stop()
      return flash('Stopping…')
    }
    if (!editor.empty) {
      editor.clear()
      return render()
    }
    if (Date.now() - lastCtrlC < 2000) return quit()
    lastCtrlC = Date.now()
    flash('Press ctrl+c again to quit')
  }

  const submit = async () => {
    const text = editor.text
    if (!text.trim()) return render()
    editor.submit()
    saveHistory(historyFile, editor.past)
    if (text.trim().startsWith('/') && (await runCommand(text))) return render()
    void send(text)
  }

  // ---------------------------------------------------------------- start and stop

  let quitting = false
  const quit = () => {
    if (quitting) return
    quitting = true
    if (running) agent.stop()
    stdin.off('keypress', onKey)
    if (stdin.isTTY) stdin.setRawMode(false)
    out.write('\x1b[?2004l')
    screen.close()
    if (session.messages.length) out.write(style.gray(`Resume this chat with: xari --resume ${session.meta.id}\n`))
    stdin.pause()
    done(0)
  }

  attach(session)
  out.write('\n')
  print([
    ...v.banner({ version, model: modelName(), mode, cwd: session.meta.cwd, resumed: session.messages.length ? session.meta.title : undefined, cols: screen.cols }),
    ...(session.messages.length ? transcript(session, screen.cols) : []),
  ])

  readline.emitKeypressEvents(stdin)
  if (stdin.isTTY) stdin.setRawMode(true)
  out.write('\x1b[?2004h') // bracketed paste: pasted newlines don't send the message
  stdin.on('keypress', onKey)
  stdin.resume()
  out.on('resize', () => screen.refresh())
  const ticker = setInterval(() => {
    if (!running) return
    spin++
    render()
  }, 90)
  ticker.unref()

  if (opts.initialPrompt) void send(opts.initialPrompt)
  const code = await finished
  clearInterval(ticker)
  agent.dispose()
  return code
}

// ---------------------------------------------------------------- helpers

/** An earlier chat, shortened: your messages, the replies and which tools ran. */
function transcript(s: Session, cols: number): string[] {
  const out: string[] = []
  for (const m of s.messages.slice(-40)) {
    if (m.role === 'user' && !m.synthetic) out.push(...v.userMessage(m.content, cols))
    else if (m.role === 'assistant') {
      if (m.content.trim()) out.push(...v.replyLines(m.content, cols, true), '')
      for (const c of m.toolCalls ?? []) out.push(style.gray(`◆ ${v.toolLabel(c.name)}`))
      if (m.toolCalls?.length) out.push('')
    }
  }
  if (s.messages.length > 40) out.unshift(style.gray(`  … ${s.messages.length - 40} earlier messages`), '')
  return [...out, style.gray('  ── resumed ──'), '']
}

const nextMode = (m: PermissionMode): PermissionMode => {
  const i = v.MODES.findIndex((x) => x.id === m)
  return v.MODES[(i + 1) % v.MODES.length].id
}

/** Splits a line into pieces of at most `cols` columns (the prompt wraps by characters, not words). */
function chunk(line: string, cols: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (width(cur + ch) > cols) {
      out.push(cur)
      cur = ''
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function readHistory(file: string): string[] {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHistory(file: string, history: string[]) {
  try {
    fs.writeFileSync(file, JSON.stringify(history.slice(-500)))
  } catch {
    /* history is a convenience */
  }
}

