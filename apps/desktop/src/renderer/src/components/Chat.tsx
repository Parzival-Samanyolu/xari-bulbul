import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppState, ChatMessage, PermissionAnswer, PermissionRequest, ToolDisplay } from '../../../shared/ipc'
import type { LiveState, ToolLive } from '../App'
import { Markdown } from '../lib/Markdown'
import { Approval } from './Approval'

type ToolCallT = NonNullable<Extract<ChatMessage, { role: 'assistant' }>['toolCalls']>[number]

interface Props {
  app: AppState
  live: LiveState
  onDismiss: (id: number) => void
  onSettings: (tab: string) => void
  approval?: { request: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }
}

const FIX_LABEL = { providers: 'Open Providers & Keys', usage: 'Open Usage & Budgets', agent: 'Open Agent settings' } as const

export function Chat({ app, live, onDismiss, onSettings, approval }: Props) {
  const session = app.session
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const appearance = app.settings.appearance

  const onScroll = () => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    stick.current = true
  }, [session?.meta.id])

  if (!session) return <div className="chat" />

  const results = new Map<string, Extract<ChatMessage, { role: 'tool' }>>()
  for (const m of session.messages) if (m.role === 'tool') results.set(m.toolCallId, m)
  const denied = new Set(session.denied)
  const empty = session.messages.length === 0 && !app.running
  // Announced to screen readers; streamed text itself is not announced token by token.
  const status = approval
    ? `Approval needed: ${approval.request.tool} ${approval.request.subject}`
    : app.running
      ? 'Working'
      : ''

  return (
    <div className="chat" ref={scroller} onScroll={onScroll}>
      <div className="sr-only" aria-live="polite">
        {status}
      </div>
      <div className="chat-inner">
        {empty && <EmptyChat app={app} />}
        {session.messages.map((m, i) => {
          if (m.role === 'user') return <UserBubble key={i} message={m} />
          if (m.role === 'assistant')
            return (
              <div key={i} className="assistant">
                {m.reasoning && appearance.showReasoning && <Reasoning text={m.reasoning} />}
                {m.content && <Markdown text={m.content} />}
                {m.toolCalls?.map((c) => (
                  <ToolCard
                    key={c.id}
                    call={c}
                    live={live.tools[c.id]}
                    result={results.get(c.id)}
                    display={session.displays[c.id]}
                    denied={denied.has(c.id) || live.tools[c.id]?.denied}
                    expandDefault={appearance.expandToolCalls}
                    approval={approval && owns(c.id, approval.request) ? approval : undefined}
                  />
                ))}
              </div>
            )
          return null
        })}
        {approval && !session.messages.some((m) => m.role === 'assistant' && m.toolCalls?.some((c) => owns(c.id, approval.request))) && (
          // Fallback: the tool card isn't rendered yet, so show the approval on its own.
          <div className={`tool tool-awaiting`}>
            <div className="tool-head static">
              <span className="tool-name">{approval.request.tool}</span>
              <span className="tool-subject">{approval.request.subject}</span>
              <span className="tool-state">needs approval</span>
            </div>
            <Approval key={approval.request.callId} request={approval.request} onAnswer={approval.onAnswer} />
          </div>
        )}
        {app.running && !approval && (
          <div className="assistant live">
            {live.streamReasoning && appearance.showReasoning && <Reasoning text={live.streamReasoning} open />}
            {live.streamText ? <Markdown text={live.streamText} /> : <Thinking tools={live.tools} />}
          </div>
        )}
        {session.todos.length > 0 && <Todos todos={session.todos} />}
        {live.notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
            <span>{n.text}</span>
            {n.fix && (
              <button className="btn" onClick={() => onSettings(n.fix!)}>
                {FIX_LABEL[n.fix]}
              </button>
            )}
            <button className="notice-close" aria-label="Dismiss" onClick={() => onDismiss(n.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyChat({ app }: { app: AppState }) {
  const cmds = app.extensions.commands.filter((c) => c.source !== 'builtin')
  return (
    <div className="empty">
      <h2>What should we build?</h2>
      <p className="muted">
        Xarı Bülbül can read, search, edit and run code in <code>{app.workspace}</code>. It asks before changing anything unless you pick a different
        permission mode below.
      </p>
      <ul className="tips">
        <li>
          <kbd>{app.platform === 'darwin' ? '⌘K' : 'Ctrl+K'}</kbd> switch model · <kbd>/</kbd> commands · <kbd>Esc</kbd> stop
        </li>
        <li>
          Add an <code>AGENTS.md</code> to the project to give Xarı Bülbül standing instructions.
        </li>
        {cmds.length > 0 && <li>Your commands: {cmds.map((c) => `/${c.name}`).join(', ')}</li>}
      </ul>
    </div>
  )
}

function UserBubble({ message }: { message: Extract<ChatMessage, { role: 'user' }> }) {
  const text = message.content
  const summary = text.startsWith('[Summary of the earlier conversation]')
  if (summary) return <div className="user summary"><details><summary>Earlier conversation (summarized)</summary><Markdown text={text} /></details></div>
  if (message.synthetic === 'review')
    return (
      <div className="user summary review">
        <details>
          <summary>Checked for unfinished steps before finishing</summary>
          <Markdown text={text.replace(/^\[Automatic check before you finish\]\s*/, '')} />
        </details>
      </div>
    )
  const files = message.files ?? []
  const images = message.images ?? []
  return (
    <div className="user-turn">
      {(files.length > 0 || images.length > 0) && (
        <div className="user-attachments">
          {images.map((img, i) => (
            <img key={`i${i}`} className="user-image" src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} title={img.name} />
          ))}
          {files.map((f, i) => (
            <span key={`f${i}`} className="attachment" title={f.path ?? f.name}>
              <span className="attachment-icon" aria-hidden>≡</span>
              <span className="attachment-name">{f.name}</span>
              <span className="muted small">{f.text.split('\n').length} lines</span>
            </span>
          ))}
        </div>
      )}
      {text && <div className="user">{text}</div>}
    </div>
  )
}

function Reasoning({ text, open }: { text: string; open?: boolean }) {
  return (
    <details className="reasoning" open={open}>
      <summary>Thinking</summary>
      <div className="reasoning-body">{text}</div>
    </details>
  )
}

/** A tool card owns its own approval and those of any subagent it started ("<callId>/<subCallId>"). */
function owns(callId: string, request: PermissionRequest): boolean {
  return request.callId === callId || request.callId.startsWith(`${callId}/`)
}

function Thinking({ tools }: { tools: Record<string, ToolLive> }) {
  const running = Object.values(tools).find((t) => !t.done)
  return (
    <div className="thinking">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
      {running ? (running.name === 'task' ? 'Subagent working…' : `Running ${running.name}…`) : 'Working…'}
    </div>
  )
}

function ToolCard(props: {
  call: ToolCallT
  live?: ToolLive
  result?: Extract<ChatMessage, { role: 'tool' }>
  display?: ToolDisplay
  denied?: boolean
  expandDefault: boolean
  approval?: { request: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }
}) {
  const { call, live, result, display, denied, approval } = props
  // null = follow the default (diffs open automatically once they arrive); a click overrides it.
  const [toggled, setToggled] = useState<boolean | null>(null)
  let input: Record<string, unknown> = {}
  try {
    input = JSON.parse(call.arguments || '{}')
  } catch {
    /* shown raw */
  }
  const subject = live?.subject || String(input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? '')
  const task = call.name === 'task'
  const pending = !result
  const isError = result?.content.startsWith('Error:') || live?.isError
  const state = approval ? 'awaiting' : denied ? 'denied' : pending ? 'running' : isError ? 'error' : 'ok'
  const diff = display?.kind === 'diff' ? display : null
  const open = toggled ?? (props.expandDefault || !!diff)

  if (call.name === 'todo_write') return null

  return (
    <div className={`tool tool-${state}`}>
      <button className="tool-head" aria-expanded={open} onClick={() => setToggled(!open)}>
        <span className="tool-name">{task ? (input.type === 'general' ? 'subagent' : 'subagent · read-only') : call.name}</span>
        <span className="tool-subject">{subject}</span>
        {diff && (
          <span className="diffstat">
            <span className="add">+{diff.added}</span> <span className="del">−{diff.removed}</span>
          </span>
        )}
        <span className="tool-state">
          {state === 'awaiting' ? 'needs approval' : state === 'running' ? <span className="spinner" aria-label="Running" /> : state === 'denied' ? 'denied' : state === 'error' ? 'failed' : live?.durationMs != null ? `${(live.durationMs / 1000).toFixed(1)}s` : ''}
        </span>
      </button>
      {approval && <Approval key={approval.request.callId} request={approval.request} onAnswer={approval.onAnswer} />}
      {open && !approval && (
        <div className="tool-body">
          {diff ? (
            <DiffView patch={diff.patch} />
          ) : task ? (
            <>
              <div className="tool-prompt">{String(input.prompt ?? '')}</div>
              {live?.progress ? <pre className="tool-output">{live.progress}</pre> : null}
              {result && (
                <div className="tool-report">
                  <Markdown text={result.content} />
                </div>
              )}
            </>
          ) : (
            <>
              {call.name !== 'bash' && Object.keys(input).length > 0 && <pre className="tool-input">{JSON.stringify(input, null, 2)}</pre>}
              {pending && live?.progress ? <pre className="tool-output">{live.progress}</pre> : null}
              {result && <pre className="tool-output">{result.content}</pre>}
            </>
          )}
        </div>
      )}
      {!open && !approval && pending && live?.progress && <pre className="tool-output tail">{live.progress.split('\n').slice(-4).join('\n')}</pre>}
    </div>
  )
}

export function DiffView({ patch }: { patch: string }) {
  // Drop the ===/---/+++ header and the trailing newline's empty line.
  const lines = patch.split('\n').slice(4).filter((l, i, all) => l !== '' || i < all.length - 1)
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : 'd-ctx'}>
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

function Todos({ todos }: { todos: { content: string; status: string }[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="todos-head">
        Tasks <span className="muted">{done}/{todos.length}</span>
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`todo todo-${t.status}`}>
          <span className="todo-box">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : ''}</span>
          {t.content}
        </div>
      ))}
    </div>
  )
}
