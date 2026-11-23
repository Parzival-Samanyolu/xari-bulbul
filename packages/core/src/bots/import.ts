import fs from 'node:fs'
import path from 'node:path'
import { loadSettingsFile, settingsPath } from '../host/paths.js'
import { MemoryStore } from '../memory/store.js'
import { parseSettings, type Bot, type Lobby, type Settings } from '../settings/schema.js'
import type { Session } from '../sessions/store.js'
import { hasAvatarFile } from './bots.js'

/**
 * Before the split, bots lived in the coding app. This copies them (and their lobbies, memories,
 * picture avatars and chats) from that app's data folder into another one. The source is only
 * ever read, and anything already in the target is left alone, so running it twice adds nothing.
 */

export interface BotImportPlan {
  bots: Bot[]
  lobbies: Lobby[]
}

const sameDir = (a: string, b: string) => path.resolve(a).normalize('NFC') === path.resolve(b).normalize('NFC')

/** True when `file` is inside `dir` (compared in NFC, as macOS may hand back another Unicode form). */
function inside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir).normalize('NFC'), path.resolve(file).normalize('NFC'))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Settings of a data folder that has a settings.json, or null (a missing file would read as defaults). */
function readSource(sourceDir: string): Settings | null {
  if (!fs.existsSync(settingsPath(sourceDir))) return null
  return loadSettingsFile(sourceDir)
}

/** What an import would add: bots and lobbies of the source whose ids the target doesn't have yet. */
export function planBotImport(sourceDir: string, targetDir: string, current: Settings): BotImportPlan {
  if (sameDir(sourceDir, targetDir)) return { bots: [], lobbies: [] }
  const source = readSource(sourceDir)
  if (!source) return { bots: [], lobbies: [] }
  const botIds = new Set(current.bots.map((b) => b.id))
  const lobbyIds = new Set(current.lobbies.map((l) => l.id))
  return {
    bots: source.bots.filter((b) => !botIds.has(b.id)),
    lobbies: source.lobbies.filter((l) => !lobbyIds.has(l.id)),
  }
}

/** The session files to copy: chats with an imported bot, and the transcripts of imported lobbies. */
export function wantedSession(meta: { botId?: string; lobbyId?: string }, botIds: Set<string>, lobbyIds: Set<string>): boolean {
  return (!!meta.botId && botIds.has(meta.botId)) || (!!meta.lobbyId && lobbyIds.has(meta.lobbyId))
}

/**
 * Copies a picture avatar that lives in the source folder into `<target>/bots/` and returns the bot
 * with the new path. Pictures kept elsewhere on disk keep working as they are.
 */
function carryAvatar(bot: Bot, sourceDir: string, targetDir: string): Bot {
  if (!hasAvatarFile(bot.avatar) || !bot.avatar.image || !inside(sourceDir, bot.avatar.image) || !fs.existsSync(bot.avatar.image)) return bot
  const dir = path.join(targetDir, 'bots')
  fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(bot.avatar.image)
  const base = path.basename(bot.avatar.image, ext)
  const data = fs.readFileSync(bot.avatar.image)
  // The same name with other contents is some other picture: keep both.
  let target = path.join(dir, base + ext)
  for (let n = 2; fs.existsSync(target) && !fs.readFileSync(target).equals(data); n++) target = path.join(dir, `${base}-${n}${ext}`)
  if (!fs.existsSync(target)) fs.writeFileSync(target, data)
  return { ...bot, avatar: { ...bot.avatar, image: target } }
}

/** A bot's own memory file, copied unless the target already has one for that id. */
function carryMemory(botId: string, sourceDir: string, targetDir: string): void {
  const from = new MemoryStore(path.join(sourceDir, 'memory')).file('bot', botId)
  const to = new MemoryStore(path.join(targetDir, 'memory')).file('bot', botId)
  if (!fs.existsSync(from) || fs.existsSync(to)) return
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

/** Copies the matching chats; returns how many were new. */
function carrySessions(sourceDir: string, targetDir: string, botIds: Set<string>, lobbyIds: Set<string>): number {
  const from = path.join(sourceDir, 'sessions')
  const to = path.join(targetDir, 'sessions')
  let names: string[]
  try {
    names = fs.readdirSync(from)
  } catch {
    return 0
  }
  let copied = 0
  for (const name of names) {
    if (!/^[\w-]+\.json$/.test(name)) continue
    const target = path.join(to, name)
    if (fs.existsSync(target)) continue
    try {
      const raw = fs.readFileSync(path.join(from, name), 'utf8')
      if (!wantedSession((JSON.parse(raw) as Session).meta ?? {}, botIds, lobbyIds)) continue
      fs.mkdirSync(to, { recursive: true })
      // Atomic like SessionStore.save, so a crash never leaves half a chat.
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, raw)
      fs.renameSync(tmp, target)
      copied++
    } catch {
      /* corrupt chat: skip it */
    }
  }
  return copied
}

export interface BotImportResult {
  /** The target's settings with the imported bots and lobbies added; the caller saves them. */
  settings: Settings
  bots: number
  lobbies: number
  chats: number
}

/**
 * Copies the files first and returns the new settings for the caller to save last: if something
 * fails halfway, the bots are still missing from settings and a second run does the rest.
 */
export function importBots(sourceDir: string, targetDir: string, current: Settings): BotImportResult {
  const plan = planBotImport(sourceDir, targetDir, current)
  const source = readSource(sourceDir)
  if (!source || (!plan.bots.length && !plan.lobbies.length)) return { settings: current, bots: 0, lobbies: 0, chats: 0 }
  const botIds = new Set(plan.bots.map((b) => b.id))
  const lobbyIds = new Set(plan.lobbies.map((l) => l.id))
  const bots = plan.bots.map((b) => carryAvatar(b, sourceDir, targetDir))
  for (const id of botIds) carryMemory(id, sourceDir, targetDir)
  const chats = carrySessions(sourceDir, targetDir, botIds, lobbyIds)
  // Bot options come along only while the target still has its defaults, so a rerun never undoes the user's choices.
  const untouched = JSON.stringify(current.botOptions) === JSON.stringify(parseSettings({}).botOptions)
  return {
    settings: { ...current, bots: [...current.bots, ...bots], lobbies: [...current.lobbies, ...plan.lobbies], botOptions: untouched ? source.botOptions : current.botOptions },
    bots: bots.length,
    lobbies: plan.lobbies.length,
    chats,
  }
}
