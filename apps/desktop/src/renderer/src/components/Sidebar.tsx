import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../../shared/ipc'
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
  const recents = app.settings.app.recentWorkspaces.filter((w) => w !== app.workspace)
  const mod = app.platform === 'darwin' ? '⌘' : 'Ctrl+'

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

  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="sidebar-drag" />
      <div className="workspace">
        <button
          ref={trigger}
          className="workspace-btn"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          title={app.workspace ?? 'Open a folder'}
        >
          <span className="workspace-name">{app.workspace ? basename(app.workspace) : 'No folder open'}</span>
          <span className="chev" aria-hidden>
            ▾
          </span>
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
        onClick={() => {
          onChat()
          api.sessions.create().then(onState, onError)
        }}
      >
        + New chat <kbd>{mod}N</kbd>
      </button>

      <nav className="sessions" aria-label="Chats in this folder">
        {app.sessions.length === 0 && app.workspace && <div className="muted small pad">No chats yet in this folder.</div>}
        <ul>
          {app.sessions.map((s, i) => {
            const active = s.id === current && !settingsOpen
            const awaiting = app.awaitingSessions.includes(s.id)
            const working = app.runningSessions.includes(s.id)
            return (
              <li key={s.id} className={`session ${active ? 'active' : ''}`}>
                <button
                  className="session-open"
                  aria-current={active ? 'page' : undefined}
                  title={i < 9 ? `${s.title} (${mod}${i + 1})` : s.title}
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
          })}
        </ul>
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
