import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AppState, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { BotAvatar, botColor } from './Bots'

type Bot = Settings['bots'][number]

interface Props {
  app: AppState
  bot: Bot
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onEditBot: (id?: string) => void
}

/** A bot chat's header: face, name and title, New conversation, and a menu with its earlier chats. */
export function BotHeader({ app, bot, onState, onError, onEditBot }: Props) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = app.session?.meta.id
  const threads = app.bots.find((r) => r.id === bot.id)?.threads ?? []
  // A fresh chat with nothing said yet: a new conversation would be the same.
  const fresh = (app.session?.messages.length ?? 0) === 0

  const close = (refocus = true) => {
    setMenu(false)
    if (refocus) trigger.current?.focus()
  }
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && e.target !== trigger.current && close(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close())
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Tab') close(false)
  }
  const newThread = () => api.bots.newThread(bot.id).then(onState, onError)

  return (
    <header className="bot-head" style={{ '--bot': botColor(bot) } as CSSProperties}>
      <BotAvatar app={app} bot={bot} size={30} />
      <span className="bot-head-text">
        <span className="bot-head-name">{bot.name}</span>
        {bot.tagline && <span className="muted small bot-head-tag">{bot.tagline}</span>}
      </span>
      {bot.enabled && (
        <button
          className="btn ghost bot-head-new"
          disabled={fresh}
          title={fresh ? 'This conversation is new' : 'Start a fresh conversation; this one stays in the history'}
          onClick={newThread}
        >
          New conversation
        </button>
      )}
      <span className="bot-head-more">
        <button
          ref={trigger}
          className="icon-btn bot-head-menu"
          aria-label={`${bot.name}: history and options`}
          aria-haspopup="menu"
          aria-expanded={menu}
          title="History and options"
          onClick={() => setMenu((m) => !m)}
        >
          ⋯
        </button>
        {menu && (
          <div className="menu bot-head-list" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
            <button role="menuitem" onClick={() => (close(), onEditBot(bot.id))}>
              Edit {bot.name}…
            </button>
            {threads.length > 0 && (
              <div className="menu-label" role="presentation">
                Conversations
              </div>
            )}
            {threads.slice(0, 12).map((t) => (
              <button
                key={t.id}
                role="menuitemradio"
                aria-checked={t.id === current}
                className={t.id === current ? 'current' : ''}
                title={t.preview || t.title}
                onClick={() => {
                  close()
                  if (t.id !== current) api.sessions.open(t.id).then(onState, onError)
                }}
              >
                <span className="bot-thread-title">{t.title}</span>
                <span className="muted small">{ago(t.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </span>
    </header>
  )
}
