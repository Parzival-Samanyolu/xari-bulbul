import type { Bot, Settings } from '../settings/schema.js'
import type { ModelRef, PermissionMode } from '../types.js'

// Bots are saved agents with a persona (Settings › Bots). Everything here is pure, so the
// renderer can import it too (`@harness/core/bots`).

type BotSettings = Pick<Settings, 'bots' | 'experimental'>

/**
 * The bot a chat runs as. Undefined for chats without one, and whenever the feature is off or
 * the bot was turned off or deleted: those chats then behave like plain chats.
 */
export function activeBot(settings: BotSettings, botId: string | undefined): Bot | undefined {
  if (!botId || !settings.experimental.bots) return undefined
  const bot = settings.bots.find((b) => b.id === botId)
  return bot?.enabled ? bot : undefined
}

/** The bot a chat was started with, even if it's turned off now (null when the feature is off or it was deleted). */
export function chatBot(settings: BotSettings, botId: string | undefined): Bot | null {
  if (!botId || !settings.experimental.bots) return null
  return settings.bots.find((b) => b.id === botId) ?? null
}

/** Bots to show in the sidebar: none while the feature is off. */
export function shownBots(settings: BotSettings): Bot[] {
  return settings.experimental.bots ? settings.bots.filter((b) => b.enabled) : []
}

/** What a new chat starts with: the bot's model and mode when it has them, else the given defaults. */
export function chatDefaults(settings: BotSettings, botId: string | undefined, fallback: { model: ModelRef; mode: PermissionMode }): { model: ModelRef; mode: PermissionMode } {
  const bot = activeBot(settings, botId)
  return { model: bot?.model ?? fallback.model, mode: bot?.mode ?? fallback.mode }
}

/** Tools every bot keeps; `memory` and `skills` decide about them instead of `tools`. */
export const BOT_ALWAYS_TOOLS = ['remember', 'forget', 'skill']

function allowed(patterns: string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name))
}

/** The tools a bot may use. No bot, or `tools: 'all'`, keeps them all. */
export function filterBotTools<T extends { name: string }>(tools: T[], bot: Bot | undefined): T[] {
  if (!bot || bot.tools === 'all') return tools
  const list = bot.tools
  return tools.filter((t) => BOT_ALWAYS_TOOLS.includes(t.name) || allowed(list, t.name))
}

/** The skills a bot may load. No bot, or no `skills` list, keeps them all. */
export function filterBotSkills<T extends { name: string }>(skills: T[], bot: Bot | undefined): T[] {
  if (!bot?.skills) return skills
  const list = bot.skills
  return skills.filter((s) => list.includes(s.name))
}

/** A fresh id for a new or copied bot, unique among `taken`. */
export function newBotId(name: string, taken: string[]): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** An avatar that names an image file rather than an emoji. */
export function isImageAvatar(avatar: string): boolean {
  return /[\\/]/.test(avatar) && /\.(png|jpe?g|gif|webp)$/i.test(avatar)
}
