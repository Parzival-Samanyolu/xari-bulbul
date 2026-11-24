// The chat's state, apart from how it's drawn: the agent, its events, approvals, questions,
// commands and the transcript. The Ink components read `state` and call the methods.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Agent, AgentEvent, PermissionAnswer, PermissionMode, PermissionRequest, QuestionRequest, Session, ToolResult, TodoItem } from '@harness/core'
import type { Host } from '../host.js'
import { splitStable } from '../tui/markdown.js'

/** One finished entry of the transcript (printed once, into the terminal's scrollback). */
export type Item =
  | { id: number; kind: 'banner'; version: string; model: string; mode: PermissionMode; cwd: string; resumed?: string }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'reply'; text: string; first: boolean }
  | { id: number; kind: 'tool'; name: string; subject: string; state: 'ok' | 'error' | 'denied'; result: ToolResult; cwd: string }
  | { id: number; kind: 'todos'; todos: TodoItem[] }
  | { id: number; kind: 'notice'; text: string; level: 'info' | 'warn' | 'error' | 'ok' }
  | { id: number; kind: 'lines'; title?: string; rows: [string, string][] }

/** An entry before it gets its id (spread over each kind of entry). */
type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'id'> : never) : never

export interface RunningTool {
  callId: string
  name: string
  subject: string
  progress: string
}

export type Overlay =
  | { kind: 'permission'; req: PermissionRequest }
  | { kind: 'question'; req: QuestionRequest; checked: number[] }
  | { kind: 'picker'; title: string; choices: { label: string; hint?: string }[]; initial: number; pick: (i: number) => void }

export interface ChatState {
  items: Item[]
  /** The reply being written: only its unfinished paragraph (finished ones are items already). */
  reply: string
  replyStarted: boolean
  thinking: string
  tools: RunningTool[]
  running: boolean
  turnStarted: number
  tokensOut: number
  overlay: Overlay | null
  mode: PermissionMode
  model: string
  contextPct: number | null
  cost: number
  queue: string[]
  hint: string
}

export const MODE_ORDER: PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'auto']

export const BUILTIN_HELP: [string, string][] = [
  ['/help', 'this list'],
  ['/new', 'start a new chat (also /clear)'],
  ['/resume', 'open an earlier chat in this folder'],
  ['/model [name]', 'show or switch the model (provider/model)'],
  ['/mode [mode]', 'ask, acceptEdits, plan or auto (shift+tab cycles)'],
  ['/compact', 'summarize older messages to free context'],
  ['/undo', 'put back the files the last turn changed'],
  ['/cost', 'tokens and cost for this chat and today'],
  ['/exit', 'quit (or ctrl+d)'],
]

export const KEY_HELP: [string, string][] = [
  ['enter', 'send · alt+enter or ctrl+j for a new line'],
  ['esc', 'stop the agent · twice to clear the prompt'],
  ['shift+tab', 'cycle Ask → Auto-edit → Plan → Full auto'],
  ['↑ ↓', 'earlier prompts'],
  ['tab', 'complete a / command'],
  ['ctrl+c', 'stop, clear, then quit'],
]

const BUILTIN = new Set(['help', 'new', 'clear', 'resume', 'model', 'mode', 'compact', 'undo', 'cost', 'exit', 'quit'])

export class ChatStore extends EventEmitter {
  state: ChatState
  private agent!: Agent
  private session: Session
  private nextId = 0
  private resolvePermission: ((a: PermissionAnswer) => void) | null = null
  private resolveQuestion: ((s: string) => void) | null = null

  constructor(
    private readonly host: Host,
    session: Session,
    private readonly version: string,
  ) {
    super()
    this.session = session
    this.state = {
      items: [],
      reply: '',
      replyStarted: false,
      thinking: '',
      tools: [],
      running: false,
      turnStarted: 0,
      tokensOut: 0,
      overlay: null,
      mode: host.settings.permissions.mode,
      model: '',
      contextPct: null,
      cost: 0,
      queue: [],
      hint: '',
    }
    this.attach(session)
    this.add({ kind: 'banner', version, model: this.state.model, mode: this.state.mode, cwd: session.meta.cwd, resumed: session.messages.length ? session.meta.title : undefined })
    if (session.messages.length) this.replay(session)
  }

  get sessionId() {
    return this.session.meta.id
  }

  get hasMessages() {
    return this.session.messages.length > 0
  }

  get cwd() {
    return this.session.meta.cwd
  }

  // ---------------------------------------------------------------- state

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch }
    this.emit('change')
  }

  private add(item: NewItem) {
    this.set({ items: [...this.state.items, { ...item, id: this.nextId++ } as Item] })
  }

  notice(text: string, level: 'info' | 'warn' | 'error' | 'ok' = 'info') {
    this.add({ kind: 'notice', text, level })
  }

  flash(text: string) {
    this.set({ hint: text })
    setTimeout(() => {
      if (this.state.hint === text) this.set({ hint: '' })
    }, 2500).unref()
  }

  // ---------------------------------------------------------------- the agent

  private attach(s: Session) {
    this.agent?.dispose()
    this.session = s
    this.agent = this.host.createAgent(s, {
      mode: this.state.mode,
      onEvent: (e) => this.onEvent(e),
      askPermission: (req) =>
        new Promise((resolve) => {
          process.stdout.write('\x07') // a bell, so an approval waiting in another window gets noticed
          this.resolvePermission = resolve
          this.set({ overlay: { kind: 'permission', req } })
        }),
      askUser: (req) =>
        new Promise((resolve) => {
          this.resolveQuestion = resolve
          this.set({ overlay: { kind: 'question', req, checked: [] } })
        }),
    })
    this.set({ model: this.modelName(), contextPct: null, cost: this.host.usage.summary(s.meta.id).session.cost })
  }

  private modelName() {
    return `${this.agent.model.providerId}/${this.agent.model.modelId}`
  }

  private flushReply() {
    if (this.state.reply.trim()) this.add({ kind: 'reply', text: this.state.reply, first: !this.state.replyStarted })
    this.set({ reply: '', replyStarted: false })
  }

  private onEvent(e: AgentEvent) {
    switch (e.type) {
      case 'turn_start':
        return this.set({ running: true, turnStarted: Date.now(), tokensOut: 0, thinking: '' })
      case 'text': {
        const text = this.state.reply + e.delta
        const tokensOut = this.state.tokensOut + Math.ceil(e.delta.length / 4)
        // Finished paragraphs go to the transcript; only the one being written stays live.
        const [stable, rest] = splitStable(text)
        if (stable.trim()) {
          this.add({ kind: 'reply', text: stable, first: !this.state.replyStarted })
          return this.set({ reply: rest, replyStarted: true, tokensOut })
        }
        return this.set({ reply: text, tokensOut })
      }
      case 'reasoning':
        return this.set({ thinking: this.state.thinking + e.delta, tokensOut: this.state.tokensOut + Math.ceil(e.delta.length / 4) })
      case 'stream_reset':
        return this.set({ reply: '', thinking: '' })
      case 'message':
        if (e.message.role === 'assistant') this.flushReply()
        return
      case 'tool_start':
        this.flushReply()
        return this.set({ tools: [...this.state.tools, { callId: e.callId, name: e.name, subject: e.subject, progress: '' }] })
      case 'tool_progress':
        return this.set({ tools: this.state.tools.map((t) => (t.callId === e.callId ? { ...t, progress: (t.progress + e.text).slice(-2000) } : t)) })
      case 'tool_end': {
        const t = this.state.tools.find((x) => x.callId === e.callId)
        this.set({ tools: this.state.tools.filter((x) => x.callId !== e.callId) })
        return this.add({ kind: 'tool', name: e.name, subject: t?.subject ?? '', state: e.denied ? 'denied' : e.result.isError ? 'error' : 'ok', result: e.result, cwd: this.session.meta.cwd })
      }
      case 'todos':
        if (e.todos.length) this.add({ kind: 'todos', todos: e.todos })
        return
      case 'usage':
        return this.set({ contextPct: e.contextLength ? Math.round((e.contextTokens / e.contextLength) * 100) : null, cost: e.summary.session.cost })
      case 'compacted':
        return this.notice(`Summarized ${e.removedMessages} older messages to free up context`)
      case 'notice':
        return this.notice(e.text, e.level === 'warn' ? 'warn' : 'info')
      case 'fallback':
        return this.notice(e.text, 'warn')
      case 'error':
        this.flushReply()
        return this.notice(e.message, 'error')
      case 'memory':
        if (e.added.length) this.notice(`Remembered: ${e.added.map((f) => f.fact).join('; ')}`)
        return
      case 'turn_end': {
        this.flushReply()
        this.set({ running: false, thinking: '', tools: [] })
        const why: Record<string, string> = { aborted: 'Stopped.', max_steps: 'Stopped at the step limit. Say “continue” to go on.', budget: 'Stopped: the budget limit was reached.', repeating: 'Stopped: it kept repeating the same step.' }
        if (why[e.reason]) this.notice(why[e.reason], 'warn')
        // Messages typed while it worked go next, one turn each.
        const [next, ...rest] = this.state.queue
        if (next) {
          this.set({ queue: rest })
          setImmediate(() => void this.send(next))
        }
        return
      }
    }
  }

  // ---------------------------------------------------------------- what the user does

  /** A prompt from the input box: a command, or a message (queued while a turn runs). */
  async submit(text: string) {
    if (!text.trim()) return
    if (text.trim().startsWith('/') && (await this.command(text))) return
    await this.send(text)
  }

  async send(text: string) {
    if (this.state.running) return this.set({ queue: [...this.state.queue, text] })
    this.add({ kind: 'user', text })
    try {
      await this.agent.send(this.host.expandPrompt(text, this.session.meta.cwd))
    } catch (err) {
      this.set({ running: false })
      this.notice((err as Error).message, 'error')
    }
  }

  stop() {
    if (!this.state.running) return false
    this.agent.stop()
    this.flash('Stopping…')
    return true
  }

  setMode(mode: PermissionMode) {
    this.host.setMode(this.agent, mode)
    this.set({ mode })
    this.flash(`${modeLabel(mode)} mode`)
  }

  cycleMode() {
    this.setMode(MODE_ORDER[(MODE_ORDER.indexOf(this.state.mode) + 1) % MODE_ORDER.length])
  }

  answerPermission(answer: PermissionAnswer) {
    const r = this.resolvePermission
    this.resolvePermission = null
    this.set({ overlay: null })
    r?.(answer)
  }

  answerQuestion(answer: string) {
    const r = this.resolveQuestion
    this.resolveQuestion = null
    this.set({ overlay: null })
    if (answer) this.notice(`↳ ${answer}`)
    r?.(answer)
  }

  toggleChoice(i: number) {
    const o = this.state.overlay
    if (o?.kind !== 'question') return
    const checked = o.checked.includes(i) ? o.checked.filter((x) => x !== i) : [...o.checked, i]
    this.set({ overlay: { ...o, checked } })
  }

  pick(i: number) {
    const o = this.state.overlay
    if (o?.kind !== 'picker') return
    this.set({ overlay: null })
    o.pick(i)
  }

  /** Esc or ctrl+c on an open approval, question or list. */
  cancelOverlay() {
    const o = this.state.overlay
    if (o?.kind === 'permission') this.answerPermission({ type: 'deny' })
    else if (o?.kind === 'question') this.answerQuestion('')
    else this.set({ overlay: null })
  }

  /** Commands for the suggestion list: Xarı's own, then the user's commands and skills. */
  commands(prefix: string): { name: string; description: string }[] {
    const all = [...BUILTIN_HELP.map(([c, d]) => ({ name: c.split(/[ ,]/)[0].slice(1), description: d })), ...this.host.slashCommands().filter((c) => !BUILTIN.has(c.name))]
    return all.filter((c) => c.name.startsWith(prefix.toLowerCase()))
  }

  private async command(line: string): Promise<boolean> {
    const m = /^\/(\S+)\s*(.*)$/s.exec(line.trim())
    if (!m) return false
    const [, name, raw] = m
    const arg = raw.trim()
    switch (name) {
      case 'help':
        this.add({ kind: 'lines', title: 'Commands', rows: BUILTIN_HELP })
        {
          const own = this.host.slashCommands().filter((c) => !BUILTIN.has(c.name))
          if (own.length) this.add({ kind: 'lines', title: 'Your commands and skills', rows: own.map((c) => [`/${c.name}`, c.description]) })
        }
        this.add({ kind: 'lines', title: 'Keys', rows: KEY_HELP })
        return true
      case 'exit':
      case 'quit':
        this.emit('quit')
        return true
      case 'new':
      case 'clear':
        if (this.state.running) this.agent.stop()
        this.attach(this.host.newSession(this.agent.model))
        this.notice('New chat')
        return true
      case 'mode': {
        if (!arg) return this.cycleMode(), true
        const want = MODE_ORDER.find((x) => x.toLowerCase() === arg.toLowerCase() || modeLabel(x).toLowerCase() === arg.toLowerCase())
        if (want) this.setMode(want)
        else this.notice(`Modes: ${MODE_ORDER.join(', ')}`, 'warn')
        return true
      }
      case 'model': {
        if (arg) {
          try {
            this.agent.setModel(this.host.resolveModel(arg))
            this.set({ model: this.modelName() })
            this.notice(`Model: ${this.modelName()}`)
            const hint = this.host.keyHint(this.agent.model.providerId)
            if (hint) this.notice(hint, 'warn')
          } catch (err) {
            this.notice((err as Error).message, 'error')
          }
          return true
        }
        const provider = this.agent.model.providerId
        const models = await this.host.models(provider).catch(() => [])
        if (!models.length) {
          this.notice(`Model: ${this.modelName()}. Switch with /model provider/model`)
          return true
        }
        this.set({
          overlay: {
            kind: 'picker',
            title: `Model · ${provider}`,
            choices: models.slice(0, 300).map((x) => ({ label: x.id, hint: x.free ? 'free' : x.contextLength ? `${Math.round(x.contextLength / 1000)}k` : undefined })),
            initial: Math.max(0, models.findIndex((x) => x.id === this.agent.model.modelId)),
            pick: (i) => {
              this.agent.setModel({ providerId: provider, modelId: models[i].id })
              this.set({ model: this.modelName() })
              this.notice(`Model: ${this.modelName()}`)
            },
          },
        })
        return true
      }
      case 'resume': {
        const chats = this.host.listSessions(this.session.meta.cwd).filter((s) => s.id !== this.session.meta.id && !s.botId)
        if (!chats.length) {
          this.notice('No earlier chats in this folder.')
          return true
        }
        this.set({
          overlay: {
            kind: 'picker',
            title: 'Resume a chat',
            choices: chats.map((s) => ({ label: s.title, hint: ago(s.updatedAt) })),
            initial: 0,
            pick: (i) =>
              void this.host.loadSession(chats[i].id).then((s) => {
                if (!s) return this.notice('That chat is gone.', 'error')
                this.attach(s)
                this.replay(s)
              }),
          },
        })
        return true
      }
      case 'compact':
        if (this.state.running) return this.notice('Wait for the turn to finish first.', 'warn'), true
        this.notice('Summarizing older messages…')
        await this.agent.compact().then(
          (ok) => !ok && this.notice('Nothing to summarize yet.'),
          (err) => this.notice((err as Error).message, 'error'),
        )
        return true
      case 'undo': {
        const cp = this.agent.checkpoints.at(-1)
        if (!cp) return this.notice('Nothing to undo: no files changed in this chat yet.'), true
        try {
          const restored = this.agent.revert(cp.at)
          this.notice(`↶ Put back ${restored.length} file${restored.length === 1 ? '' : 's'}: ${restored.map((f) => path.relative(this.session.meta.cwd, f) || f).join(', ')}`, 'ok')
        } catch (err) {
          this.notice((err as Error).message, 'error')
        }
        return true
      }
      case 'cost': {
        const s = this.host.usage.summary(this.session.meta.id)
        const row = (t: typeof s.session) => `${t.requests} requests · ${fmtTokens(t.promptTokens)} in · ${fmtTokens(t.completionTokens)} out · $${t.cost.toFixed(4)}${t.costPartial ? ' (some prices unknown)' : ''}`
        this.add({ kind: 'lines', title: 'Usage', rows: [['This chat', row(s.session)], ['Today', row(s.today)]] })
        return true
      }
      default:
        return false
    }
  }

  /** An earlier chat, shortened: your messages, the replies and which tools ran. */
  private replay(s: Session) {
    const msgs = s.messages.slice(-40)
    if (s.messages.length > 40) this.notice(`… ${s.messages.length - 40} earlier messages`)
    for (const m of msgs) {
      if (m.role === 'user' && !m.synthetic) this.add({ kind: 'user', text: m.content })
      else if (m.role === 'assistant') {
        if (m.content.trim()) this.add({ kind: 'reply', text: m.content, first: true })
        for (const c of m.toolCalls ?? []) this.add({ kind: 'tool', name: c.name, subject: '', state: 'ok', result: { content: '' }, cwd: s.meta.cwd })
      }
    }
    this.notice('── resumed ──')
  }

  dispose() {
    if (this.state.running) this.agent.stop()
    this.agent.dispose()
  }
}

export const modeLabel = (m: PermissionMode) => ({ ask: 'Ask', acceptEdits: 'Auto-edit', plan: 'Plan', auto: 'Full auto' })[m]

export function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function readHistory(file: string): string[] {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveHistory(file: string, history: string[]) {
  try {
    fs.writeFileSync(file, JSON.stringify(history.slice(-500)))
  } catch {
    /* history is a convenience */
  }
}
