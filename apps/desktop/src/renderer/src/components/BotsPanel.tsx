import { useEffect, useRef, useState } from 'react'
import { lobbyBots, newBotId, shownBots, shownLobbies } from '@harness/core/bots'
import type { AppState, BotRow, LobbyRow, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useFormat, useT } from '../lib/i18n'
import { BotFaceView } from './BotFace'
import { BotAvatar, StackedFaces, withBot } from './Bots'

type Bot = Settings['bots'][number]

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  /** Opens the bot dialog: a bot's id to edit it, nothing for a new one. */
  onEditBot: (id?: string) => void
  /** Opens the lobby dialog: a lobby's id to edit it, nothing for a new one. */
  onEditLobby: (id?: string) => void
  /** Called before a bot chat opens (closes Settings). */
  onChat: () => void
  settingsOpen: boolean
}

const EMPTY_ROW: BotRow = { id: '', threads: [], unread: false, running: false, awaiting: false }

/** The sidebar's Bots tab: one row per bot, like a messaging app. */
export function BotsPanel({ app, onState, onError, onEditBot, onEditLobby, onChat, settingsOpen }: Props) {
  const { t } = useT()
  // "now", "5m", "3h", "2d", "4w": the time since a bot's last message.
  const since = useFormat().ago
  const bots = shownBots(app.settings)
  const rows = new Map(app.bots.map((r) => [r.id, r]))
  const muted = app.settings.botOptions.muted
  const currentBot = app.session?.meta.botId
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number; opener: HTMLElement | null } | null>(null)
  // The "5m" times age while nothing else changes.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  const save = (s: Settings) => api.settings.set(s).then(onState, onError)
  const open = (b: Bot) => {
    onChat()
    api.bots.open(b.id).then(onState, onError)
  }

  return (
    <div className="bots-panel">
      <div className="bots-head">
        <h2 className="bots-title">{t('bots.panel.title')}</h2>
        <button
          className="icon-btn"
          aria-pressed={muted}
          aria-label={t('bots.panel.mute')}
          title={muted ? t('bots.panel.muted') : t('bots.panel.mute')}
          onClick={() => save({ ...app.settings, botOptions: { ...app.settings.botOptions, muted: !muted } })}
        >
          <BellIcon off={muted} />
        </button>
        <button className="icon-btn" aria-label={t('bots.panel.newBot')} title={t('bots.panel.newBot')} onClick={() => onEditBot()}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="bots-scroll">
        {bots.length === 0 ? (
          <div className="bots-empty">
            <div className="bots-empty-faces" aria-hidden>
              <BotFaceView face={{ kind: 'shape', shape: 'blob', color: '#d98bb0' }} size={34} />
              <BotFaceView face={{ kind: 'pet', pet: 'cat', color: '#eda26b' }} size={34} />
              <BotFaceView face={{ kind: 'shape', shape: 'ghost', color: '#6cc3a0' }} size={34} />
              <BotFaceView face={{ kind: 'pet', pet: 'frog', color: '#9cbb6a' }} size={34} />
            </div>
            <p className="muted small">{t('bots.panel.empty')}</p>
            <button className="btn primary" onClick={() => onEditBot()}>
              {t('bots.panel.make')}
            </button>
          </div>
        ) : (
          <ul className="bot-rows" aria-label={t('bots.panel.title')}>
            {bots.map((b) => {
              const row = rows.get(b.id) ?? EMPTY_ROW
              const last = row.threads[0]
              const active = currentBot === b.id && !settingsOpen
              const status = !b.enabled ? 'off' : row.awaiting ? 'awaiting' : row.running ? 'working' : 'on'
              const statusText = { off: t('bots.panel.off'), awaiting: t('bots.panel.needsYou'), working: t('bots.panel.working'), on: '' }[status]
              const preview = !b.enabled
                ? t('bots.panel.off')
                : row.awaiting
                  ? app.questions.some((q) => row.threads.some((th) => th.id === q.sessionId))
                    ? t('bots.sidebar.hasQuestion')
                    : t('bots.sidebar.needsApproval')
                  : row.running
                    ? t('bots.panel.typing')
                    : last?.preview || b.tagline || t('bots.panel.sayHi')
              const openMenu = (x: number, y: number, opener: HTMLElement | null) => setMenu({ bot: b, x, y, opener })
              return (
                <li key={b.id} className={`bot-row ${active ? 'active' : ''} ${b.enabled ? '' : 'off'} ${row.unread ? 'unread' : ''} ${status}`}>
                  <button
                    className="bot-row-open"
                    aria-current={active ? 'page' : undefined}
                    aria-label={[b.name || t('bots.botName'), statusText, row.unread ? t('bots.panel.newReply') : '', b.muted ? t('bots.panel.mutedBot') : '', preview !== statusText ? preview : ''].filter(Boolean).join('. ')}
                    onClick={() => open(b)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openMenu(e.clientX, e.clientY, e.currentTarget)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault()
                        const r = e.currentTarget.getBoundingClientRect()
                        openMenu(r.left + 24, r.bottom - 6, e.currentTarget)
                      }
                    }}
                  >
                    <span className="bot-row-face">
                      {/* A working bot's face wobbles; the others stay still. */}
                      <BotAvatar app={app} bot={b} size={34} mood={status === 'working' ? 'thinking' : undefined} />
                      <span className={`bot-status ${status}`} aria-hidden />
                    </span>
                    <span className="bot-row-text">
                      <span className="bot-row-top">
                        <span className="bot-row-name">{b.name || t('bots.botName')}</span>
                        {b.muted && <BellIcon off small />}
                        <span className="bot-row-time">{last ? since(last.updatedAt) : ''}</span>
                      </span>
                      <span className="bot-row-bottom">
                        <span className="bot-row-preview">{preview}</span>
                        {row.unread && <span className="bot-unread" aria-hidden />}
                      </span>
                    </span>
                  </button>
                  <button
                    className="bot-row-more"
                    aria-label={t('bots.panel.moreFor', { name: b.name })}
                    aria-haspopup="menu"
                    aria-expanded={menu?.bot.id === b.id}
                    title={t('bots.panel.more')}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      openMenu(r.left, r.bottom + 2, e.currentTarget)
                    }}
                  >
                    ⋯
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {bots.length > 0 && !app.workspace && <p className="muted small pad">{t('bots.panel.noFolder')}</p>}
        {bots.length > 0 && <LobbiesSection app={app} onState={onState} onError={onError} onEditLobby={onEditLobby} onChat={onChat} settingsOpen={settingsOpen} />}
      </div>

      {menu && (
        <BotMenu
          app={app}
          bot={menu.bot}
          x={menu.x}
          y={menu.y}
          onClose={(refocus) => {
            const opener = menu.opener
            setMenu(null)
            if (refocus) opener?.focus()
          }}
          onState={onState}
          onError={onError}
          onEditBot={onEditBot}
          onChat={onChat}
        />
      )}
    </div>
  )
}

function BellIcon({ off, small }: { off?: boolean; small?: boolean }) {
  const { t } = useT()
  const size = small ? 11 : 14
  return (
    <svg
      className={small ? 'bot-row-muted' : undefined}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={small ? undefined : true}
      role={small ? 'img' : undefined}
      aria-label={small ? t('bots.panel.mutedBot') : undefined}
    >
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.5 13.5a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      {off && <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  )
}

/** Right-click (or ⋯) menu on a bot row. */
function BotMenu({
  app,
  bot,
  x,
  y,
  onClose,
  onState,
  onError,
  onEditBot,
  onChat,
}: {
  app: AppState
  bot: Bot
  x: number
  y: number
  onClose: (refocus: boolean) => void
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onEditBot: (id?: string) => void
  onChat: () => void
}) {
  const { t } = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep it on screen.
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) })
    el.querySelector('button')?.focus()
    const onDown = (e: MouseEvent) => !el.contains(e.target as Node) && onClose(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const run = (fn: () => void) => {
    onClose(true)
    fn()
  }
  const save = (s: Settings) => api.settings.set(s).then(onState, onError)
  const duplicate = () => {
    const s = structuredClone(app.settings)
    const name = t('bots.panel.copyName', { name: bot.name })
    const at = s.bots.findIndex((b) => b.id === bot.id)
    s.bots.splice(at + 1, 0, {
      ...structuredClone(bot),
      id: newBotId(
        name,
        s.bots.map((b) => b.id),
      ),
      name,
    })
    void save(s)
  }
  const remove = () => {
    if (!confirm(t('bots.panel.confirmDelete', { name: bot.name }))) return
    const s = structuredClone(app.settings)
    s.bots = s.bots.filter((b) => b.id !== bot.id)
    void save(s)
  }

  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onClose(true))
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Tab') onClose(false)
  }

  return (
    <div className="menu bot-menu" role="menu" aria-label={bot.name} ref={ref} style={{ left: pos.left, top: pos.top }} onKeyDown={onKey}>
      <button role="menuitem" disabled={!bot.enabled} onClick={() => run(() => (onChat(), api.bots.newThread(bot.id).then(onState, onError)))}>
        {t('bots.newConversation')}
      </button>
      <button role="menuitem" onClick={() => run(() => onEditBot(bot.id))}>
        {t('bots.panel.edit')}
      </button>
      <button role="menuitem" onClick={() => run(duplicate)}>
        {t('bots.panel.duplicate')}
      </button>
      <button role="menuitem" onClick={() => run(() => void save(withBot(app, bot.id, (b) => ({ ...b, muted: !b.muted }))))}>
        {bot.muted ? t('bots.panel.unmute') : t('bots.panel.muteOne')}
      </button>
      <button role="menuitem" onClick={() => run(() => void save(withBot(app, bot.id, (b) => ({ ...b, enabled: !b.enabled }))))}>
        {bot.enabled ? t('bots.panel.turnOff') : t('bots.panel.turnOn')}
      </button>
      <button role="menuitem" className="danger" onClick={() => run(remove)}>
        {t('bots.panel.delete')}
      </button>
    </div>
  )
}

type Lobby = Settings['lobbies'][number]

const EMPTY_LOBBY: LobbyRow = { id: '', sessionId: null, preview: '', updatedAt: 0, unread: false, running: false }

/** The Bots tab's group chats: each row shows its members' faces and the last line said. */
function LobbiesSection({
  app,
  onState,
  onError,
  onEditLobby,
  onChat,
  settingsOpen,
}: {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onEditLobby: (id?: string) => void
  onChat: () => void
  settingsOpen: boolean
}) {
  const { t } = useT()
  const since = useFormat().ago
  const lobbies = shownLobbies(app.settings)
  const rows = new Map(app.lobbies.map((r) => [r.id, r]))
  const current = app.session?.meta.lobbyId
  const enough = app.settings.bots.filter((b) => b.enabled).length >= 2
  const [menu, setMenu] = useState<{ lobby: Lobby; x: number; y: number; opener: HTMLElement | null } | null>(null)
  const open = (l: Lobby) => {
    onChat()
    api.lobbies.open(l.id).then(onState, onError)
  }

  return (
    <section className="lobbies" aria-labelledby="lobbies-title">
      <div className="bots-head">
        <h2 className="bots-title" id="lobbies-title">
          {t('bots.lobbies.title')}
        </h2>
        <button
          className="icon-btn"
          aria-label={t('bots.lobbies.new')}
          title={enough ? t('bots.lobbies.new') : t('bots.lobbies.needTwo')}
          disabled={!enough}
          onClick={() => onEditLobby()}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {lobbies.length === 0 ? (
        <div className="lobbies-empty">
          <p className="muted small">{enough ? t('bots.lobbies.empty') : t('bots.lobbies.emptyOneBot')}</p>
          {enough && (
            <button className="btn" onClick={() => onEditLobby()}>
              {t('bots.lobbies.new')}
            </button>
          )}
        </div>
      ) : (
        <ul className="bot-rows" aria-label={t('bots.lobbies.title')}>
          {lobbies.map((l) => {
            const row = rows.get(l.id) ?? EMPTY_LOBBY
            const members = lobbyBots(app.settings, l)
            const active = current === l.id && !settingsOpen
            const names = members.map((b) => b.name || t('bots.botName')).join(', ')
            const preview = row.running ? t('bots.lobbies.talking') : row.preview || names || t('bots.lobbies.noMembers')
            const openMenu = (x: number, y: number, opener: HTMLElement | null) => setMenu({ lobby: l, x, y, opener })
            return (
              <li key={l.id} className={`bot-row lobby-row ${active ? 'active' : ''} ${row.unread ? 'unread' : ''}`}>
                <button
                  className="bot-row-open"
                  aria-current={active ? 'page' : undefined}
                  aria-label={[l.name || t('bots.lobbyName'), names ? t('bots.lobbies.with', { names }) : t('bots.lobbies.withNoOne'), row.running ? t('bots.lobbies.talkingNow') : '', row.unread ? t('bots.lobbies.newReplies') : '', row.preview].filter(Boolean).join('. ')}
                  onClick={() => open(l)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openMenu(e.clientX, e.clientY, e.currentTarget)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault()
                      const r = e.currentTarget.getBoundingClientRect()
                      openMenu(r.left + 24, r.bottom - 6, e.currentTarget)
                    }
                  }}
                >
                  <span className="bot-row-face lobby-row-faces">
                    <StackedFaces app={app} bots={members} size={22} max={3} moods={row.running ? Object.fromEntries(members.map((b) => [b.id, 'thinking' as const])) : undefined} />
                  </span>
                  <span className="bot-row-text">
                    <span className="bot-row-top">
                      <span className="bot-row-name">{l.name || t('bots.lobbyName')}</span>
                      <span className="bot-row-time">{row.updatedAt ? since(row.updatedAt) : ''}</span>
                    </span>
                    <span className="bot-row-bottom">
                      <span className="bot-row-preview">{preview}</span>
                      {row.unread && <span className="bot-unread" aria-hidden />}
                    </span>
                  </span>
                </button>
                <button
                  className="bot-row-more"
                  aria-label={t('bots.panel.moreFor', { name: l.name })}
                  aria-haspopup="menu"
                  aria-expanded={menu?.lobby.id === l.id}
                  title={t('bots.panel.more')}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    openMenu(r.left, r.bottom + 2, e.currentTarget)
                  }}
                >
                  ⋯
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {menu && (
        <LobbyMenu
          app={app}
          lobby={menu.lobby}
          x={menu.x}
          y={menu.y}
          onClose={(refocus) => {
            const opener = menu.opener
            setMenu(null)
            if (refocus) opener?.focus()
          }}
          onOpen={() => open(menu.lobby)}
          onState={onState}
          onError={onError}
          onEditLobby={onEditLobby}
        />
      )}
    </section>
  )
}

/** Right-click (or ⋯) menu on a lobby row. */
function LobbyMenu({
  app,
  lobby,
  x,
  y,
  onClose,
  onOpen,
  onState,
  onError,
  onEditLobby,
}: {
  app: AppState
  lobby: Lobby
  x: number
  y: number
  onClose: (refocus: boolean) => void
  onOpen: () => void
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onEditLobby: (id?: string) => void
}) {
  const { t } = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) })
    el.querySelector('button')?.focus()
    const onDown = (e: MouseEvent) => !el.contains(e.target as Node) && onClose(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const run = (fn: () => void) => {
    onClose(true)
    fn()
  }
  const remove = () => {
    if (!confirm(t('bots.lobbies.confirmDelete', { name: lobby.name }))) return
    const s = structuredClone(app.settings)
    s.lobbies = s.lobbies.filter((l) => l.id !== lobby.id)
    api.settings.set(s).then(onState, onError)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onClose(true))
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Tab') onClose(false)
  }

  return (
    <div className="menu bot-menu" role="menu" aria-label={lobby.name} ref={ref} style={{ left: pos.left, top: pos.top }} onKeyDown={onKey}>
      <button role="menuitem" onClick={() => run(onOpen)}>
        {t('common.open')}
      </button>
      <button role="menuitem" onClick={() => run(() => onEditLobby(lobby.id))}>
        {t('bots.lobbies.editMembers')}
      </button>
      <button role="menuitem" className="danger" onClick={() => run(remove)}>
        {t('bots.panel.delete')}
      </button>
    </div>
  )
}
