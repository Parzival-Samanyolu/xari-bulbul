import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, AttachmentInput, PermissionMode } from '../../../shared/ipc'
import { api } from '../lib/api'
import { modelLabel } from '../lib/format'

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Ask before edits and commands' },
  { id: 'acceptEdits', label: 'Auto-edit', hint: 'Edit files freely, ask before commands' },
  { id: 'plan', label: 'Plan', hint: 'Read-only: investigate and propose a plan' },
  { id: 'auto', label: 'Full auto', hint: 'Never ask (deny rules still apply)' },
]

interface Pending extends AttachmentInput {
  id: number
  /** Data URL thumbnail for images we have bytes for. */
  preview?: string
}

let attachId = 0
const IMAGE = /^image\/(png|jpeg|gif|webp)$/

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Dropped or pasted files: real files are sent by path; pasted images (no path) by content. */
async function toPending(files: File[]): Promise<Pending[]> {
  return Promise.all(
    files.map(async (f) => {
      const path = api.files.pathFor(f)
      const image = IMAGE.test(f.type)
      const preview = image && f.size < 8 * 1024 * 1024 ? await readAsDataUrl(f) : undefined
      if (path) return { id: ++attachId, name: f.name, path, size: f.size, preview }
      if (image && preview) return { id: ++attachId, name: f.name || 'pasted-image.png', mediaType: f.type, data: preview.split(',')[1], size: f.size, preview }
      throw new Error(`Couldn't attach "${f.name}".`)
    }),
  )
}

const kb = (n?: number) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onOpenPicker: () => void
}

export function Composer({ app, onState, onError, onOpenPicker }: Props) {
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const [attachments, setAttachments] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendWithEnter = app.settings.appearance.sendWithEnter

  useEffect(() => ref.current?.focus(), [app.session?.meta.id])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [text])

  const slash = /^\/(\S*)$/.exec(text)
  const matches = useMemo(
    () => (slash ? app.extensions.commands.filter((c) => c.name.startsWith(slash[1])).slice(0, 8) : []),
    [slash?.[1], app.extensions.commands],
  )

  const cycleMode = () => {
    const i = MODES.findIndex((m) => m.id === app.mode)
    api.agent.setMode(MODES[(i + 1) % MODES.length].id).then(onState, onError)
  }

  const add = (files: File[]) => {
    if (!files.length) return
    toPending(files).then((p) => setAttachments((a) => [...a, ...p]), onError)
    ref.current?.focus()
  }

  // Dropping a file anywhere in the window attaches it (and never navigates away).
  useEffect(() => {
    let depth = 0
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
    }
    const enter = (e: DragEvent) => e.dataTransfer?.types.includes('Files') && (depth++, setDragging(true))
    const leave = () => --depth <= 0 && ((depth = 0), setDragging(false))
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      add([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    add(files)
  }

  const pick = () =>
    api.files.pick().then((p) => p.length && setAttachments((a) => [...a, ...p.map((x) => ({ ...x, id: ++attachId }))]), onError)

  const submit = async (raw = text) => {
    const t = raw.trim()
    if ((!t && !attachments.length) || app.running) return
    if (attachments.length) {
      const sending = attachments
      setText('')
      setAttachments([])
      if (t) setHistory((h) => [t, ...h.filter((x) => x !== t)].slice(0, 50))
      // Put them back if the send is rejected (e.g. an unreadable file), so nothing is lost.
      api.agent.send(t, sending.map(({ id, preview, ...a }) => a)).catch((e) => {
        setText((cur) => cur || t)
        setAttachments((cur) => (cur.length ? cur : sending))
        onError(e)
      })
      return
    }
    setHistory((h) => [t, ...h.filter((x) => x !== t)].slice(0, 50))
    setHIdx(-1)
    setText('')
    // Built-in commands handled by the UI.
    if (t === '/clear') return api.sessions.create().then(onState, onError)
    if (t === '/model') return onOpenPicker()
    if (t === '/mode') return cycleMode()
    if (t === '/compact') return api.agent.compact().catch(onError)
    api.agent.send(t).catch(onError)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return
    }
    if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      const cmd = matches[Math.min(sel, matches.length - 1)]
      if (cmd.source === 'builtin' && e.key === 'Enter') submit(`/${cmd.name}`)
      else setText(`/${cmd.name} `)
      setSel(0)
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      cycleMode()
      return
    }
    if (e.key === 'ArrowUp' && !text.includes('\n') && (text === '' || hIdx >= 0) && history.length) {
      e.preventDefault()
      const i = Math.min(hIdx + 1, history.length - 1)
      setHIdx(i)
      setText(history[i])
      return
    }
    if (e.key === 'ArrowDown' && hIdx >= 0) {
      e.preventDefault()
      const i = hIdx - 1
      setHIdx(i)
      setText(i >= 0 ? history[i] : '')
      return
    }
    const isSend = e.key === 'Enter' && (sendWithEnter ? !e.shiftKey : e.metaKey || e.ctrlKey)
    if (isSend && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const model = app.session?.meta.model
  const ready = model ? app.ready[model.providerId] : false

  return (
    <div className="composer">
      {matches.length > 0 && (
        <div className="slash-menu">
          {matches.map((c, i) => (
            <button key={c.name} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => (c.source === 'builtin' ? submit(`/${c.name}`) : setText(`/${c.name} `))}>
              <span className="slash-name">/{c.name}</span>
              <span className="muted">{c.description}</span>
              {c.source !== 'builtin' && <span className="badge">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      <div className={`composer-box ${app.running ? 'running' : ''} ${dragging ? 'dragging' : ''}`}>
        {dragging && <div className="drop-hint">Drop to attach</div>}
        {attachments.length > 0 && (
          <ul className="attachments" aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.id} className="attachment" title={a.path ?? a.name}>
                {a.preview ? <img src={a.preview} alt="" /> : <span className="attachment-icon" aria-hidden>{IMAGE.test(a.mediaType ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(a.name) ? '▣' : '≡'}</span>}
                <span className="attachment-name">{a.name}</span>
                <span className="muted small">{kb(a.size)}</span>
                <button className="attachment-del" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          aria-label="Message"
          placeholder={app.running ? 'Working… (Esc to stop)' : 'Ask Xarı Bülbül to do something… (/ for commands)'}
          onChange={(e) => {
            setText(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar">
          <button className="icon-btn attach" onClick={pick} aria-label="Attach files" title="Attach files (or drop / paste them)">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5.2 5.2a4.2 4.2 0 0 0 6 6l4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="chip" onClick={onOpenPicker} title="Switch model (⌘/Ctrl+K)">
            <span className={`dot ${ready ? 'ok' : 'bad'}`} aria-label={ready ? 'Provider ready' : 'Provider needs setup'} />
            {model ? modelLabel(model.modelId) : 'Pick a model'}
            <span className="muted small">{model?.providerId}</span>
          </button>
          <div className="modes" title="Permission mode (Shift+Tab to cycle)">
            {MODES.map((m) => (
              <button key={m.id} aria-pressed={app.mode === m.id} className={`mode mode-${m.id} ${app.mode === m.id ? 'on' : ''}`} title={m.hint} onClick={() => api.agent.setMode(m.id).then(onState, onError)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="spacer" />
          {app.running ? (
            <button className="btn stop" onClick={() => api.agent.stop()}>
              ■ Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!text.trim() && !attachments.length} onClick={() => submit()}>
              Send ↵
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
