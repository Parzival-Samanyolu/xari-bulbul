import type { CSSProperties } from 'react'
import { botFace, DEFAULT_BOT_COLOR } from '@harness/core/bots'
import type { AppState, Settings } from '../../../shared/ipc'
import { BotFaceView, type BotMood } from './BotFace'

type Bot = Settings['bots'][number]

/** A bot's face. Decorative: the name is always shown or announced next to it. */
export function BotAvatar({ app, bot, size = 28, mood }: { app: AppState; bot: Bot; size?: number; mood?: BotMood }) {
  return <BotFaceView face={botFace(bot.name, bot.avatar)} size={size} image={app.botAvatars[bot.id]} fallback={bot.name.trim().charAt(0).toUpperCase()} mood={mood} />
}

/** The bot's color, for its header and selection accents. */
export const botColor = (bot: Bot) => botFace(bot.name, bot.avatar).color

/** Settings with one bot changed. */
export function withBot(app: AppState, id: string, fn: (b: Bot) => Bot): Settings {
  const s = structuredClone(app.settings)
  s.bots = s.bots.map((b) => (b.id === id ? fn(b) : b))
  return s
}

/** Turns a bot on again from one of its chats. */
export const turnOnBot = (app: AppState, id: string): Settings => withBot(app, id, (b) => ({ ...b, enabled: true }))

/** A speaker's face in a lobby: the bot's, or one from the name it had if it was deleted since. */
export function SpeakerAvatar({ app, botId, name, size = 22, mood }: { app: AppState; botId: string; name: string; size?: number; mood?: BotMood }) {
  const bot = app.settings.bots.find((b) => b.id === botId)
  if (bot) return <BotAvatar app={app} bot={bot} size={size} mood={mood} />
  return <BotFaceView face={botFace(name, { kind: 'shape', color: DEFAULT_BOT_COLOR, locked: false })} size={size} fallback={name.charAt(0).toUpperCase()} />
}

/** A speaker's color: the bot's, or the one its old name gives. */
export function speakerColor(app: AppState, botId: string, name: string): string {
  const bot = app.settings.bots.find((b) => b.id === botId)
  return bot ? botColor(bot) : botFace(name, { kind: 'shape', color: DEFAULT_BOT_COLOR, locked: false }).color
}

/** A lobby's members as overlapping faces. Decorative: the names are said next to them. */
export function StackedFaces({ app, bots, size = 22, max = 4, moods }: { app: AppState; bots: Bot[]; size?: number; max?: number; moods?: Record<string, BotMood> }) {
  const shown = bots.slice(0, max)
  const more = bots.length - shown.length
  return (
    <span className="stacked-faces" aria-hidden style={{ '--face': `${size}px` } as CSSProperties}>
      {shown.map((b) => (
        <span key={b.id} className={`stacked-face ${b.enabled ? '' : 'off'}`}>
          <BotAvatar app={app} bot={b} size={size} mood={moods?.[b.id]} />
        </span>
      ))}
      {more > 0 && <span className="stacked-more">+{more}</span>}
    </span>
  )
}
