import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { lobbyBots } from '@harness/core/bots'
import type { AppState, ChatMessage } from '../../../shared/ipc'
import type { LiveState } from '../App'
import { api } from '../lib/api'
import { Markdown } from '../lib/Markdown'
import type { BotMood } from './BotFace'
import { BotAvatar, SpeakerAvatar, speakerColor, StackedFaces } from './Bots'

type Bot = AppState['settings']['bots'][number]

interface Props {
  app: AppState
  live: LiveState
  onDismiss: (id: number) => void
  onError: (e: unknown) => void
  onEditLobby: (id?: string) => void
  onSettings: (tab: string) => void
}

/** "Ali", "Ali and Bea", "Ali, Bea and Cem". */
function names(bots: Bot[]): string {
  const list = bots.map((b) => b.name || 'Bot')
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/** A lobby's group chat: the members up top, then everyone's lines, each with its speaker. */
export function LobbyView({ app, live, onDismiss, onError, onEditLobby, onSettings }: Props) {
  const session = app.session!
  const lobby = app.settings.lobbies.find((l) => l.id === session.meta.lobbyId)
  const members = lobby ? lobbyBots(app.settings, lobby) : []
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [more, setMore] = useState(false)

  const onScroll = () => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    stick.current = true
  }, [session.meta.id])

  const running = app.running
  const speakerId = running ? live.speaker : null
  const speaker = speakerId ? app.settings.bots.find((b) => b.id === speakerId) : undefined
  const talking = running && !!live.streamText
  const moods: Record<string, BotMood> = Object.fromEntries(members.filter((b) => b.enabled).map((b) => [b.id, b.id === speakerId ? (talking ? 'talking' : 'thinking') : 'idle']))
  const lines = session.messages.filter((m) => (m.role === 'user' && !m.synthetic) || (m.role === 'assistant' && m.content.trim()))
  const quiet = members.filter((b) => b.enabled).length === 0
  const status = speaker ? `${speaker.name} is ${talking ? 'typing' : 'thinking'}…` : running ? 'Thinking…' : ''

  const keepTalking = () => {
    setMore(true)
    stick.current = true
    api.lobbies
      .keepTalking()
      .catch(onError)
      .finally(() => setMore(false))
  }

  return (
    <div className="chat bot-chat lobby-chat" ref={scroller} onScroll={onScroll}>
      <div className="sr-only" aria-live="polite">
        {status}
      </div>
      <header className="bot-head lobby-head">
        <span className="lobby-head-faces">
          <StackedFaces app={app} bots={members} size={30} max={6} moods={moods} />
        </span>
        <span className="bot-head-text">
          <span className="bot-head-top">
            <span className="bot-head-name">{lobby?.name ?? session.meta.title}</span>
            {running && (
              <span className="bot-head-state working">
                <i aria-hidden />
                {speaker ? `${speaker.name} is ${talking ? 'typing' : 'thinking'}…` : 'Talking…'}
              </span>
            )}
          </span>
          <span className="bot-head-sub">
            <span className="bot-head-tag">{members.length ? `With ${names(members)}` : 'No members'}</span>
          </span>
        </span>
        {lobby && (
          <button className="btn ghost" onClick={() => onEditLobby(lobby.id)} aria-label={`Edit ${lobby.name}`} title="Rename, change members or how long they talk">
            Edit
          </button>
        )}
      </header>

      <div className="chat-inner">
        {!lobby && (
          <div className="notice notice-warn" role="status">
            <span>This lobby was deleted or the Bots tab is off, so nobody here can reply.</span>
          </div>
        )}
        {lobby && quiet && (
          <div className="notice notice-warn" role="status">
            <span>Every bot in this lobby is turned off. Turn one on, or change the members.</span>
            <button className="btn" onClick={() => onEditLobby(lobby.id)}>
              Change members
            </button>
          </div>
        )}
        {lines.length === 0 && !running && lobby && (
          <div className="bot-intro lobby-intro">
            <StackedFaces app={app} bots={members} size={56} max={6} moods={moods} />
            <h2>{lobby.name}</h2>
            <p className="bot-intro-tag">With {names(members)}</p>
            <p className="muted small">Say something to start. Everyone answers in turn; @name a bot to ask it first.</p>
          </div>
        )}
        {lines.map((m, i) => (
          <Line key={i} app={app} message={m} />
        ))}
        {running && speaker && (
          <div className="lobby-line" style={{ '--bot': speakerColor(app, speaker.id, speaker.name) } as CSSProperties}>
            <div className="bot-speaker lobby-speaker" aria-hidden>
              <BotAvatar app={app} bot={speaker} size={22} mood={talking ? 'talking' : 'thinking'} />
              <span>{speaker.name}</span>
            </div>
            <div className="assistant live">
              {live.streamText ? (
                <Markdown text={live.streamText} />
              ) : (
                <div className="thinking">
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {speaker.name} is thinking…
                </div>
              )}
            </div>
          </div>
        )}
        {!running && lobby && !quiet && lines.length > 0 && (
          <div className="lobby-more">
            <button className="btn" onClick={keepTalking} disabled={more}>
              Keep talking
            </button>
            <span className="muted small">The bots react to each other for up to {Math.max(1, lobby.maxRounds)} more {Math.max(1, lobby.maxRounds) === 1 ? 'round' : 'rounds'}.</span>
          </div>
        )}
        {live.notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
            <span>{n.text}</span>
            {n.fix === 'providers' && (
              <button className="btn" onClick={() => onSettings('providers.keys')}>
                Open API keys
              </button>
            )}
            <button className="notice-close" aria-label="Dismiss" onClick={() => onDismiss(n.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One line of the group chat: yours on the right, a bot's with its face and name in its color. */
const Line = memo(function Line({ app, message: m }: { app: AppState; message: ChatMessage }) {
  if (m.role === 'user')
    return (
      <div className="user-turn">
        <div className="user-row">
          <div className="user">{m.content}</div>
        </div>
      </div>
    )
  if (m.role !== 'assistant') return null
  const id = m.speaker?.id ?? ''
  const name = app.settings.bots.find((b) => b.id === id)?.name || m.speaker?.name || 'Bot'
  return (
    <div className="lobby-line" style={{ '--bot': speakerColor(app, id, name) } as CSSProperties}>
      <div className="bot-speaker lobby-speaker">
        <SpeakerAvatar app={app} botId={id} name={name} size={22} />
        <span>{name}</span>
      </div>
      <div className="assistant">
        <Markdown text={m.content} />
      </div>
    </div>
  )
})
