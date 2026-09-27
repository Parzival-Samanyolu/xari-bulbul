import { useCallback, useEffect, useReducer, useState } from 'react'
import type { AgentEvent, AppState, PermissionAnswer, PermissionRequest, UpdateStatus } from '../../shared/ipc'
import { api } from './lib/api'
import { Chat } from './components/Chat'
import { Composer } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { SettingsView } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
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
}

/** Point notices at the settings tab that resolves them. */
function fixFor(text: string): Notice['fix'] {
  if (/api key|providers & keys|unauthori[sz]ed|\b401\b|turned off/i.test(text)) return 'providers'
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

function addNotice(l: LiveState, level: Notice['level'], text: string): LiveState {
  const notice: Notice = { id: ++noticeId, level, text, fix: fixFor(text) }
  return { ...l, notices: [...l.notices, notice].slice(-5) }
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
      return setLive({ ...live, streamText: '', streamReasoning: '', notices: live.notices.filter((n) => n.level !== 'error') }, running(true))
    case 'text':
      return setLive({ ...live, streamText: live.streamText + e.delta })
    case 'reasoning':
      return setLive({ ...live, streamReasoning: live.streamReasoning + e.delta })
    case 'stream_reset':
      return setLive({ ...live, streamText: '', streamReasoning: '' })
    case 'message': {
      const clear = e.message.role === 'assistant' ? { streamText: '', streamReasoning: '' } : {}
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
    case 'error':
      return setLive(addNotice(live, 'error', e.message))
    case 'turn_end':
      return setLive({ ...live, streamText: '', streamReasoning: '' }, running(false))
  }
  return m
}

interface PendingApproval {
  sessionId: string
  request: PermissionRequest
}

export function App() {
  const [{ app, lives }, dispatch] = useReducer(reducer, { app: null, lives: {} })
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [settingsTab, setSettingsTab] = useState<string>('providers')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })

  const setState = useCallback((state: AppState | null | undefined) => state && dispatch({ type: 'state', state }), [])
  const fail = useCallback((e: unknown) => dispatch({ type: 'notice', level: 'error', text: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }), [])

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
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [appearance, app?.platform])

  const live = lives[activeId(app)] ?? emptyLive
  // Each chat's approvals stay with that chat; only the one on screen can be answered.
  const approval = pending.find((p) => p.sessionId === activeId(app))?.request
  const answer = (a: PermissionAnswer) => {
    if (!approval) return
    const sessionId = activeId(app)
    setPending((p) => p.filter((r) => !(r.sessionId === sessionId && r.request.callId === approval.callId)))
    api.agent.respond(sessionId, approval.callId, a)
  }

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPickerOpen((o) => !o)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setView((v) => (v === 'settings' ? 'chat' : 'settings'))
      } else if (mod && e.key.toLowerCase() === 'n' && app?.workspace) {
        e.preventDefault()
        api.sessions.create().then(setState, fail)
      } else if (mod && /^[1-9]$/.test(e.key) && app?.sessions[Number(e.key) - 1]) {
        // ⌘/Ctrl+1–9 jumps to the nth chat in the sidebar.
        e.preventDefault()
        const target = app.sessions[Number(e.key) - 1]
        if (target.id !== app.session?.meta.id) {
          setView('chat')
          api.sessions.open(target.id).then(setState, fail)
        }
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
  }, [app?.workspace, app?.running, app?.sessions, app?.session?.meta.id, approval, pickerOpen, setState, fail])

  if (!app) return <div className="boot">Loading…</div>

  const openSettings = (tab = 'providers') => {
    setSettingsTab(tab)
    setView('settings')
  }
  const anyReady = Object.values(app.ready).some(Boolean)

  return (
    <div className="app">
      <Sidebar app={app} onState={setState} onError={fail} onSettings={() => openSettings()} settingsOpen={view === 'settings'} onChat={() => setView('chat')} />
      <main className="main">
        {view === 'settings' ? (
          <SettingsView app={app} tab={settingsTab} onTab={setSettingsTab} onState={setState} onError={fail} onClose={() => setView('chat')} update={update} />
        ) : !app.workspace || !anyReady ? (
          <Welcome app={app} onState={setState} onError={fail} onSettings={openSettings} />
        ) : (
          <>
            <Chat
              app={app}
              live={live}
              onDismiss={(id) => dispatch({ type: 'dismiss', id })}
              onSettings={openSettings}
              approval={approval ? { request: approval, onAnswer: answer } : undefined}
            />
            <Composer app={app} onState={setState} onError={fail} onOpenPicker={() => setPickerOpen(true)} />
          </>
        )}
        <StatusBar app={app} live={live} onOpenPicker={() => setPickerOpen(true)} onUsage={() => openSettings('usage')} update={update} />
      </main>
      {pickerOpen && <ModelPicker app={app} onClose={() => setPickerOpen(false)} onState={setState} onError={fail} />}
    </div>
  )
}
