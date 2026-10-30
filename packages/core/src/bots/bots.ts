import type { Bot, BotAvatar, Settings } from '../settings/schema.js'
import type { ChatMessage, ModelRef, PermissionMode } from '../types.js'
import { faceForName, type BotPet, type BotShape } from './faces.js'

export * from './faces.js'

// Bots are characters to chat with (the sidebar's Bots tab). Everything here is pure, so the
// renderer can import it too (`@harness/core/bots`).

type BotSettings = Pick<Settings, 'bots' | 'botOptions'>

/**
 * The bot a chat runs as. Undefined for chats without one, and whenever the feature is off or
 * the bot was turned off or deleted: those chats then behave like plain chats.
 */
export function activeBot(settings: BotSettings, botId: string | undefined): Bot | undefined {
  if (!botId || !settings.botOptions.enabled) return undefined
  const bot = settings.bots.find((b) => b.id === botId)
  return bot?.enabled ? bot : undefined
}

/** The bot a chat was started with, even if it's turned off now (null when the feature is off or it was deleted). */
export function chatBot(settings: BotSettings, botId: string | undefined): Bot | null {
  if (!botId || !settings.botOptions.enabled) return null
  return settings.bots.find((b) => b.id === botId) ?? null
}

/** Bots in the Bots tab (turned-off ones too, dimmed): none while the tab is off. */
export function shownBots(settings: BotSettings): Bot[] {
  return settings.botOptions.enabled ? settings.bots : []
}

/** A chat that belongs in the Bots tab instead of the Sessions list: the tab is on and its bot still exists. */
export function isBotChat(settings: BotSettings, meta: { botId?: string }): boolean {
  return !!chatBot(settings, meta.botId)
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

/** An avatar path that names an image file. */
export function isImageAvatar(avatar: string): boolean {
  return /[\\/]/.test(avatar) && /\.(png|jpe?g|gif|webp)$/i.test(avatar)
}

/** What a face looks like on screen. */
export type BotFace =
  | { kind: 'shape'; shape: BotShape; color: string }
  | { kind: 'pet'; pet: BotPet; color: string }
  | { kind: 'image'; image: string; color: string }
  | { kind: 'emoji'; emoji: string; color: string }

/**
 * The face to draw for a name and avatar. Unless locked, a shape face takes its shape and color
 * from the name, and an animal its color, so the face follows the name as it's typed.
 */
export function botFace(name: string, avatar: BotAvatar): BotFace {
  const auto = faceForName(name)
  const color = avatar.locked ? avatar.color : auto.color
  if (avatar.kind === 'pet') return { kind: 'pet', pet: avatar.pet ?? 'cat', color }
  if (avatar.kind === 'image' && avatar.image) return { kind: 'image', image: avatar.image, color: avatar.color }
  if (avatar.kind === 'emoji' && avatar.emoji) return { kind: 'emoji', emoji: avatar.emoji, color: avatar.color }
  return { kind: 'shape', shape: avatar.locked ? (avatar.shape ?? auto.shape) : auto.shape, color }
}

/** A new bot: a face from its name, every tool, full auto, its own memory. */
export function newBot(name: string, taken: string[]): Bot {
  const face = faceForName(name)
  return {
    id: newBotId(name, taken),
    enabled: true,
    name,
    avatar: { kind: 'shape', shape: face.shape, color: face.color, locked: false },
    tagline: '',
    persona: '',
    mode: 'auto',
    tools: 'all',
    memory: 'own',
    muted: false,
    cwd: null,
  }
}

// ---------------------------------------------------------------- threads

/** A bot's chats, newest first. */
export function botThreads<T extends { botId?: string; updatedAt: number }>(metas: T[], botId: string): T[] {
  return metas.filter((m) => m.botId === botId).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The chat a bot opens to: its most recently active one. */
export function latestBotThread<T extends { botId?: string; updatedAt: number }>(metas: T[], botId: string): T | undefined {
  return botThreads(metas, botId)[0]
}

/** One line of the last thing said in a chat, for the Bots tab (synthetic notes and tool output skipped). */
export function chatPreview(messages: ChatMessage[], max = 100): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool' || m.role === 'system' || (m.role === 'user' && m.synthetic)) continue
    const line = m.content.replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim()
    if (!line) continue
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return ''
}
