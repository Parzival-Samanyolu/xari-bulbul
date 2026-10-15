import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ChatMessage, Checkpoint, PermissionAnswer, PermissionRequest, QuestionRequest, ToolDisplay } from '../../../shared/ipc'
import type { LiveState, ToolLive } from '../App'
import { Markdown } from '../lib/Markdown'
import { Approval } from './Approval'
import { Question } from './Question'

type ToolCallT = NonNullable<Extract<ChatMessage, { role: 'assistant' }>['toolCalls']>[number]

interface Props {
  app: AppState
  live: LiveState
  onDismiss: (id: number) => void
  onSettings: (tab: string) => void
  approval?: { request: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }
  question?: { request: QuestionRequest; onAnswer: (text: string) => void }
  onRetry: () => void
  onRevert: (at: number, file?: string) => void
  onEdit: (index: number, text: string, revert: boolean) => void
}

type UserMessage = Extract<ChatMessage, { role: 'user' }>
type AssistantMessageT = Extract<ChatMessage, { role: 'assistant' }>
type ToolMessage = Extract<ChatMessage, { role: 'tool' }>

const FIX_LABEL = { providers: 'Open Providers & Keys', usage: 'Open Usage & Budgets', agent: 'Open Agent settings' } as const

export function Chat({ app, live, onDismiss, onSettings, approval, question, onRetry, onRevert, onEdit }: Props) {
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

  const messages = session?.messages
  // Rebuilt only when history changes, so memoized rows skip re-rendering while text streams in.
  // Keyed by the asking message's index too: providers reuse call ids ("call_0") across turns.
  const { results, lastCalls } = useMemo(() => {
    const map = new Map<string, ToolMessage>()
    let asker = -1
    ;(messages ?? []).forEach((m, i) => {
      if (m.role === 'assistant' && m.toolCalls?.length) asker = i
      else if (m.role === 'tool') map.set(`${asker}:${m.toolCallId}`, m)
    })
    return { results: map, lastCalls: asker }
  }, [messages])
  const denied = useMemo(() => new Set(session?.denied), [session?.denied])
  const turns = useMemo(() => turnLayout(messages ?? [], session?.checkpoints ?? []), [messages, session?.checkpoints])

  if (!session) return <div className="chat" />

  const empty = session.messages.length === 0 && !app.running
  // Announced to screen readers; streamed text itself is not announced token by token.
  const status = approval
    ? `Approval needed: ${approval.request.tool} ${approval.request.subject}`
    : question
      ? `Question: ${question.request.question}`
      : app.running
        ? 'Working'
        : ''
  // The turn in progress can't be reverted or edited until it ends.
  const lastTurn = turns.starts.at(-1) ?? -1
  const settled = (at: number) => !app.running || at !== lastTurn
  // Pending approvals and questions belong to the latest request's tool calls.
  const owned = (i: number, calls: AssistantMessageT['toolCalls']) =>
    i === lastCalls && calls?.some((c) => (approval && owns(c.id, approval.request)) || question?.request.callId === c.id)

  return (
    <div className="chat" ref={scroller} onScroll={onScroll}>
      <div className="sr-only" aria-live="polite">
        {status}
      </div>
      <div className="chat-inner">
        {empty && <EmptyChat app={app} />}
        {session.messages.map((m, i) => {
          const cp = turns.endsAt.get(i)
          const bar = cp && settled(cp.at) && <RevertBar key={`r${cp.at}`} checkpoint={cp} onRevert={onRevert} />
          if (m.role === 'user')
            return [
              <UserBubble
                key={i}
                index={i}
                message={m}
                laterChanges={!app.running && !m.synthetic ? turns.changedFrom(i) : 0}
                onEdit={app.running || m.synthetic ? undefined : onEdit}
              />,
              bar,
            ]
          if (m.role === 'assistant') {
            const cpOfTurn = turns.checkpointOf(i)
            return [
              <AssistantMessage
                key={i}
                message={m}
                index={i}
                tools={live.tools}
                results={results}
                displays={session.displays}
                denied={denied}
                showReasoning={appearance.showReasoning}
                expandDefault={appearance.expandToolCalls}
                // Only the row that owns the pending approval or question gets it (and re-renders for it).
                approval={owned(i, m.toolCalls) ? approval : undefined}
                question={owned(i, m.toolCalls) ? question : undefined}
                checkpoint={cpOfTurn && settled(cpOfTurn.at) ? cpOfTurn : undefined}
                onRevert={onRevert}
              />,
              bar,
            ]
          }
          return bar || null
        })}
        {approval && !owned(lastCalls, (session.messages[lastCalls] as AssistantMessageT | undefined)?.toolCalls) && (
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
        {app.running && !approval && !question && <LiveReply live={live} showReasoning={appearance.showReasoning} />}
        {session.todos.length > 0 && <Todos todos={session.todos} />}
        {live.notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
            <span>{n.text}</span>
            {n.retry && !app.running && (
              <button
                className="btn"
                onClick={() => {
                  onDismiss(n.id)
                  onRetry()
                }}
              >
                Retry
              </button>
            )}
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

/**
 * Where each turn starts, and where its "Revert" bar goes: after the last message of a turn that
 * changed files (before the next message you wrote).
 */
function turnLayout(messages: ChatMessage[], checkpoints: Checkpoint[]) {
  const starts = messages.flatMap((m, i) => (m.role === 'user' && !m.synthetic ? [i] : []))
  const byAt = new Map(checkpoints.filter((c) => Object.keys(c.files).length).map((c) => [c.at, c]))
  const endsAt = new Map<number, Checkpoint>()
  starts.forEach((at, k) => {
    const cp = byAt.get(at)
    if (cp) endsAt.set((starts[k + 1] ?? messages.length) - 1, cp)
  })
  return {
    starts,
    endsAt,
    /** The checkpoint of the turn that message `i` belongs to. */
    checkpointOf: (i: number) => byAt.get(starts.findLast((s) => s <= i) ?? -1),
    /** How many files turns from message `i` on changed (dropped if that message is edited). */
    changedFrom: (i: number) => new Set(checkpoints.filter((c) => c.at >= i).flatMap((c) => Object.keys(c.files))).size,
  }
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p

function RevertBar({ checkpoint, onRevert }: { checkpoint: Checkpoint; onRevert: (at: number) => void }) {
  const files = Object.keys(checkpoint.files)
  const label = files.length === 1 ? base(files[0]) : `${files.length} files`
  return (
    <div className="revert-bar">
      <span className="muted small">
        Changed {label}
      </span>
      <button
        className="link small"
        title={files.join('\n')}
        onClick={() => confirm(`Put ${label} back the way ${files.length === 1 ? 'it was' : 'they were'} before this turn? Changes made with shell commands aren't undone.`) && onRevert(checkpoint.at)}
      >
        Revert changes
      </button>
    </div>
  )
}

const UserBubble = memo(function UserBubble({
  message,
  index,
  laterChanges,
  onEdit,
}: {
  message: UserMessage
  index: number
  laterChanges: number
  onEdit?: (index: number, text: string, revert: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [undo, setUndo] = useState(true)
  const text = message.content
  // Reminders are notes for the model (mode switches, files changed on disk), not part of the chat.
  if (message.synthetic === 'reminder') return null
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
      {editing ? (
        <form
          className="user-edit"
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim()) return
            setEditing(false)
            onEdit?.(index, draft, laterChanges > 0 && undo)
          }}
        >
          <textarea
            autoFocus
            value={draft}
            aria-label="Edit message"
            rows={Math.min(12, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <div className="user-edit-actions">
            {laterChanges > 0 && (
              <label className="small">
                <input type="checkbox" checked={undo} onChange={(e) => setUndo(e.target.checked)} /> Also undo the file changes made after this message (
                {laterChanges} {laterChanges === 1 ? 'file' : 'files'})
              </label>
            )}
            <span className="muted small">Later messages are removed.</span>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!draft.trim()}>
              Send
            </button>
          </div>
        </form>
      ) : (
        text && (
          <div className="user-row">
            {onEdit && (
              <button
                className="link small user-edit-btn"
                onClick={() => {
                  setDraft(message.content)
                  setUndo(true)
                  setEditing(true)
                }}
              >
                Edit
              </button>
            )}
            <div className="user">{text}</div>
          </div>
        )
      )}
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage(props: {
  message: AssistantMessageT
  index: number
  tools: LiveState['tools']
  results: Map<string, ToolMessage>
  displays: Record<string, ToolDisplay>
  denied: Set<string>
  showReasoning: boolean
  expandDefault: boolean
  approval?: { request: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }
  question?: { request: QuestionRequest; onAnswer: (text: string) => void }
  checkpoint?: Checkpoint
  onRevert: (at: number, file?: string) => void
}) {
  const { message: m, tools, results, displays, denied, approval, question, checkpoint, onRevert } = props
  return (
    <div className="assistant">
      {m.reasoning && props.showReasoning && <Reasoning text={m.reasoning} />}
      {m.content && <Markdown text={m.content} />}
      {m.toolCalls?.map((c) => {
        const display = displays[c.id]
        const file = display?.kind === 'diff' && checkpoint && display.path in checkpoint.files ? display.path : undefined
        return (
          <ToolCard
            key={c.id}
            call={c}
            live={tools[c.id]}
            result={results.get(`${props.index}:${c.id}`)}
            display={display}
            denied={denied.has(c.id) || tools[c.id]?.denied}
            expandDefault={props.expandDefault}
            approval={approval && owns(c.id, approval.request) ? approval : undefined}
            question={question?.request.callId === c.id ? question : undefined}
            onRevertFile={file && checkpoint ? () => confirm(`Put ${base(file)} back the way it was before this turn?`) && onRevert(checkpoint.at, file) : undefined}
          />
        )
      })}
    </div>
  )
})

function LiveReply({ live, showReasoning }: { live: LiveState; showReasoning: boolean }) {
  return (
    <div className="assistant live">
      {live.streamReasoning && showReasoning && <Reasoning text={live.streamReasoning} open />}
      {live.streamText ? <Markdown text={live.streamText} /> : <Thinking tools={live.tools} />}
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

const ToolCard = memo(function ToolCard(props: {
  call: ToolCallT
  live?: ToolLive
  result?: ToolMessage
  display?: ToolDisplay
  denied?: boolean
  expandDefault: boolean
  approval?: { request: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }
  question?: { request: QuestionRequest; onAnswer: (text: string) => void }
  onRevertFile?: () => void
}) {
  const { call, live, result, display, denied, approval, question } = props
  // null = follow the default (diffs open automatically once they arrive); a click overrides it.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const input = useMemo<Record<string, unknown>>(() => {
    try {
      return JSON.parse(call.arguments || '{}')
    } catch {
      return {}
    }
  }, [call.arguments])
  const subject = live?.subject || String(input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? '')
  const task = call.name === 'task'
  const pending = !result
  const isError = result?.content.startsWith('Error:') || live?.isError
  const state = approval || question ? 'awaiting' : denied ? 'denied' : pending ? 'running' : isError ? 'error' : 'ok'
  const diff = display?.kind === 'diff' ? display : null
  const open = toggled ?? (props.expandDefault || !!diff)

  if (call.name === 'todo_write') return null
  if (call.name === 'ask_user') return <AskUserCard input={input} result={result} question={question} />

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
          {state === 'awaiting' ? (question ? 'needs an answer' : 'needs approval') : state === 'running' ? <span className="spinner" aria-label="Running" /> : state === 'denied' ? 'denied' : state === 'error' ? 'failed' : live?.durationMs != null ? `${(live.durationMs / 1000).toFixed(1)}s` : ''}
        </span>
      </button>
      {approval && <Approval key={approval.request.callId} request={approval.request} onAnswer={approval.onAnswer} />}
      {open && !approval && (
        <div className="tool-body">
          {diff ? (
            <>
              <DiffView patch={diff.patch} />
              {props.onRevertFile && (
                <div className="tool-actions">
                  <button className="link small" onClick={props.onRevertFile}>
                    Revert this file
                  </button>
                </div>
              )}
            </>
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
})

/** An ask_user call: the open question with its answer form, or the question and what you answered. */
function AskUserCard({ input, result, question }: { input: Record<string, unknown>; result?: ToolMessage; question?: { request: QuestionRequest; onAnswer: (text: string) => void } }) {
  const answer = result?.content.replace(/^The user answered: /, '')
  return (
    <div className={`tool ${question ? 'tool-awaiting' : 'tool-ok'} ask`}>
      <div className="tool-head static">
        <span className="tool-name">question</span>
        {/* While open, the question is shown in full below. */}
        <span className="tool-subject">{question ? '' : String(input.question ?? '')}</span>
        <span className="tool-state">{question ? 'needs an answer' : result ? '' : <span className="spinner" aria-label="Waiting" />}</span>
      </div>
      {question ? (
        <Question key={question.request.callId} request={question.request} onAnswer={question.onAnswer} />
      ) : (
        result && <div className="ask-answer">{result.content.startsWith('The user answered: ') ? answer : 'No answer; the agent decided itself.'}</div>
      )}
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
