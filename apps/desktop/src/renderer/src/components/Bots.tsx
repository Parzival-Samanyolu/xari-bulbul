import { botFace } from '@harness/core/bots'
import type { AppState, Settings } from '../../../shared/ipc'
import { BotFaceView } from './BotFace'

type Bot = Settings['bots'][number]

/** A bot's face. Decorative: the name is always shown or announced next to it. */
export function BotAvatar({ app, bot, size = 28 }: { app: AppState; bot: Bot; size?: number }) {
  return <BotFaceView face={botFace(bot.name, bot.avatar)} size={size} image={app.botAvatars[bot.id]} fallback={bot.name.trim().charAt(0).toUpperCase()} />
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
