import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSecrets, KeyStore, LinuxSecretTool, MacKeychain, detectSecretBackend, keychainService, type Exec } from '../src/host/keychain.js'
import { envKey, envKeyName, latestSession, loadSettingsFile, resolveDataDir, saveSettingsFile } from '../src/host/paths.js'
import { assembleTools } from '../src/host/tools.js'
import { SessionStore, newSession } from '../src/sessions/store.js'
import { defineTool } from '../src/tools/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { z } from 'zod'
import { tmpDir } from './helpers.js'

/** A fake `security` / `secret-tool` that keeps secrets in a map and records calls. */
function fakeExec(kind: 'mac' | 'linux') {
  const store = new Map<string, string>()
  const calls: { cmd: string; args: string[]; input?: string }[] = []
  const exec: Exec = (cmd, args, input) => {
    calls.push({ cmd, args, input })
    if (kind === 'mac') {
      if (args[0] === '-i') {
        const m = /-s (\S+) -a "([^"]+)" -l "[^"]*" -w "([^"]*)"/.exec(input ?? '')!
        store.set(`${m[1]}/${m[2]}`, m[3])
        return { status: 0, stdout: '', stderr: '' }
      }
      const svc = args[args.indexOf('-s') + 1]
      const acct = args[args.indexOf('-a') + 1]
      if (args[0] === 'find-generic-password') {
        const v = store.get(`${svc}/${acct}`)
        return v === undefined ? { status: 44, stdout: '', stderr: 'not found' } : { status: 0, stdout: v + '\n', stderr: '' }
      }
      if (args[0] === 'add-generic-password') store.set(`${svc}/${acct}`, args[args.indexOf('-w') + 1])
      if (args[0] === 'delete-generic-password') store.delete(`${svc}/${acct}`)
      return { status: 0, stdout: '', stderr: '' }
    }
    const svc = args[args.indexOf('service') + 1]
    const id = args[args.indexOf('id') + 1]
    if (args[0] === 'lookup') {
      const v = store.get(`${svc}/${id}`)
      return v === undefined ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: v, stderr: '' }
    }
    if (args[0] === 'store') store.set(`${svc}/${id}`, input ?? '')
    if (args[0] === 'clear') store.delete(`${svc}/${id}`)
    return { status: 0, stdout: '', stderr: '' }
  }
  return { exec, store, calls }
}

describe('data dir and settings', () => {
  it('follows Electron userData per platform, and HARNESS_DATA_DIR wins', () => {
    expect(resolveDataDir({}, 'darwin', '/Users/a')).toBe('/Users/a/Library/Application Support/Xarı Bülbül')
    expect(resolveDataDir({}, 'linux', '/home/a')).toBe('/home/a/.config/Xarı Bülbül')
    expect(resolveDataDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/a')).toBe('/x/Xarı Bülbül')
    expect(resolveDataDir({ HARNESS_DATA_DIR: '/tmp/p' }, 'darwin', '/Users/a')).toBe('/tmp/p')
  })

  it('round-trips settings and survives a corrupt file', () => {
    const dir = tmpDir()
    expect(loadSettingsFile(dir).models.default.modelId).toBe('openrouter/free')
    const s = loadSettingsFile(dir)
    s.permissions.mode = 'acceptEdits'
    saveSettingsFile(dir, s)
    expect(loadSettingsFile(dir).permissions.mode).toBe('acceptEdits')
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json')
    expect(loadSettingsFile(dir).permissions.mode).toBe('ask')
  })

  it('maps provider ids to env var names', () => {
    expect(envKeyName('ollama-cloud')).toBe('OLLAMA_CLOUD_API_KEY')
    expect(envKey('openrouter', { OPENROUTER_API_KEY: ' sk ' })).toBe('sk')
    expect(envKey('openrouter', {})).toBeUndefined()
  })

  it('finds the latest chat for a folder', async () => {
    const store = new SessionStore(tmpDir())
    const a = newSession('/p', { providerId: 'x', modelId: 'y' })
    const b = newSession('/p', { providerId: 'x', modelId: 'y' })
    store.save(a)
    await new Promise((r) => setTimeout(r, 5))
    store.save(b)
    expect(latestSession(store, '/p')?.id).toBe(b.meta.id)
    expect(latestSession(store, '/q')).toBeUndefined()
  })
})

describe('keychain', () => {
  it('stores keys in the macOS keychain without putting them on the command line', () => {
    const f = fakeExec('mac')
    const keys = new KeyStore(new MacKeychain(f.exec), {})
    keys.set('openrouter', 'sk-or-123')
    const write = f.calls.find((c) => c.args[0] === '-i')!
    expect(write.args).toEqual(['-i'])
    expect(write.input).toContain('-w "sk-or-123"')
    expect(new KeyStore(new MacKeychain(f.exec), {}).get('openrouter')).toBe('sk-or-123')
    keys.set('openrouter', null)
    expect(new KeyStore(new MacKeychain(f.exec), {}).get('openrouter')).toBeUndefined()
  })

  it('falls back to argv for values the interactive parser cannot quote', () => {
    const f = fakeExec('mac')
    new MacKeychain(f.exec).set('x', 'a"b')
    expect(f.store.get('xari-bulbul/x')).toBe('a"b')
  })

  it('uses secret-tool on Linux with the secret on stdin', () => {
    const f = fakeExec('linux')
    expect(LinuxSecretTool.available(f.exec)).toBe(true)
    const keys = new KeyStore(new LinuxSecretTool(f.exec), {})
    keys.set('mcp:github', 'ghp_1')
    expect(f.calls.find((c) => c.args[0] === 'store')!.input).toBe('ghp_1')
    expect(f.calls.every((c) => !c.args.includes('ghp_1'))).toBe(true)
    expect(keys.get('mcp:github')).toBe('ghp_1')
  })

  it('falls back to a 0600 file when no keychain is reachable', () => {
    const dir = tmpDir()
    const missing: Exec = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') })
    const backend = detectSecretBackend(dir, { platform: 'linux', exec: missing })
    expect(backend).toBeInstanceOf(FileSecrets)
    backend.set('groq', 'gsk')
    const file = path.join(dir, 'xb-secrets.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(new FileSecrets(file).get('groq')).toBe('gsk')
  })

  it('lets env vars override stored provider keys, but never MCP tokens', () => {
    const f = fakeExec('mac')
    const keys = new KeyStore(new MacKeychain(f.exec), { OPENROUTER_API_KEY: 'from-env', MCP_GH_API_KEY: 'nope' })
    keys.set('openrouter', 'stored')
    expect(keys.get('openrouter')).toBe('from-env')
    expect(keys.source('openrouter')).toBe('env')
    keys.set('mcp:gh', 'tok')
    expect(keys.get('mcp:gh')).toBe('tok')
  })

  it('gives separate profiles their own keychain service', () => {
    expect(keychainService('/default', '/default')).toBe('xari-bulbul')
    expect(keychainService('/tmp/dev', '/default')).toMatch(/^xari-bulbul-[0-9a-f]{8}$/)
  })
})

describe('tools and usage', () => {
  it('never lets extensions or MCP shadow built-in tools', () => {
    const fake = (name: string) => defineTool({ name, description: '', input: z.object({}), kind: 'other', readOnly: true, subject: () => '', execute: async () => ({ content: '' }) })
    const { tools, conflicts } = assembleTools([fake('bash'), fake('mine')], [fake('mine'), fake('mcp__x__y')])
    expect(conflicts).toEqual(['bash', 'mine'])
    expect(tools.filter((t) => t.name === 'mine')).toHaveLength(1)
    expect(tools.at(-1)!.name).toBe('mcp__x__y')
  })

  it('aggregates usage by day and by chat', () => {
    const u = new UsageTracker(null)
    const rec = (ts: number, sessionId: string, modelId: string, cost: number | null) =>
      u.record({ ts, sessionId, providerId: 'p', modelId, promptTokens: 10, completionTokens: 5, cachedTokens: 0, cost })
    rec(new Date(2026, 0, 1, 10).getTime(), 'a', 'm1', 0.01)
    rec(new Date(2026, 0, 1, 12).getTime(), 'b', 'm1', 0.02)
    rec(new Date(2026, 0, 2, 9).getTime(), 'a', 'm2', null)
    const days = u.byDay()
    expect(days.map((d) => d.day)).toEqual(['2026-01-02', '2026-01-01'])
    expect(days[1].totals.cost).toBeCloseTo(0.03)
    expect(days[0].totals.costPartial).toBe(true)
    const a = u.bySession('a')
    expect(a.total.requests).toBe(2)
    expect(Object.keys(a.byModel)).toEqual(['p:m1', 'p:m2'])
  })
})
