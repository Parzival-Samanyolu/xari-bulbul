import { useEffect, useRef, useState } from 'react'
import type { AppState, SessionMeta } from '../../../shared/ipc'
import { api } from '../lib/api'
import { ago, basename } from '../lib/format'

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onSettings: () => void
  onChat: () => void
  settingsOpen: boolean
}

export function Sidebar({ app, onState, onError, onSettings, onChat, settingsOpen }: Props) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = app.session?.meta.id
  const openPaths = new Set(app.folders.map((f) => f.path))
  const recents = app.settings.app.recentWorkspaces.filter((w) => !openPaths.has(w))
  const mod = app.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('sidebar.collapsed') ?? '[]')))
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      localStorage.setItem('sidebar.collapsed', JSON.stringify([...next]))
      return next
    })

  const closeMenu = (refocus = true) => {
    setMenu(false)
    if (refocus) trigger.current?.focus()
  }

  // Menu: focus the first item on open; Esc/arrow keys; close when focus or a click leaves it.
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && e.target !== trigger.current) closeMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll('button') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), closeMenu())
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Tab') closeMenu(false)
  }

  const pick = (fn: () => Promise<AppState>) => {
    closeMenu()
    fn().then(onState, onError)
  }

  // `i` is the ⌘1–9 position; only chats in the current folder have one (-1 otherwise).
  const renderSession = (s: SessionMeta, i: number) => {
    const active = s.id === current && !settingsOpen
    const awaiting = app.awaitingSessions.includes(s.id)
    const working = app.runningSessions.includes(s.id)
    return (
      <li key={s.id} className={`session ${active ? 'active' : ''}`}>
        <button
          className="session-open"
          aria-current={active ? 'page' : undefined}
          title={i >= 0 && i < 9 ? `${s.title} (${mod}${i + 1})` : s.title}
          onClick={() => {
            onChat()
            if (s.id !== current) api.sessions.open(s.id).then(onState, onError)
          }}
        >
          <span className="session-title">{s.title}</span>
          {awaiting ? (
            <span className="session-meta session-status awaiting">Needs approval</span>
          ) : working ? (
            <span className="session-meta session-status">
              <span className="spinner" aria-hidden />
              Working…
            </span>
          ) : (
            <span className="session-meta">
              {ago(s.updatedAt)} · {s.model.modelId.split('/').pop()}
            </span>
          )}
        </button>
        <button
          className="session-del"
          aria-label={`Delete chat "${s.title}"`}
          title="Delete chat"
          onClick={() => {
            if (confirm(`Delete "${s.title}"?`)) api.sessions.remove(s.id).then(onState, onError)
          }}
        >
          ×
        </button>
      </li>
    )
  }

  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="sidebar-drag" />
      <div className="workspace">
        <button ref={trigger} className="workspace-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <span className="workspace-name">Folders</span>
          <span className="chev" aria-hidden>
            ＋
          </span>
          <span className="sr-only">Open a folder</span>
        </button>
        {menu && (
          <div className="menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
            <button role="menuitem" onClick={() => pick(() => api.workspace.pick())}>
              Open folder…
            </button>
            {recents.length > 0 && (
              <div className="menu-label" role="presentation">
                Recent
              </div>
            )}
            {recents.map((w) => (
              <button key={w} role="menuitem" title={w} onClick={() => pick(() => api.workspace.set(w))}>
                {basename(w)}
                <span className="muted small"> {w}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="new-chat"
        disabled={!app.workspace}
        title={app.workspace ? `New chat in ${basename(app.workspace)}` : undefined}
        onClick={() => {
          onChat()
          api.sessions.create().then(onState, onError)
        }}
      >
        + New chat <kbd>{mod}N</kbd>
      </button>

      <nav className="sessions" aria-label="Folders and chats">
        {app.folders.length === 0 && <div className="muted small pad">Open a folder to start.</div>}
        {app.folders.map((f) => {
          const isCurrent = f.path === app.workspace
          const shut = collapsed.has(f.path)
          const busy = f.sessions.some((s) => app.awaitingSessions.includes(s.id)) ? 'awaiting' : f.sessions.some((s) => app.runningSessions.includes(s.id)) ? 'working' : null
          return (
            <section key={f.path} className={`folder ${isCurrent ? 'current' : ''}`} aria-label={basename(f.path)}>
              <div className="folder-head">
                <button className="folder-toggle" aria-expanded={!shut} title={f.path} onClick={() => toggle(f.path)}>
                  <span className="chev" aria-hidden>
                    {shut ? '▸' : '▾'}
                  </span>
                  <span className="folder-name">{basename(f.path)}</span>
                  {shut && busy && <span className={`folder-dot ${busy}`} aria-label={busy === 'awaiting' ? 'A chat needs approval' : 'A chat is working'} />}
                </button>
                <button
                  className="folder-act"
                  aria-label={`New chat in ${basename(f.path)}`}
                  title="New chat"
                  onClick={() => {
                    onChat()
                    if (shut) toggle(f.path)
                    api.sessions.create(f.path).then(onState, onError)
                  }}
                >
                  ＋
                </button>
                <button
                  className="folder-act"
                  aria-label={`Close ${basename(f.path)}`}
                  title="Close folder (chats are kept)"
                  onClick={() => {
                    const running = f.sessions.filter((s) => app.runningSessions.includes(s.id)).length
                    if (running && !confirm(`${running} chat${running > 1 ? 's are' : ' is'} still working in ${basename(f.path)}. Close the folder anyway? They'll finish in the background.`)) return
                    api.workspace.close(f.path).then(onState, onError)
                  }}
                >
                  ×
                </button>
              </div>
              {!shut && (
                <ul>
                  {f.sessions.length === 0 && <li className="muted small pad">No chats yet.</li>}
                  {f.sessions.map((s) => (
                    renderSession(s, isCurrent ? app.sessions.findIndex((x) => x.id === s.id) : -1)
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </nav>

      <button className={`sidebar-settings ${settingsOpen ? 'active' : ''}`} aria-pressed={settingsOpen} onClick={settingsOpen ? onChat : onSettings}>
        <span>
          <span aria-hidden>⚙ </span>Settings
        </span>
        <kbd>{mod},</kbd>
      </button>
    </aside>
  )
}
