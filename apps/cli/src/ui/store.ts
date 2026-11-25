// The chat's state, apart from how it's drawn: the agent, its events, approvals, questions,
// commands and the transcript. The Ink components read `state` and call the methods.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Agent, AgentEvent, PermissionAnswer, PermissionMode, PermissionRequest, QuestionRequest, Session, ToolResult, TodoItem } from '@harness/core'
import type { Host } from '../host.js'
import { tEn, type MessageKey, type T } from '../i18n/index.js'
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

/** /help's command list; the commands stay as typed, their descriptions follow the interface language. */
export const builtinHelp = (t: T = tEn): [string, string][] => [
  ['/help', t('help.cmd.help')],
  ['/new', t('help.cmd.new')],
  ['/resume', t('help.cmd.resume')],
  ['/model [name]', t('help.cmd.model')],
  ['/mode [mode]', t('help.cmd.mode')],
  ['/compact', t('help.cmd.compact')],
  ['/undo', t('help.cmd.undo')],
  ['/cost', t('help.cmd.cost')],
  ['/exit', t('help.cmd.exit')],
]

export const keyHelp = (t: T = tEn): [string, string][] => [
  ['enter', t('help.key.enter')],
  ['esc', t('help.key.esc')],
  ['shift+tab', t('help.key.shiftTab', { modes: MODE_ORDER.map((m) => modeLabel(m, t)).join(' → ') })],
  ['↑ ↓', t('help.key.arrows')],
  ['tab', t('help.key.tab')],
  ['ctrl+c', t('help.key.ctrlC')],
]

const BUILTIN = new Set(['help', 'new', 'clear', 'resume', 'model', 'mode', 'compact', 'undo', 'cost', 'exit', 'quit'])

export class ChatStore extends EventEmitter {
  state: ChatState
  /** Messages in the interface language. */
  readonly t: T
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
    this.t = host.t
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
        return this.notice(this.t('notice.compacted', { count: e.removedMessages }))
      case 'notice':
        return this.notice(e.text, e.level === 'warn' ? 'warn' : 'info')
      case 'fallback':
        return this.notice(e.text, 'warn')
      case 'error':
        this.flushReply()
        return this.notice(e.message, 'error')
      case 'memory':
        if (e.added.length) this.notice(this.t('notice.remembered', { facts: e.added.map((f) => f.fact).join('; ') }))
        return
      case 'turn_end': {
        this.flushReply()
        this.set({ running: false, thinking: '', tools: [] })
        const why: Record<string, MessageKey> = { aborted: 'notice.stopped', max_steps: 'notice.stoppedMaxSteps', budget: 'notice.stoppedBudget', repeating: 'notice.stoppedRepeating' }
        if (why[e.reason]) this.notice(this.t(why[e.reason]), 'warn')
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
    this.flash(this.t('notice.stopping'))
    return true
  }

  setMode(mode: PermissionMode) {
    this.host.setMode(this.agent, mode)
    this.set({ mode })
    this.flash(this.t('mode.flash', { mode: modeLabel(mode, this.t) }))
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
    const all = [...builtinHelp(this.t).map(([c, d]) => ({ name: c.split(/[ ,]/)[0].slice(1), description: d })), ...this.host.slashCommands().filter((c) => !BUILTIN.has(c.name))]
    return all.filter((c) => c.name.startsWith(prefix.toLowerCase()))
  }

  private async command(line: string): Promise<boolean> {
    const m = /^\/(\S+)\s*(.*)$/s.exec(line.trim())
    if (!m) return false
    const [, name, raw] = m
    const arg = raw.trim()
    switch (name) {
      case 'help':
        this.add({ kind: 'lines', title: this.t('help.commands'), rows: builtinHelp(this.t) })
        {
          const own = this.host.slashCommands().filter((c) => !BUILTIN.has(c.name))
          if (own.length) this.add({ kind: 'lines', title: this.t('help.ownCommands'), rows: own.map((c) => [`/${c.name}`, c.description]) })
        }
        this.add({ kind: 'lines', title: this.t('help.keys'), rows: keyHelp(this.t) })
        return true
      case 'exit':
      case 'quit':
        this.emit('quit')
        return true
      case 'new':
      case 'clear':
        if (this.state.running) this.agent.stop()
        this.attach(this.host.newSession(this.agent.model))
        this.notice(this.t('notice.newChat'))
        return true
      case 'mode': {
        if (!arg) return this.cycleMode(), true
        // The mode's id, or its name in English or in the interface language.
        const a = arg.toLocaleLowerCase()
        const want = MODE_ORDER.find((x) => [x, modeLabel(x), modeLabel(x, this.t)].some((n) => n.toLocaleLowerCase() === a))
        if (want) this.setMode(want)
        else this.notice(this.t('mode.list', { modes: MODE_ORDER.join(', ') }), 'warn')
        return true
      }
      case 'model': {
        if (arg) {
          try {
            this.agent.setModel(this.host.resolveModel(arg))
            this.set({ model: this.modelName() })
            this.notice(this.t('notice.model', { model: this.modelName() }))
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
          this.notice(this.t('notice.modelSwitch', { model: this.modelName() }))
          return true
        }
        this.set({
          overlay: {
            kind: 'picker',
            title: this.t('picker.model', { provider }),
            choices: models.slice(0, 300).map((x) => ({ label: x.id, hint: x.free ? this.t('picker.free') : x.contextLength ? `${Math.round(x.contextLength / 1000)}k` : undefined })),
            initial: Math.max(0, models.findIndex((x) => x.id === this.agent.model.modelId)),
            pick: (i) => {
              this.agent.setModel({ providerId: provider, modelId: models[i].id })
              this.set({ model: this.modelName() })
              this.notice(this.t('notice.model', { model: this.modelName() }))
            },
          },
        })
        return true
      }
      case 'resume': {
        const chats = this.host.listSessions(this.session.meta.cwd).filter((s) => s.id !== this.session.meta.id && !s.botId)
        if (!chats.length) {
          this.notice(this.t('notice.noEarlierChats'))
          return true
        }
        this.set({
          overlay: {
            kind: 'picker',
            title: this.t('picker.resume'),
            choices: chats.map((s) => ({ label: s.title, hint: ago(s.updatedAt, this.t) })),
            initial: 0,
            pick: (i) =>
              void this.host.loadSession(chats[i].id).then((s) => {
                if (!s) return this.notice(this.t('notice.chatGone'), 'error')
                this.attach(s)
                this.replay(s)
              }),
          },
        })
        return true
      }
      case 'compact':
        if (this.state.running) return this.notice(this.t('notice.waitForTurn'), 'warn'), true
        this.notice(this.t('notice.summarizing'))
        await this.agent.compact().then(
          (ok) => !ok && this.notice(this.t('notice.nothingToSummarize')),
          (err) => this.notice((err as Error).message, 'error'),
        )
        return true
      case 'undo': {
        const cp = this.agent.checkpoints.at(-1)
        if (!cp) return this.notice(this.t('notice.nothingToUndo')), true
        try {
          const restored = this.agent.revert(cp.at)
          this.notice(this.t('notice.putBack', { count: restored.length, files: restored.map((f) => path.relative(this.session.meta.cwd, f) || f).join(', ') }), 'ok')
        } catch (err) {
          this.notice((err as Error).message, 'error')
        }
        return true
      }
      case 'cost': {
        const s = this.host.usage.summary(this.session.meta.id)
        const t = this.t
        const row = (u: typeof s.session) =>
          [t('usage.requests', { count: u.requests }), t('usage.in', { tokens: fmtTokens(u.promptTokens) }), t('usage.out', { tokens: fmtTokens(u.completionTokens) }), `$${u.cost.toFixed(4)}${u.costPartial ? ` ${t('usage.pricesUnknown')}` : ''}`].join(' · ')
        this.add({ kind: 'lines', title: t('usage.title'), rows: [[t('usage.thisChat'), row(s.session)], [t('usage.today'), row(s.today)]] })
        return true
      }
      default:
        return false
    }
  }

  /** An earlier chat, shortened: your messages, the replies and which tools ran. */
  private replay(s: Session) {
    const msgs = s.messages.slice(-40)
    if (s.messages.length > 40) this.notice(this.t('notice.earlierMessages', { count: s.messages.length - 40 }))
    for (const m of msgs) {
      if (m.role === 'user' && !m.synthetic) this.add({ kind: 'user', text: m.content })
      else if (m.role === 'assistant') {
        if (m.content.trim()) this.add({ kind: 'reply', text: m.content, first: true })
        for (const c of m.toolCalls ?? []) this.add({ kind: 'tool', name: c.name, subject: '', state: 'ok', result: { content: '' }, cwd: s.meta.cwd })
      }
    }
    this.notice(this.t('notice.resumed'))
  }

  dispose() {
    if (this.state.running) this.agent.stop()
    this.agent.dispose()
  }
}

/** The mode's name as the desktop shows it: Ask, Auto-edit, Plan, Full auto. */
export const modeLabel = (m: PermissionMode, t: T = tEn) => t(`mode.${m}`)

export function ago(at: number, t: T = tEn): string {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return t('ago.now')
  if (s < 3600) return t('ago.minutes', { count: Math.round(s / 60) })
  if (s < 86400) return t('ago.hours', { count: Math.round(s / 3600) })
  return t('ago.days', { count: Math.round(s / 86400) })
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
