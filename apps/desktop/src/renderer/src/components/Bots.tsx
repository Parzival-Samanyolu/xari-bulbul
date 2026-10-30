import type { CSSProperties } from 'react'
import { isImageAvatar } from '@harness/core/bots'
import type { AppState, Settings } from '../../../shared/ipc'

type Bot = Settings['bots'][number]

/** A bot's emoji or picture on a disc of its color. Decorative: the name is always shown or announced next to it. */
export function BotAvatar({ app, bot, size = 28 }: { app: AppState; bot: Bot; size?: number }) {
  const image = isImageAvatar(bot.avatar) ? app.botAvatars[bot.id] : undefined
  const style = { '--bot': bot.color, width: size, height: size, fontSize: Math.round(size * 0.55) } as CSSProperties
  return (
    <span className="bot-avatar" style={style} aria-hidden>
      {image ? <img src={image} alt="" /> : isImageAvatar(bot.avatar) ? bot.name.trim().charAt(0).toUpperCase() || '?' : bot.avatar || bot.name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/** Turns a bot on again from one of its chats. */
export function turnOnBot(app: AppState, id: string): Settings {
  const s = structuredClone(app.settings)
  s.bots = s.bots.map((b) => (b.id === id ? { ...b, enabled: true } : b))
  return s
}
