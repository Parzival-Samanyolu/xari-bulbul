import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore, newSession } from '../src/sessions/store.js'
import { defaultSettings, guessProviderApi, parseSettings } from '../src/settings/schema.js'
import { exportSettings, importSettings, resetSettings } from '../src/settings/transfer.js'
import { launchBrowser } from '../src/tools/browser.js'
import { tmpDir } from './helpers.js'

describe('settings defaults', () => {
  it('fills the newer settings in old files', () => {
    const s = parseSettings({ app: { notifications: false }, voice: { engine: 'local' } })
    expect(s.app.notifications).toBe(false)
    expect(s.app.notify).toEqual({ finished: true, failed: true, approval: true, question: true })
    expect(s.app.launchAtLogin).toBe(false)
    expect(s.app.resumeLastChat).toBe(true)
    expect(s.app.keepAwake).toBe('off')
    expect(s.voice).toMatchObject({ engine: 'local', enabled: true, maxRecordingSec: 120, language: '', autoSend: false })
    expect(s.sessions.retentionDays).toBeNull()
    expect(s.memory.autoReview).toBe(true)
    expect(s.tools.browser.keepLogins).toBe(false)
    expect(s.appearance.fontFamily).toBe('')
    expect(s.shortcuts).toEqual({})
  })

  it('guesses the API of a custom endpoint from its URL', () => {
    expect(guessProviderApi('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(guessProviderApi('https://proxy.example.com/v1/messages')).toBe('anthropic')
    expect(guessProviderApi('http://localhost:8000/v1')).toBe('openai')
  })
})

describe('settings import, export and reset', () => {
  function withLocal() {
    const s = defaultSettings()
    s.app.openWorkspaces = ['/work/a']
    s.app.lastWorkspace = '/work/a'
    s.app.recentWorkspaces = ['/work/a']
    s.app.layoutChosen = true
    s.appearance.theme = 'dark'
    s.mcp.servers = [
      { id: 'gh', name: 'gh', enabled: true, transport: 'stdio', command: 'npx', args: ['gh'], env: { GITHUB_TOKEN: 'ghp_secret', REGION: 'eu' } },
      { id: 'web', name: 'web', enabled: true, transport: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer abc', 'X-Workspace': 'main' } },
      { id: 'blender', name: 'blender', enabled: true, transport: 'stdio', command: 'uvx', args: [], env: {}, plugin: 'blender' },
    ]
    return s
  }

  it('exports without folders, plugin servers or secret-looking values', () => {
    const out = exportSettings(withLocal()) as ReturnType<typeof defaultSettings>
    expect(out.app.openWorkspaces).toBeUndefined()
    expect(out.app.lastWorkspace).toBeUndefined()
    expect(out.appearance.theme).toBe('dark')
    expect(out.mcp.servers.map((s) => s.id)).toEqual(['gh', 'web'])
    expect(out.mcp.servers[0]).toMatchObject({ env: { GITHUB_TOKEN: '', REGION: 'eu' } })
    expect(out.mcp.servers[1]).toMatchObject({ headers: { 'X-Workspace': 'main' } })
    expect(JSON.stringify(out)).not.toMatch(/ghp_secret|Bearer abc/)
    // An export imports cleanly.
    expect(importSettings(JSON.parse(JSON.stringify(out)), defaultSettings()).ok).toBe(true)
  })

  it('refuses a file with wrong values and names the fields', () => {
    const r = importSettings({ appearance: { theme: 'purple' }, agent: { maxStepsPerTurn: -1 } }, defaultSettings())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.some((e) => e.startsWith('appearance.theme'))).toBe(true)
    expect(r.errors.some((e) => e.startsWith('agent.maxStepsPerTurn'))).toBe(true)
    expect(importSettings([1, 2], defaultSettings())).toEqual({ ok: false, errors: ['The file is not a settings object.'] })
    // A JSON file with no settings sections would otherwise parse as all defaults.
    expect(importSettings({ name: 'some-package', version: '1.0.0' }, defaultSettings()).ok).toBe(false)
  })

  it('imports onto this machine, keeping its folders and plugin servers', () => {
    const current = withLocal()
    const r = importSettings({ appearance: { theme: 'sepia' }, app: { openWorkspaces: ['/elsewhere'] } }, current)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.appearance.theme).toBe('sepia')
    expect(r.settings.app.openWorkspaces).toEqual(['/work/a'])
    expect(r.settings.mcp.servers.map((s) => s.id)).toEqual(['blender'])
  })

  it('keeps this machine\'s secret MCP values when its own export comes back', () => {
    const current = withLocal()
    const r = importSettings(JSON.parse(JSON.stringify(exportSettings(current))), current)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.mcp.servers.find((s) => s.id === 'gh')).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_secret', REGION: 'eu' } })
    expect(r.settings.mcp.servers.find((s) => s.id === 'web')).toMatchObject({ headers: { Authorization: 'Bearer abc', 'X-Workspace': 'main' } })
  })

  it('resets to defaults but keeps folders and plugin servers', () => {
    const s = resetSettings(withLocal())
    expect(s.appearance.theme).toBe('system')
    expect(s.app.openWorkspaces).toEqual(['/work/a'])
    expect(s.app.layoutChosen).toBe(true)
    expect(s.mcp.servers.map((x) => x.id)).toEqual(['blender'])
  })
})

describe('session retention', () => {
  it('deletes chats older than the cutoff, except kept ones', () => {
    const store = new SessionStore(tmpDir())
    const make = (age: number) => {
      const s = newSession('/p', { providerId: 'x', modelId: 'y' })
      s.messages.push({ role: 'user', content: 'hi' })
      store.save(s)
      // save() stamps updatedAt; backdate the file afterwards.
      const file = path.join((store as unknown as { dir: string }).dir, `${s.meta.id}.json`)
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      data.meta.updatedAt = Date.now() - age
      fs.writeFileSync(file, JSON.stringify(data))
      return s.meta.id
    }
    const day = 86_400_000
    const fresh = make(day)
    const old = make(40 * day)
    const oldButOpen = make(50 * day)
    const gone = store.prune(Date.now() - 30 * day, (id) => id === oldButOpen)
    expect(gone).toEqual([old])
    expect(store.list().map((m) => m.id).sort()).toEqual([fresh, oldButOpen].sort())
  })
})

describe.skipIf(process.platform === 'win32')('kept browser profile', () => {
  /** A stand-in browser: writes the DevTools port file into its profile and waits. */
  function fakeBrowser(): string {
    const file = path.join(tmpDir(), 'fake-chrome')
    fs.writeFileSync(file, '#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) d="${a#--user-data-dir=}";; esac; done\nprintf "9999\\n/devtools/browser/x" > "$d/DevToolsActivePort"\nexec sleep 30\n', { mode: 0o755 })
    return file
  }

  it('reuses the profile folder, keeps it after closing, and gives a second browser a throwaway one', async () => {
    const exe = fakeBrowser()
    const profile = path.join(tmpDir(), 'profile')
    fs.mkdirSync(profile)
    // A stale port file from a crash must not be mistaken for a running browser.
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '1\n')
    fs.writeFileSync(path.join(profile, 'Cookies'), 'kept')
    const first = await launchBrowser({ path: exe, headless: true, profileDir: profile })
    expect(first.port).toBe(9999)
    const second = await launchBrowser({ path: exe, headless: true, profileDir: profile })
    expect(second.port).toBe(9999)
    second.close()
    first.close()
    await new Promise((r) => setTimeout(r, 300))
    expect(fs.readFileSync(path.join(profile, 'Cookies'), 'utf8')).toBe('kept')
    // Free again: the next launch uses the kept profile.
    const third = await launchBrowser({ path: exe, headless: true, profileDir: profile })
    third.close()
  })
})
