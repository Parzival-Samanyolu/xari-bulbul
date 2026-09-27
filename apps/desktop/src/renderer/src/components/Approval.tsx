import { useEffect, useRef, useState } from 'react'
import type { PermissionAnswer, PermissionRequest } from '../../../shared/ipc'

interface Props {
  request: PermissionRequest
  onAnswer: (a: PermissionAnswer) => void
}

/**
 * Inline approval, shown inside the tool card it's about so the chat and diff stay visible.
 * Keys: Enter allows once, Shift+Enter allows for the session, Esc denies (handled in App).
 */
export function Approval({ request, onAnswer }: Props) {
  const [note, setNote] = useState('')
  const allowRef = useRef<HTMLButtonElement>(null)
  const input = request.input as Record<string, unknown>

  useEffect(() => {
    allowRef.current?.focus()
    allowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  const deny = () => onAnswer({ type: 'deny', feedback: note.trim() || undefined })

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      onAnswer({ type: 'allowAlways' })
    }
  }

  return (
    <div className="approval" role="group" aria-label={`Approve ${request.tool}`} onKeyDown={onKeyDown}>
      <Preview tool={request.tool} input={input} subject={request.subject} />
      <div className="approval-q">
        <span>
          {request.reason} <b>Allow it?</b>
        </span>
      </div>
      <div className="approval-actions">
        <button ref={allowRef} className="btn primary" onClick={() => onAnswer({ type: 'allow' })}>
          Allow <kbd>↵</kbd>
        </button>
        <button className="btn" onClick={() => onAnswer({ type: 'allowAlways' })}>
          Allow <code>{request.suggestedRule}</code> for this session <kbd>⇧↵</kbd>
        </button>
        <button className="btn danger" onClick={deny}>
          {note.trim() ? 'Deny with note' : 'Deny'} <kbd>Esc</kbd>
        </button>
      </div>
      <input
        className="approval-note"
        value={note}
        aria-label="Note for the agent if you deny (optional)"
        placeholder="Optional: tell the agent what to do instead, then Deny"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            e.stopPropagation()
            deny()
          }
        }}
      />
    </div>
  )
}

function Preview({ tool, input, subject }: { tool: string; input: Record<string, unknown>; subject: string }) {
  if (tool === 'bash') return <pre className="approval-preview cmd">$ {String(input.command)}</pre>
  if (tool === 'edit_file')
    return (
      <pre className="approval-preview diff" aria-label={`Proposed change to ${subject}`}>
        {String(input.old_string)
          .split('\n')
          .map((l, i) => (
            <div key={`o${i}`} className="d-del">
              -{l}
            </div>
          ))}
        {String(input.new_string)
          .split('\n')
          .map((l, i) => (
            <div key={`n${i}`} className="d-add">
              +{l}
            </div>
          ))}
      </pre>
    )
  if (tool === 'write_file') return <pre className="approval-preview">{String(input.content).slice(0, 4000)}</pre>
  return <pre className="approval-preview">{JSON.stringify(input, null, 2)}</pre>
}
