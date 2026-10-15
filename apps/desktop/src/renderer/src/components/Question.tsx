import { useEffect, useRef, useState } from 'react'
import type { QuestionRequest } from '../../../shared/ipc'

interface Props {
  request: QuestionRequest
  onAnswer: (text: string) => void
}

/** An ask_user question inside its tool card: pick an option (or several) or write your own answer. */
export function Question({ request, onAnswer }: Props) {
  const [picked, setPicked] = useState<string[]>([])
  const [own, setOwn] = useState('')
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    first.current?.focus()
    first.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  const toggle = (o: string) => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))
  const submit = () => {
    const parts = [...picked, own.trim()].filter(Boolean)
    if (parts.length) onAnswer(parts.join('; '))
  }

  return (
    <div className="approval question" role="group" aria-label={request.question}>
      <div className="approval-q">
        <b>{request.question}</b>
      </div>
      <div className="question-options">
        {request.options.map((o, i) =>
          request.multiSelect ? (
            <label key={o} className={`question-option${picked.includes(o) ? ' on' : ''}`}>
              <input type="checkbox" checked={picked.includes(o)} onChange={() => toggle(o)} /> {o}
            </label>
          ) : (
            <button key={o} ref={i === 0 ? first : undefined} className="btn question-option" onClick={() => onAnswer(o)}>
              {o}
            </button>
          ),
        )}
      </div>
      <form
        className="approval-actions"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input className="approval-note" value={own} aria-label="Your own answer" placeholder={request.multiSelect ? 'Add something else (optional)' : 'Or write your own answer'} onChange={(e) => setOwn(e.target.value)} />
        {(request.multiSelect || own.trim()) && (
          <button type="submit" className="btn primary" disabled={!picked.length && !own.trim()}>
            Answer
          </button>
        )}
        <button type="button" className="btn ghost" onClick={() => onAnswer('')}>
          Skip
        </button>
      </form>
    </div>
  )
}
