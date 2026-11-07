import { useEffect, useRef, useState } from 'react'
import type { AppState, SessionMeta } from '../../../shared/ipc'
import { isBotChat } from '@harness/core/bots'
import { api } from '../lib/api'
import { basename } from '../lib/format'
import { useFormat, useT } from '../lib/i18n'
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
  /** Opens the lobby dialog: a lobby's id to edit it, nothing for a new one. */
  onEditLobby: (id?: string) => void
}

type Tab = 'sessions' | 'bots'

export function Sidebar({ app, onState, onError, onSettings, onChat, settingsOpen, onEditBot, onEditLobby }: Props) {
  const { t } = useT()
  const fmt = useFormat()
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = app.session?.meta.id
  const openPaths = new Set(app.folders.map((f) => f.path))
  const recents = app.settings.app.recentWorkspaces.filter((w) => !openPaths.has(w))
  const mod = app.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const botsOn = app.settings.botOptions.enabled
  const onBotChat = !!app.session && (isBotChat(app.settings, app.session.meta) || (!!app.session.meta.lobbyId && botsOn))
  const [tab, setTab] = useState<Tab>(onBotChat ? 'bots' : 'sessions')
  // Opening a chat shows the tab it belongs to (a notification click, ⌘1–9, a new chat).
  useEffect(() => setTab(onBotChat ? 'bots' : 'sessions'), [current, onBotChat])
  const shownTab: Tab = botsOn ? tab : 'sessions'
  const unread = app.bots.filter((b) => b.unread).length + app.lobbies.filter((l) => l.unread).length
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
            <span className="session-meta session-status awaiting">{app.questions.some((q) => q.sessionId === s.id) ? t('bots.sidebar.hasQuestion') : t('bots.sidebar.needsApproval')}</span>
          ) : working ? (
            <span className="session-meta session-status">
              <span className="spinner" aria-hidden />
              {t('bots.sidebar.working')}
            </span>
          ) : (
            <span className="session-meta">
              {fmt.ago(s.updatedAt)} · {s.model.modelId.split('/').pop()}
            </span>
          )}
        </button>
        <button
          className="session-del"
          aria-label={t('bots.sidebar.deleteChatNamed', { title: s.title })}
          title={t('bots.sidebar.deleteChat')}
          onClick={() => {
            if (confirm(t('bots.sidebar.confirmDelete', { title: s.title }))) api.sessions.remove(s.id).then(onState, onError)
          }}
        >
          ×
        </button>
      </li>
    )
  }

  return (
    <aside className="sidebar" aria-label={t('bots.sidebar.chats')}>
      <div className="sidebar-drag" />
      {botsOn && (
        <div className="side-tabs" role="tablist" aria-label={t('bots.sidebar.tabs')}>
          {(['sessions', 'bots'] as const).map((id) => (
            <button
              key={id}
              id={`side-tab-${id}`}
              role="tab"
              aria-selected={shownTab === id}
              aria-controls={`side-panel-${id}`}
              tabIndex={shownTab === id ? 0 : -1}
              className={`side-tab ${shownTab === id ? 'on' : ''}`}
              onClick={() => setTab(id)}
              onKeyDown={tabKeys}
            >
              {id === 'sessions' ? t('bots.sidebar.sessions') : t('bots.sidebar.bots')}
              {id === 'bots' && unread > 0 && <span className="side-tab-dot" role="img" aria-label={t('bots.sidebar.newReplies', { count: unread })} />}
            </button>
          ))}
        </div>
      )}
      {shownTab === 'bots' ? (
        <div className="side-panel" id="side-panel-bots" role="tabpanel" aria-labelledby="side-tab-bots">
          <BotsPanel app={app} onState={onState} onError={onError} onEditBot={onEditBot} onEditLobby={onEditLobby} onChat={onChat} settingsOpen={settingsOpen} />
        </div>
      ) : (
        <div className="side-panel" id="side-panel-sessions" role={botsOn ? 'tabpanel' : undefined} aria-labelledby={botsOn ? 'side-tab-sessions' : undefined}>
          <div className="workspace">
            <button ref={trigger} className="workspace-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <span className="workspace-name">{t('bots.sidebar.folders')}</span>
              <span className="chev" aria-hidden>
                ＋
              </span>
              <span className="sr-only">{t('bots.sidebar.openAFolder')}</span>
            </button>
            {menu && (
              <div className="menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
                <button role="menuitem" onClick={() => pick(() => api.workspace.pick())}>
                  {t('bots.sidebar.openFolder')}
                </button>
                {recents.length > 0 && (
                  <div className="menu-label" role="presentation">
                    {t('bots.sidebar.recent')}
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
            title={app.workspace ? t('bots.sidebar.newChatIn', { folder: basename(app.workspace) }) : undefined}
            onClick={() => {
              onChat()
              api.sessions.create().then(onState, onError)
            }}
          >
            + {t('bots.sidebar.newChat')} <kbd>{mod}N</kbd>
          </button>

          <nav className="sessions" aria-label={t('bots.sidebar.foldersAndChats')}>
            {app.folders.length === 0 && <div className="muted small pad">{t('bots.sidebar.openToStart')}</div>}
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
                      title={`${f.path}\n${t('bots.sidebar.reorder')}`}
                      onClick={() => toggle(f.path)}
                      onKeyDown={(e) => onFolderKey(e, fi)}
                    >
                      <span className="chev" aria-hidden>
                        {shut ? '▸' : '▾'}
                      </span>
                      <span className="folder-name">{basename(f.path)}</span>
                      {shut && busy && <span className={`folder-dot ${busy}`} aria-label={busy === 'awaiting' ? t('bots.sidebar.folderAwaiting') : t('bots.sidebar.folderWorking')} />}
                    </button>
                    <button
                      className="folder-act"
                      aria-label={t('bots.sidebar.newChatIn', { folder: basename(f.path) })}
                      title={t('bots.sidebar.newChat')}
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
                      aria-label={t('bots.sidebar.closeNamed', { folder: basename(f.path) })}
                      title={t('bots.sidebar.closeFolder')}
                      onClick={() => {
                        const running = f.sessions.filter((s) => app.runningSessions.includes(s.id)).length
                        if (running && !confirm(t('bots.sidebar.confirmClose', { count: running, folder: basename(f.path) }))) return
                        api.workspace.close(f.path).then(onState, onError)
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {!shut && (
                    <ul>
                      {f.sessions.length === 0 && <li className="muted small pad">{t('bots.sidebar.noChats')}</li>}
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
          <span aria-hidden>⚙ </span>
          {t('bots.sidebar.settings')}
        </span>
        <kbd>{mod},</kbd>
      </button>
    </aside>
  )
}
