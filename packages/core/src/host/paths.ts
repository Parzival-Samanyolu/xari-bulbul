import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionMeta, SessionStore } from '../sessions/store.js'
import { parseSettings, type Settings } from '../settings/schema.js'

/** The app name Electron uses for its userData folder; desktop and terminal share it. */
export const APP_DIR_NAME = 'Xarı Bülbül'

/**
 * Where settings, sessions, usage and memory live. Same folder as the desktop app's userData,
 * so both front ends see the same chats and settings. HARNESS_DATA_DIR overrides it.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (env.HARNESS_DATA_DIR) return path.resolve(env.HARNESS_DATA_DIR).normalize('NFC')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_DIR_NAME)
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR_NAME)
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR_NAME)
}

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'settings.json')
}

/** Reads settings.json; a missing or corrupt file yields defaults (section by section). */
export function loadSettingsFile(dataDir: string): Settings {
  try {
    return parseSettings(JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8')))
  } catch {
    return parseSettings({})
  }
}

/** Writes settings.json atomically so a crash never leaves half a file. */
export function saveSettingsFile(dataDir: string, settings: Settings): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const target = settingsPath(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
  fs.renameSync(tmp, target)
}

/** `openrouter` → `OPENROUTER_API_KEY`, `ollama-cloud` → `OLLAMA_CLOUD_API_KEY`. */
export function envKeyName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

export function envKey(providerId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[envKeyName(providerId)]?.trim() || undefined
}

/** The most recently updated chat in a folder, for `--continue`. */
export function latestSession(store: SessionStore, cwd: string): SessionMeta | undefined {
  return store.list({ cwd })[0]
}
