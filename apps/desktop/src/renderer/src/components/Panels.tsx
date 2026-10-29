import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, DirListing, FileChange, FilePreview } from '../../../shared/ipc'
import { api } from '../lib/api'
import { basename } from '../lib/format'
import { DiffView } from './Chat'

/** Drag type for files dragged from the Files panel into the composer. */
export const PATH_DRAG_TYPE = 'application/x-harness-path'

// ---------------------------------------------------------------- resize handle

interface ResizerProps {
  /** x: drags left/right and sizes the panel to its right; y: drags up/down and sizes the panel below. */
  axis: 'x' | 'y'
  value: number
  min: number
  max: number
  label: string
  onChange: (v: number) => void
  /** Called once the drag or key press ends, with the final size. */
  onCommit: (v: number) => void
}

export function Resizer({ axis, value, min, max, label, onChange, onCommit }: ResizerProps) {
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)))
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = axis === 'x' ? e.clientX : e.clientY
    const from = value
    let last = value
    const move = (ev: PointerEvent) => {
      last = clamp(from + start - (axis === 'x' ? ev.clientX : ev.clientY))
      onChange(last)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      if (last !== from) onCommit(last)
    }
    document.body.classList.add('resizing')
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const grow = axis === 'x' ? ['ArrowLeft'] : ['ArrowUp']
    const shrink = axis === 'x' ? ['ArrowRight'] : ['ArrowDown']
    const step = e.shiftKey ? 64 : 16
    const next = grow.includes(e.key) ? value + step : shrink.includes(e.key) ? value - step : e.key === 'Home' ? min : e.key === 'End' ? max : null
    if (next == null) return
    e.preventDefault()
    const v = clamp(next)
    onChange(v)
    onCommit(v)
  }
  return (
    <div
      className={`resizer resizer-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}

// ---------------------------------------------------------------- right panel

interface RightProps {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}

type RightTab = 'files' | 'changes'

export function RightPanel({ app, onState, onError }: RightProps) {
  const [tab, setTab] = useState<RightTab>('files')
  const tabs: { id: RightTab; label: string }[] = [
    { id: 'files', label: 'Files' },
    { id: 'changes', label: 'Changes' },
  ]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = tab === 'files' ? 'changes' : 'files'
    setTab(next)
    document.getElementById(`rp-tab-${next}`)?.focus()
  }
  return (
    <div className="rpanel">
      <div className="ptabs" role="tablist" aria-label="Side panel">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`rp-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`rp-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
            onKeyDown={onKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ppane" role="tabpanel" id={`rp-${tab}`} aria-labelledby={`rp-tab-${tab}`}>
        {tab === 'files' ? (
          app.workspace ? <FilesPanel key={app.workspace} root={app.workspace} onError={onError} /> : <p className="muted small pad">Open a folder to see its files.</p>
        ) : (
          <ChangesPanel app={app} onState={onState} onError={onError} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- files

function FilesPanel({ root, onError }: { root: string; onError: (e: unknown) => void }) {
  const [dirs, setDirs] = useState<Record<string, DirListing | 'loading' | 'error'>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(
    (dir: string) => {
      setDirs((d) => ({ ...d, [dir]: d[dir] && d[dir] !== 'error' ? d[dir] : 'loading' }))
      api.fs.tree(dir).then(
        (l) => setDirs((d) => ({ ...d, [dir]: l })),
        (e) => {
          setDirs((d) => ({ ...d, [dir]: 'error' }))
          onError(e)
        },
      )
    },
    [onError],
  )

  useEffect(() => load(root), [root, load])

  const toggle = (dir: string) => {
    const next = new Set(open)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      load(dir)
    }
    setOpen(next)
  }
  const refresh = () => {
    load(root)
    for (const d of open) load(d)
    if (preview) openFile(preview.path)
  }
  const openFile = (file: string) => {
    setSelected(file)
    api.fs.read(file).then(setPreview, onError)
  }
  const rel = (p: string) => p.slice(root.length).replace(/^[\\/]/, '')

  if (preview)
    return (
      <div className="fpreview">
        <div className="phead">
          <button className="link small" onClick={() => setPreview(null)}>
            ← Files
          </button>
          <span className="ellipsis small mono" title={preview.path}>
            {rel(preview.path)}
          </span>
          <span className="spacer" />
          <button className="link small" onClick={refresh}>
            Reload
          </button>
        </div>
        {preview.binary ? (
          <p className="muted small pad">Binary file, not shown.</p>
        ) : (
          <>
            {preview.truncated && <p className="muted small pad">Showing the first {Math.round(preview.text.length / 1024)} KB of {Math.round(preview.size / 1024)} KB.</p>}
            <pre className="fpreview-text" tabIndex={0} aria-label={`Contents of ${basename(preview.path)}`}>
              {preview.text}
            </pre>
          </>
        )}
      </div>
    )

  const render = (dir: string, depth: number): React.ReactNode => {
    const l = dirs[dir]
    if (!l || l === 'loading') return <li className="tree-note muted small" style={{ paddingLeft: 8 + depth * 12 }}>Loading…</li>
    if (l === 'error') return <li className="tree-note muted small" style={{ paddingLeft: 8 + depth * 12 }}>Couldn't read this folder.</li>
    if (!l.entries.length && depth > 0) return <li className="tree-note muted small" style={{ paddingLeft: 8 + depth * 12 }}>Empty</li>
    return (
      <>
        {l.entries.map((e) => {
          const isOpen = open.has(e.path)
          return (
            <li key={e.path}>
              {e.dir ? (
                <button className="tree-row" style={{ paddingLeft: 8 + depth * 12 }} aria-expanded={isOpen} onClick={() => toggle(e.path)} title={rel(e.path)}>
                  <span className="tree-chev" aria-hidden>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="ellipsis">{e.name}</span>
                </button>
              ) : (
                <button
                  className={`tree-row file ${selected === e.path ? 'sel' : ''}`}
                  style={{ paddingLeft: 20 + depth * 12 }}
                  onClick={() => openFile(e.path)}
                  title={`${rel(e.path)}\nDrag into the message box to attach it.`}
                  draggable
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData(PATH_DRAG_TYPE, e.path)
                    ev.dataTransfer.setData('text/plain', e.path)
                    ev.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="ellipsis">{e.name}</span>
                </button>
              )}
              {e.dir && isOpen && <ul>{render(e.path, depth + 1)}</ul>}
            </li>
          )
        })}
        {l.hidden > 0 && (
          <li className="tree-note muted small" style={{ paddingLeft: 8 + depth * 12 }}>
            {l.hidden} more not shown
          </li>
        )}
      </>
    )
  }

  return (
    <div className="files">
      <div className="phead">
        <span className="ellipsis small" title={root}>
          {basename(root)}
        </span>
        <span className="spacer" />
        <button className="link small" onClick={refresh}>
          Refresh
        </button>
      </div>
      <ul className="tree" aria-label={`Files in ${basename(root)}`}>
        {render(root, 0)}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- changes

const STATUS: Record<FileChange['status'], { letter: string; label: string }> = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
}

function ChangesPanel({ app, onState, onError }: RightProps) {
  const id = app.session?.meta.id
  const [changes, setChanges] = useState<FileChange[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Re-read when the chat, its checkpoints or its running state change.
  const marker = (app.session?.checkpoints ?? []).map((c) => `${c.at}:${Object.keys(c.files).length}`).join(',')
  const seq = useRef(0)

  const refresh = useCallback(() => {
    if (!id) return setChanges([])
    const n = ++seq.current
    api.session.diff(id).then((c) => n === seq.current && setChanges(c), onError)
  }, [id, onError])

  useEffect(refresh, [refresh, marker, app.running])

  const revert = async (c: FileChange) => {
    if (!confirm(`Put ${c.rel} back the way it was before this chat changed it?`)) return
    setBusy(true)
    try {
      let state: AppState | null = null
      // Newest turn first, so the file ends up as it was before the earliest one.
      for (const at of [...c.turns].sort((a, b) => b - a)) state = await api.agent.revert(at, c.path)
      if (state) onState(state)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(p)) next.add(p)
      return next
    })

  if (!id) return <p className="muted small pad">Open a chat to see what it changed.</p>
  if (!changes) return <p className="muted small pad">Loading…</p>
  const added = changes.reduce((n, c) => n + c.added, 0)
  const removed = changes.reduce((n, c) => n + c.removed, 0)
  return (
    <div className="changes">
      <div className="phead">
        <span className="small">
          {changes.length ? (
            <>
              {changes.length} {changes.length === 1 ? 'file' : 'files'} <span className="diffstat"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
            </>
          ) : (
            <span className="muted">No changes in this chat</span>
          )}
        </span>
        <span className="spacer" />
        <button className="link small" onClick={refresh}>
          Refresh
        </button>
      </div>
      {changes.length === 0 && <p className="muted small pad">Files the agent edits in this chat show up here, compared with what's on disk now.</p>}
      <ul className="change-list">
        {changes.map((c) => {
          const isOpen = open.has(c.path)
          const s = STATUS[c.status]
          return (
            <li key={c.path} className="change">
              <div className="change-row">
                <button className="change-name" aria-expanded={isOpen} onClick={() => toggle(c.path)} title={c.path}>
                  <span className="tree-chev" aria-hidden>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className={`change-status st-${c.status}`} title={s.label}>
                    <span aria-hidden>{s.letter}</span>
                    <span className="sr-only">{s.label}</span>
                  </span>
                  <span className="ellipsis mono">{c.rel}</span>
                </button>
                {!c.note && (
                  <span className="diffstat small">
                    <span className="add">+{c.added}</span> <span className="del">−{c.removed}</span>
                  </span>
                )}
                <button className="link small" disabled={busy || app.running} onClick={() => revert(c)} title={app.running ? 'Wait for the turn to finish' : 'Restore the file as it was before this chat'}>
                  Revert
                </button>
              </div>
              {isOpen && (c.note ? <p className="muted small pad">{c.note}</p> : <DiffView patch={c.patch} />)}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
