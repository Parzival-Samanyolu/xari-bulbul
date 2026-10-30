import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AgentEvent, AppState, MemoryFact, PermissionAnswer, PermissionRequest, UpdateStatus } from '../../shared/ipc'
import { api } from './lib/api'
import { Chat } from './components/Chat'
import { Composer } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { Resizer, RightPanel } from './components/Panels'
import { SettingsOverlay } from './components/settings/SettingsOverlay'
import { resolvePage } from './components/settings/tree'
import { isMac, matchesShortcut } from './lib/shortcuts'
import { useSpeech } from './lib/speech'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TerminalPanel } from './components/Terminal'
import { Onboarding } from './components/Onboarding'
import { Welcome } from './components/Welcome'

export interface ToolLive {
  name: string
  subject: string
  input: unknown
  progress: string
  done: boolean
  isError?: boolean
  denied?: boolean
  durationMs?: number
}

export interface Notice {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
  /** A settings tab that fixes the problem, shown as a button. */
  fix?: 'providers' | 'usage' | 'agent'
  /** The turn failed; offer to run the request again. */
  retry?: boolean
  /** The turn hit the step limit; offer to let the agent keep going. */
  resume?: boolean
  /** What the memory review changed after a turn; offer to undo it. */
  memory?: { sessionId: string; added: MemoryFact[]; removed: MemoryFact[] }
}

/** Point notices at the settings tab that resolves them. */
function fixFor(text: string): Notice['fix'] {
  if (/api key|providers ›|unauthori[sz]ed|\b401\b|turned off/i.test(text)) return 'providers'
  if (/budget/i.test(text)) return 'usage'
  if (/max steps/i.test(text)) return 'agent'
  return undefined
}

export interface LiveState {
  streamText: string
  streamReasoning: string
  tools: Record<string, ToolLive>
  notices: Notice[]
  context?: { tokens: number; length: number }
  /** What the chat is doing while nothing streams (Mixture of Agents asking its models). */
  status?: string
  lastUsage?: { prompt: number; completion: number; cost: number | null }
}

const emptyLive: LiveState = { streamText: '', streamReasoning: '', tools: {}, notices: [] }

type Action =
  | { type: 'state'; state: AppState }
  | { type: 'agent'; sessionId: string; event: AgentEvent }
  | { type: 'dismiss'; id: number }
  | { type: 'notice'; level: Notice['level']; text: string; sessionId?: string }

interface Model {
  app: AppState | null
  /** Streaming state per chat, so background chats keep theirs while you look elsewhere. */
  lives: Record<string, LiveState>
}

let noticeId = 0

const NO_SESSION = ''
const activeId = (app: AppState | null) => app?.session?.meta.id ?? NO_SESSION

function withLive(m: Model, id: string, fn: (l: LiveState) => LiveState): Model {
  return { ...m, lives: { ...m.lives, [id]: fn(m.lives[id] ?? emptyLive) } }
}

function addNotice(l: LiveState, level: Notice['level'], text: string, retry?: boolean): LiveState {
  const notice: Notice = { id: ++noticeId, level, text, fix: fixFor(text), ...(retry && { retry }) }
  return { ...l, notices: [...l.notices, notice].slice(-5) }
}

function memoryText(added: MemoryFact[], removed: MemoryFact[]): string {
  const list = (facts: MemoryFact[]) => facts.map((f) => f.fact).join('; ')
  const parts = []
  if (added.length) parts.push(`Saved to memory: ${list(added)}`)
  if (removed.length) parts.push(`Removed from memory: ${list(removed)}`)
  return parts.join('. ')
}

function reducer(m: Model, a: Action): Model {
  if (a.type === 'state') return { ...m, app: a.state }
  if (a.type === 'dismiss') {
    const lives: Record<string, LiveState> = {}
    for (const [k, l] of Object.entries(m.lives)) lives[k] = { ...l, notices: l.notices.filter((n) => n.id !== a.id) }
    return { ...m, lives }
  }
  if (a.type === 'notice') return withLive(m, a.sessionId ?? activeId(m.app), (l) => addNotice(l, a.level, a.text))
  const app = m.app
  if (!app) return m
  const e = a.event
  const id = a.sessionId
  // Only the chat on screen has its messages in `app.session`; others resync from main when opened.
  const shown = id === activeId(app)
  const live = m.lives[id] ?? emptyLive
  const setLive = (l: LiveState, next: AppState = app): Model => ({ app: next, lives: { ...m.lives, [id]: l } })
  const running = (on: boolean): AppState => ({
    ...app,
    running: shown ? on : app.running,
    runningSessions: on ? [...new Set([...app.runningSessions, id])] : app.runningSessions.filter((s) => s !== id),
  })
  switch (e.type) {
    case 'turn_start':
      return setLive({ ...live, streamText: '', streamReasoning: '', status: undefined, notices: live.notices.filter((n) => n.level !== 'error') }, running(true))
    case 'text':
      return setLive({ ...live, streamText: live.streamText + e.delta })
    case 'reasoning':
      return setLive({ ...live, streamReasoning: live.streamReasoning + e.delta })
    case 'stream_reset':
      return setLive({ ...live, streamText: '', streamReasoning: '' })
    case 'message': {
      const clear = e.message.role === 'assistant' ? { streamText: '', streamReasoning: '', status: undefined } : {}
      if (!shown || !app.session) return setLive({ ...live, ...clear })
      const messages = app.session.messages.slice(0, e.index)
      messages[e.index] = e.message
      return setLive({ ...live, ...clear }, { ...app, session: { ...app.session, messages } })
    }
    case 'tool_start':
      return setLive({ ...live, tools: { ...live.tools, [e.callId]: { name: e.name, subject: e.subject, input: e.input, progress: '', done: false } } })
    case 'tool_progress': {
      const t = live.tools[e.callId]
      if (!t) return m
      return setLive({ ...live, tools: { ...live.tools, [e.callId]: { ...t, progress: (t.progress + e.text).slice(-20_000) } } })
    }
    case 'tool_end': {
      const t = live.tools[e.callId] ?? { name: e.name, subject: '', input: null, progress: '', done: false }
      const session = shown && app.session && e.result.display
        ? { ...app.session, displays: { ...app.session.displays, [e.callId]: e.result.display } }
        : app.session
      return setLive(
        { ...live, tools: { ...live.tools, [e.callId]: { ...t, done: true, isError: e.result.isError, denied: e.denied, durationMs: e.durationMs } } },
        { ...app, session },
      )
    }
    case 'usage':
      return setLive(
        {
          ...live,
          context: { tokens: e.contextTokens, length: e.contextLength },
          lastUsage: { prompt: e.record.promptTokens, completion: e.record.completionTokens, cost: e.record.cost },
        },
        // The summary's "this chat" figures belong to the chat that made the request.
        shown ? { ...app, usage: e.summary } : { ...app, usage: { ...e.summary, session: app.usage.session } },
      )
    case 'todos':
      return shown && app.session ? { ...m, app: { ...app, session: { ...app.session, todos: e.todos } } } : m
    case 'compacted':
      return setLive(addNotice(live, 'info', `Summarized ${e.removedMessages} older messages to free up context.`))
    case 'notice':
      return setLive(addNotice(live, e.level, e.text))
    case 'fallback':
      return setLive(addNotice(live, 'info', e.text))
    case 'mixing':
      return setLive({ ...live, status: e.phase === 'proposing' ? `Asking ${e.models.length} models…` : 'Combining their answers…' })
    case 'memory': {
      const notice: Notice = { id: ++noticeId, level: 'info', text: memoryText(e.added, e.removed), memory: { sessionId: id, added: e.added, removed: e.removed } }
      return setLive({ ...live, notices: [...live.notices, notice].slice(-5) })
    }
    case 'error':
      return setLive(addNotice(live, 'error', e.message, true))
    case 'turn_end': {
      let notices = live.notices
      // The step-limit notice comes right before turn_end: give it a Continue button.
      if (e.reason === 'max_steps' && notices.length) notices = [...notices.slice(0, -1), { ...notices.at(-1)!, resume: true }]
      return setLive({ ...live, notices, streamText: '', streamReasoning: '', status: undefined }, running(false))
    }
  }
  return m
}

type Panels = AppState['settings']['app']['panels']

interface PendingApproval {
  sessionId: string
  request: PermissionRequest
}

export function App() {
  const [{ app, lives }, dispatch] = useReducer(reducer, { app: null, lives: {} })
  const [pending, setPending] = useState<PendingApproval[]>([])
  /** The open settings page, or null while Settings is closed. */
  const [settingsPage, setSettingsPage] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  // Right (files, changes) and bottom (terminal) panels. Elite restores them open; Basic starts with them closed.
  const [panels, setPanels] = useState<Panels | null>(null)
  const [bottomUsed, setBottomUsed] = useState(false)
  const latest = useRef<AppState | null>(null)
  latest.current = app
  const layout = app?.settings.appearance.layout
  const layoutChosen = app?.settings.app.layoutChosen
  useEffect(() => {
    const s = latest.current?.settings
    if (!s) return
    const elite = s.appearance.layout === 'elite'
    setPanels((p) => {
      // First load: Basic opens nothing. Later layout changes (picker, Settings) open or close both.
      const saved = s.app.panels
      return { ...saved, rightOpen: elite && saved.rightOpen, bottomOpen: elite && saved.bottomOpen, ...(p && { right: p.right, bottom: p.bottom }) }
    })
  }, [layout, layoutChosen, app === null])
  useEffect(() => {
    if (panels?.bottomOpen) setBottomUsed(true)
  }, [panels?.bottomOpen])

  const setState = useCallback((state: AppState | null | undefined) => state && dispatch({ type: 'state', state }), [])
  const fail = useCallback((e: unknown) => dispatch({ type: 'notice', level: 'error', text: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }), [])

  // Read aloud: the speaker button on replies, automatic reading, and stopping on input.
  useSpeech(app, (level, text) => dispatch({ type: 'notice', level, text }))

  useEffect(() => {
    api.getState().then(setState)
    return api.onEvent((e) => {
      if (e.type === 'state') setState(e.state)
      else if (e.type === 'agent') dispatch({ type: 'agent', sessionId: e.sessionId, event: e.event })
      else if (e.type === 'permission') setPending((p) => [...p, { sessionId: e.sessionId, request: e.request }])
      else if (e.type === 'permission_cancelled') setPending((p) => p.filter((r) => !(r.sessionId === e.sessionId && r.request.callId === e.callId)))
      else if (e.type === 'update') setUpdate(e.status)
    })
  }, [setState])

  // Appearance settings → CSS.
  const appearance = app?.settings.appearance
  useEffect(() => {
    if (!appearance) return
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => (root.dataset.theme = appearance.theme === 'system' ? (media.matches ? 'dark' : 'light') : appearance.theme)
    apply()
    root.dataset.density = appearance.density
    root.dataset.platform = app?.platform
    root.style.setProperty('--font-size', `${appearance.fontSize}px`)
    root.style.setProperty('--mono', appearance.codeFontFamily)
    if (appearance.fontFamily) root.style.setProperty('--sans', appearance.fontFamily)
    else root.style.removeProperty('--sans')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [appearance, app?.platform])

  const live = lives[activeId(app)] ?? emptyLive
  // Each chat's approvals stay with that chat; only the one on screen can be answered.
  const approval = pending.find((p) => p.sessionId === activeId(app))?.request
  const question = app?.questions.find((q) => q.sessionId === activeId(app))?.request
  const answerQuestion = (text: string) => {
    if (question) api.agent.answer(activeId(app), question.callId, text).then(setState, fail)
  }
  // Stable, so memoized chat rows don't re-render on every streamed token.
  const onRetry = useCallback(() => void api.agent.retry().catch(fail), [fail])
  const onContinue = useCallback(() => void api.agent.send('continue').catch(fail), [fail])
  const onRevert = useCallback((at: number, file?: string) => void api.agent.revert(at, file).then(setState, fail), [setState, fail])
  const onUndoMemory = useCallback((m: NonNullable<Notice['memory']>) => void api.memory.undo(m.sessionId, m.added, m.removed).then(setState, fail), [setState, fail])
  const onEdit = useCallback((index: number, text: string, revert: boolean) => void api.agent.editMessage(index, text, revert).catch(fail), [fail])
  /** Changes the panels on screen and saves them. */
  const savePanels = useCallback(
    (patch: Partial<Panels>) => {
      setPanels((p) => (p ? { ...p, ...patch } : p))
      const cur = latest.current?.settings
      if (cur) api.settings.set({ ...cur, app: { ...cur.app, panels: { ...cur.app.panels, ...patch } } }).then(setState, fail)
    },
    [setState, fail],
  )
  const toggleBottom = useCallback(() => panels && savePanels({ bottomOpen: !panels.bottomOpen }), [panels, savePanels])
  const toggleRight = useCallback(() => panels && savePanels({ rightOpen: !panels.rightOpen }), [panels, savePanels])

  const answer = (a: PermissionAnswer) => {
    if (!approval) return
    const sessionId = activeId(app)
    setPending((p) => p.filter((r) => !(r.sessionId === sessionId && r.request.callId === approval.callId)))
    api.agent.respond(sessionId, approval.callId, a)
  }

  // Global shortcuts (rebindable ones come from Settings › Keyboard shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!app) return
      const settings = app.settings
      const mac = isMac(app.platform)
      const is = (id: Parameters<typeof matchesShortcut>[2]) => matchesShortcut(e, settings, id, mac)
      const mod = mac ? e.metaKey : e.ctrlKey
      if (is('settings')) {
        e.preventDefault()
        setSettingsPage((p) => (p ? null : resolvePage(undefined)))
      } else if (settingsPage) {
        // Settings is open and handles its own keys.
        return
      } else if (is('terminal') && app.workspace) {
        e.preventDefault()
        toggleBottom()
      } else if (is('filesPanel') && app.workspace) {
        e.preventDefault()
        toggleRight()
      } else if (is('modelPicker')) {
        e.preventDefault()
        setPickerOpen((o) => !o)
      } else if (is('newChat') && app.workspace) {
        e.preventDefault()
        api.sessions.create().then(setState, fail)
      } else if (mod && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code) && app.sessions[Number(e.code.slice(5)) - 1]) {
        // ⌘/Ctrl+1–9 jumps to the nth chat in the sidebar.
        e.preventDefault()
        const target = app.sessions[Number(e.code.slice(5)) - 1]
        if (target.id !== app.session?.meta.id) api.sessions.open(target.id).then(setState, fail)
      } else if (e.key === 'Escape' && approval && !pickerOpen) {
        // Esc denies this chat's pending approval.
        e.preventDefault()
        answer({ type: 'deny' })
      } else if (e.key === 'Escape' && app?.running && !pickerOpen) {
        // Stops only the chat on screen.
        api.agent.stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app?.settings, app?.platform, app?.workspace, app?.running, app?.sessions, app?.session?.meta.id, approval, pickerOpen, settingsPage, setState, fail, toggleBottom, toggleRight])

  // Share info counts which Settings pages get opened (page ids only).
  useEffect(() => {
    if (settingsPage) void api.app.track({ type: 'settings_page', page: settingsPage }).catch(() => {})
  }, [settingsPage])

  if (!app) return <div className="boot">Loading…</div>
  // First run: full-window setup until it's finished or skipped.
  if (!app.settings.app.onboarded) return <Onboarding app={app} onState={setState} onError={fail} />

  /** Opens Settings at a page id, or an older tab id ('providers', 'usage', …). */
  const openSettings = (tab?: string) => setSettingsPage(resolvePage(tab, app.settings))
  const anyReady = Object.values(app.ready).some(Boolean)
  const welcome = !app.workspace || !anyReady
  const showRight = !!app.workspace && !!panels?.rightOpen
  const showBottom = !!app.workspace && !!panels?.bottomOpen

  return (
    <div className="app">
      <Sidebar app={app} onState={setState} onError={fail} onSettings={() => openSettings()} settingsOpen={!!settingsPage} onChat={() => setSettingsPage(null)} />
      <main className="main">
        {welcome ? (
          <Welcome app={app} onState={setState} onError={fail} onSettings={openSettings} />
        ) : (
          <>
            <Chat
              app={app}
              live={live}
              onDismiss={(id) => dispatch({ type: 'dismiss', id })}
              onSettings={openSettings}
              approval={approval ? { request: approval, onAnswer: answer } : undefined}
              question={question ? { request: question, onAnswer: answerQuestion } : undefined}
              onRetry={onRetry}
              onContinue={onContinue}
              onRevert={onRevert}
              onEdit={onEdit}
              onUndoMemory={onUndoMemory}
              onState={setState}
              onError={fail}
            />
            <Composer app={app} onState={setState} onError={fail} onOpenPicker={() => setPickerOpen(true)} />
          </>
        )}
      </main>
      {showRight && panels && (
        <aside className="side-right" style={{ width: panels.right }} aria-label="Files and changes">
          <Resizer axis="x" label="Resize files and changes panel" value={panels.right} min={220} max={Math.max(220, Math.min(1200, window.innerWidth - 570))} onChange={(right) => setPanels({ ...panels, right })} onCommit={(right) => savePanels({ right })} />
          <RightPanel app={app} onState={setState} onError={fail} />
        </aside>
      )}
      {/* Stays mounted once used, so terminals keep running while the panel is closed. */}
      {bottomUsed && panels && (
        <section className="side-bottom" hidden={!showBottom} style={{ height: panels.bottom }} aria-label="Terminal">
          <Resizer axis="y" label="Resize terminal panel" value={panels.bottom} min={120} max={Math.max(120, Math.min(1000, window.innerHeight - 220))} onChange={(bottom) => setPanels({ ...panels, bottom })} onCommit={(bottom) => savePanels({ bottom })} />
          <TerminalPanel app={app} visible={showBottom} onError={fail} />
        </section>
      )}
      <StatusBar
        app={app}
        live={live}
        onOpenPicker={() => setPickerOpen(true)}
        onUsage={() => openSettings('usage')}
        update={update}
        panels={app.workspace && panels ? { bottom: showBottom, right: showRight, onBottom: toggleBottom, onRight: toggleRight } : undefined}
      />
      {pickerOpen && <ModelPicker app={app} onClose={() => setPickerOpen(false)} onState={setState} onError={fail} />}
      {settingsPage && <SettingsOverlay app={app} page={settingsPage} onPage={setSettingsPage} onState={setState} onClose={() => setSettingsPage(null)} update={update} />}
    </div>
  )
}
