import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AppState, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { ago, modelLabel } from '../lib/format'
import type { BotMood } from './BotFace'
import { BotAvatar, botColor } from './Bots'

type Bot = Settings['bots'][number]

/**
 * How a bot's face moves in the chat on screen: thinking while it works, talking while text
 * streams, a short hop when a reply finishes, idle otherwise. Switching chats never hops.
 */
export function useBotMood(sessionId: string | undefined, running: boolean, talking: boolean): BotMood {
  const [hop, setHop] = useState(false)
  const was = useRef({ id: sessionId, running })
  useEffect(() => {
    const prev = was.current
    was.current = { id: sessionId, running }
    if (prev.id !== sessionId || running) return setHop(false)
    if (!prev.running) return
    setHop(true)
    const t = setTimeout(() => setHop(false), 900)
    return () => clearTimeout(t)
  }, [sessionId, running])
  return running ? (talking ? 'talking' : 'thinking') : hop ? 'happy' : 'idle'
}

interface Props {
  app: AppState
  bot: Bot
  /** The chat on screen is working, and whether reply text is streaming. */
  running: boolean
  talking: boolean
  /** Waiting on an approval or a question. */
  awaiting: boolean
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onEditBot: (id?: string) => void
}

/** A bot chat's header: face, name, title and model, what it's doing, New conversation, and a menu with its earlier chats. */
export function BotHeader({ app, bot, running, talking, awaiting, onState, onError, onEditBot }: Props) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = app.session?.meta.id
  const threads = app.bots.find((r) => r.id === bot.id)?.threads ?? []
  // A fresh chat with nothing said yet: a new conversation would be the same.
  const fresh = (app.session?.messages.length ?? 0) === 0
  const mood = useBotMood(current, running, talking)
  const model = app.session?.meta.model
  const state = !bot.enabled ? { kind: 'off', text: 'Turned off' } : awaiting ? { kind: 'awaiting', text: 'Needs you' } : running ? { kind: 'working', text: talking ? 'Typing…' : 'Thinking…' } : null

  const close = (refocus = true) => {
    setMenu(false)
    if (refocus) trigger.current?.focus()
  }
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node) && close(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close())
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Home') (e.preventDefault(), items[0]?.focus())
    else if (e.key === 'End') (e.preventDefault(), items.at(-1)?.focus())
    else if (e.key === 'Tab') close(false)
  }
  const newThread = () => api.bots.newThread(bot.id).then(onState, onError)
  /** Deletes one conversation; deleting the one on screen moves to the next one (or a fresh one). */
  const removeThread = async (t: (typeof threads)[number]) => {
    if (!confirm(`Delete the conversation “${t.title}” with ${bot.name}? This can't be undone.`)) return
    const wasCurrent = t.id === current
    const next = threads.find((x) => x.id !== t.id)
    try {
      onState(await api.sessions.remove(t.id))
      if (wasCurrent) {
        close()
        onState(await (next ? api.sessions.open(next.id) : api.bots.newThread(bot.id)))
      }
    } catch (e) {
      onError(e)
    }
  }

  return (
    <header className={`bot-head ${bot.enabled ? '' : 'off'}`} style={{ '--bot': botColor(bot) } as CSSProperties}>
      <button className="bot-head-face" title={`Edit ${bot.name}`} aria-label={`Edit ${bot.name}`} onClick={() => onEditBot(bot.id)}>
        <BotAvatar app={app} bot={bot} size={36} mood={bot.enabled ? mood : undefined} />
      </button>
      <span className="bot-head-text">
        <span className="bot-head-top">
          <span className="bot-head-name">{bot.name}</span>
          {state && (
            <span className={`bot-head-state ${state.kind}`}>
              <i aria-hidden />
              {state.text}
            </span>
          )}
        </span>
        <span className="bot-head-sub">
          {bot.tagline && <span className="bot-head-tag">{bot.tagline}</span>}
          {model && (
            <span className="bot-head-model" title={`${model.providerId} · ${model.modelId}`}>
              {modelLabel(model.modelId)}
            </span>
          )}
        </span>
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
          <div className="menu bot-head-list" role="menu" aria-label={`${bot.name}: history and options`} ref={menuRef} onKeyDown={onMenuKey}>
            <button role="menuitem" onClick={() => (close(), onEditBot(bot.id))}>
              Edit {bot.name}…
            </button>
            {threads.length > 0 && (
              <div className="menu-label" role="presentation">
                Conversations
              </div>
            )}
            {threads.slice(0, 30).map((t) => (
              <div key={t.id} className="bot-thread-row" role="none">
                <button
                  role="menuitemradio"
                  aria-checked={t.id === current}
                  className={`bot-thread-open ${t.id === current ? 'current' : ''}`}
                  title={t.preview || t.title}
                  onClick={() => {
                    close()
                    if (t.id !== current) api.sessions.open(t.id).then(onState, onError)
                  }}
                >
                  <span className="bot-thread-title">{t.title}</span>
                  <span className="muted small">{ago(t.updatedAt)}</span>
                </button>
                <button role="menuitem" className="bot-thread-delete" aria-label={`Delete conversation “${t.title}”`} title="Delete conversation" onClick={() => removeThread(t)}>
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </span>
    </header>
  )
}
