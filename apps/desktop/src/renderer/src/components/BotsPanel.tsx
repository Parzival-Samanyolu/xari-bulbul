import { useEffect, useRef, useState } from 'react'
import { newBotId, shownBots } from '@harness/core/bots'
import type { AppState, BotRow, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { BotFaceView } from './BotFace'
import { BotAvatar, withBot } from './Bots'

type Bot = Settings['bots'][number]

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  /** Opens the bot dialog: a bot's id to edit it, nothing for a new one. */
  onEditBot: (id?: string) => void
  /** Called before a bot chat opens (closes Settings). */
  onChat: () => void
  settingsOpen: boolean
}

/** "now", "5m", "3h", "2d", "4w": the time since a bot's last message. */
function since(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 7))}w`
}

const EMPTY_ROW: BotRow = { id: '', threads: [], unread: false, running: false, awaiting: false }

/** The sidebar's Bots tab: one row per bot, like a messaging app. */
export function BotsPanel({ app, onState, onError, onEditBot, onChat, settingsOpen }: Props) {
  const bots = shownBots(app.settings)
  const rows = new Map(app.bots.map((r) => [r.id, r]))
  const muted = app.settings.botOptions.muted
  const currentBot = app.session?.meta.botId
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number; opener: HTMLElement | null } | null>(null)

  const save = (s: Settings) => api.settings.set(s).then(onState, onError)
  const open = (b: Bot) => {
    onChat()
    api.bots.open(b.id).then(onState, onError)
  }

  return (
    <div className="bots-panel">
      <div className="bots-head">
        <h2 className="bots-title">Bots</h2>
        <button
          className="icon-btn"
          aria-pressed={muted}
          aria-label="Mute bot notifications"
          title={muted ? 'Bot notifications are muted' : 'Mute bot notifications'}
          onClick={() => save({ ...app.settings, botOptions: { ...app.settings.botOptions, muted: !muted } })}
        >
          <BellIcon off={muted} />
        </button>
        <button className="icon-btn" aria-label="New bot" title="New bot" onClick={() => onEditBot()}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {bots.length === 0 ? (
        <div className="bots-empty">
          <div className="bots-empty-faces" aria-hidden>
            <BotFaceView face={{ kind: 'shape', shape: 'blob', color: '#d98bb0' }} size={34} />
            <BotFaceView face={{ kind: 'pet', pet: 'cat', color: '#eda26b' }} size={34} />
            <BotFaceView face={{ kind: 'shape', shape: 'ghost', color: '#6cc3a0' }} size={34} />
            <BotFaceView face={{ kind: 'pet', pet: 'frog', color: '#9cbb6a' }} size={34} />
          </div>
          <p className="muted small">Make a character to chat with. It remembers you and can use every tool.</p>
          <button className="btn primary" onClick={() => onEditBot()}>
            Make a bot
          </button>
        </div>
      ) : (
        <ul className="bot-rows" aria-label="Bots">
          {bots.map((b) => {
            const row = rows.get(b.id) ?? EMPTY_ROW
            const last = row.threads[0]
            const active = currentBot === b.id && !settingsOpen
            const status = !b.enabled ? 'off' : row.awaiting ? 'awaiting' : row.running ? 'working' : 'on'
            const statusText = { off: 'Turned off', awaiting: 'Needs you', working: 'Typing…', on: '' }[status]
            const preview = row.running
              ? 'Typing…'
              : row.awaiting
                ? app.questions.some((q) => row.threads.some((t) => t.id === q.sessionId))
                  ? 'Has a question'
                  : 'Needs approval'
                : last?.preview || b.tagline || (b.enabled ? 'Say hi' : 'Turned off')
            const openMenu = (x: number, y: number, opener: HTMLElement | null) => setMenu({ bot: b, x, y, opener })
            return (
              <li key={b.id} className={`bot-row ${active ? 'active' : ''} ${b.enabled ? '' : 'off'} ${row.unread ? 'unread' : ''}`}>
                <button
                  className="bot-row-open"
                  aria-current={active ? 'page' : undefined}
                  aria-label={[b.name, statusText, row.unread ? 'New reply' : '', preview].filter(Boolean).join('. ')}
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
                    <BotAvatar app={app} bot={b} size={34} />
                    <span className={`bot-status ${status}`} aria-hidden />
                  </span>
                  <span className="bot-row-text">
                    <span className="bot-row-top">
                      <span className="bot-row-name">{b.name || 'Bot'}</span>
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
                  aria-label={`More for ${b.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.bot.id === b.id}
                  title="More"
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
      {bots.length > 0 && !app.workspace && <p className="muted small pad">Open a folder in Sessions to chat with a bot: bots work in a folder.</p>}

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
  const size = small ? 11 : 14
  return (
    <svg
      className={small ? 'bot-row-muted' : undefined}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={small ? undefined : true}
      role={small ? 'img' : undefined}
      aria-label={small ? 'Muted' : undefined}
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
    const name = `${bot.name} copy`
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
    if (!confirm(`Delete ${bot.name}? Its chats are kept and move to Sessions as plain chats.`)) return
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
        New conversation
      </button>
      <button role="menuitem" onClick={() => run(() => onEditBot(bot.id))}>
        Edit…
      </button>
      <button role="menuitem" onClick={() => run(duplicate)}>
        Duplicate
      </button>
      <button role="menuitem" onClick={() => run(() => void save(withBot(app, bot.id, (b) => ({ ...b, muted: !b.muted }))))}>
        {bot.muted ? 'Unmute' : 'Mute'}
      </button>
      <button role="menuitem" onClick={() => run(() => void save(withBot(app, bot.id, (b) => ({ ...b, enabled: !b.enabled }))))}>
        {bot.enabled ? 'Turn off' : 'Turn on'}
      </button>
      <button role="menuitem" className="danger" onClick={() => run(remove)}>
        Delete…
      </button>
    </div>
  )
}
