import { useEffect, useRef, useState } from 'react'
import type { AppState, SessionMeta } from '../../../shared/ipc'
import { isBotChat } from '@harness/core/bots'
import { api } from '../lib/api'
import { ago, basename } from '../lib/format'
import { BotsPanel } from './BotsPanel'

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onSettings: () => void
  onChat: () => void
  settingsOpen: boolean
  /** Opens the bot dialog: a bot's id to edit it, nothing for a new one. */
  onEditBot: (id?: string) => void
}

type Tab = 'sessions' | 'bots'

export function Sidebar({ app, onState, onError, onSettings, onChat, settingsOpen, onEditBot }: Props) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = app.session?.meta.id
  const openPaths = new Set(app.folders.map((f) => f.path))
  const recents = app.settings.app.recentWorkspaces.filter((w) => !openPaths.has(w))
  const mod = app.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const botsOn = app.settings.botOptions.enabled
  const onBotChat = !!app.session && isBotChat(app.settings, app.session.meta)
  const [tab, setTab] = useState<Tab>(onBotChat ? 'bots' : 'sessions')
  // Opening a chat shows the tab it belongs to (a notification click, ⌘1–9, a new chat).
  useEffect(() => setTab(onBotChat ? 'bots' : 'sessions'), [current, onBotChat])
  const shownTab: Tab = botsOn ? tab : 'sessions'
  const unread = app.bots.filter((b) => b.unread).length
  const tabKeys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next: Tab = shownTab === 'sessions' ? 'bots' : 'sessions'
    setTab(next)
    document.getElementById(`side-tab-${next}`)?.focus()
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('sidebar.collapsed') ?? '[]')))
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      localStorage.setItem('sidebar.collapsed', JSON.stringify([...next]))
      return next
    })

  // Folder reordering: drag a folder header, or Alt+↑/↓ on it.
  const [drag, setDrag] = useState<{ from: string; over?: string; after?: boolean } | null>(null)
  const move = (from: string, to: string, after: boolean) => {
    const paths = app.folders.map((f) => f.path).filter((p) => p !== from)
    const at = paths.indexOf(to)
    if (at < 0) return
    paths.splice(after ? at + 1 : at, 0, from)
    if (paths.join('\0') !== app.folders.map((f) => f.path).join('\0')) api.workspace.reorder(paths).then(onState, onError)
  }
  const onFolderKey = (e: React.KeyboardEvent, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1
    if (j < 0 || j >= app.folders.length) return
    move(app.folders[i].path, app.folders[j].path, j > i)
  }

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
            <span className="session-meta session-status awaiting">{app.questions.some((q) => q.sessionId === s.id) ? 'Has a question' : 'Needs approval'}</span>
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
      {botsOn && (
        <div className="side-tabs" role="tablist" aria-label="Sidebar">
          {(['sessions', 'bots'] as const).map((t) => (
            <button
              key={t}
              id={`side-tab-${t}`}
              role="tab"
              aria-selected={shownTab === t}
              aria-controls={`side-panel-${t}`}
              tabIndex={shownTab === t ? 0 : -1}
              className={`side-tab ${shownTab === t ? 'on' : ''}`}
              onClick={() => setTab(t)}
              onKeyDown={tabKeys}
            >
              {t === 'sessions' ? 'Sessions' : 'Bots'}
              {t === 'bots' && unread > 0 && (
                <span className="side-tab-dot" role="img" aria-label={`${unread} new ${unread === 1 ? 'reply' : 'replies'}`} />
              )}
            </button>
          ))}
        </div>
      )}
      {shownTab === 'bots' ? (
        <div className="side-panel" id="side-panel-bots" role="tabpanel" aria-labelledby="side-tab-bots">
          <BotsPanel app={app} onState={onState} onError={onError} onEditBot={onEditBot} onChat={onChat} settingsOpen={settingsOpen} />
        </div>
      ) : (
        <div className="side-panel" id="side-panel-sessions" role={botsOn ? 'tabpanel' : undefined} aria-labelledby={botsOn ? 'side-tab-sessions' : undefined}>
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
            {app.folders.map((f, fi) => {
              const isCurrent = f.path === app.workspace
              const shut = collapsed.has(f.path)
              const busy = f.sessions.some((s) => app.awaitingSessions.includes(s.id)) ? 'awaiting' : f.sessions.some((s) => app.runningSessions.includes(s.id)) ? 'working' : null
              return (
                <section
                  key={f.path}
                  className={`folder ${isCurrent ? 'current' : ''} ${drag?.from === f.path ? 'dragging' : ''} ${drag?.over === f.path ? (drag.after ? 'drop-after' : 'drop-before') : ''}`}
                  aria-label={basename(f.path)}
                  onDragOver={(e) => {
                    if (!drag) return
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    const after = e.clientY > r.top + r.height / 2
                    if (drag.over !== f.path || drag.after !== after) setDrag({ ...drag, over: f.path, after })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (drag && drag.from !== f.path) move(drag.from, f.path, !!drag.after)
                    setDrag(null)
                  }}
                >
                  <div
                    className="folder-head"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', f.path)
                      setDrag({ from: f.path })
                    }}
                    onDragEnd={() => setDrag(null)}
                  >
                    <button
                      className="folder-toggle"
                      aria-expanded={!shut}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      title={`${f.path}\nDrag or press Alt+↑/↓ to reorder`}
                      onClick={() => toggle(f.path)}
                      onKeyDown={(e) => onFolderKey(e, fi)}
                    >
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
        </div>
      )}

      <button className={`sidebar-settings ${settingsOpen ? 'active' : ''}`} aria-pressed={settingsOpen} onClick={settingsOpen ? onChat : onSettings}>
        <span>
          <span aria-hidden>⚙ </span>Settings
        </span>
        <kbd>{mod},</kbd>
      </button>
    </aside>
  )
}
