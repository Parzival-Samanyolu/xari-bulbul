import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSecrets, KeyStore, ProviderRegistry, type StreamEvent } from '@harness/core'
import { MockProvider } from '../../../packages/core/test/helpers.js'
import { Host } from '../src/host.js'
import { App } from '../src/ui/App.js'
import { eventually, KEY, renderUi, strip, tick } from './helpers.js'

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const usage = (p: number, c: number): StreamEvent => ({ type: 'usage', usage: { promptTokens: p, completionTokens: c } })

async function setup(script: ConstructorParameters<typeof MockProvider>[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-app-'))
  const dataDir = path.join(root, 'data')
  const cwd = path.join(root, 'proj')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ providers: [{ id: 'mock', name: 'Mock', baseUrl: 'http://127.0.0.1:9/v1', requiresKey: false }], models: { default: { providerId: 'mock', modelId: 'm' } } }),
  )
  const provider = new MockProvider(script)
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const host = new Host({ cwd, version: '0.0.0-test', dataDir, registry, keys: new KeyStore(new FileSecrets(path.join(dataDir, 'k.json')), {}) })
  return { host, provider, cwd, dataDir }
}

const all = (r: { frames: string[] }) => strip(r.frames.join('\n'))

describe('App', () => {
  it('streams a reply, asks before a command, runs it and summarizes the turn', async () => {
    const { host, cwd } = await setup([
      [{ type: 'text', delta: 'Let me check.' }, call('1', 'bash', { command: 'echo hello-from-shell' }), usage(1000, 20)],
      [{ type: 'text', delta: 'All **done**.' }, usage(1100, 10)],
    ])
    const r = renderUi(<App host={host} session={host.newSession()} mode="ask" columns={100} onExit={() => {}} />)
    await tick(50)
    expect(all(r)).toContain('Xarı Bülbül v0.0.0-test')
    r.stdin.write('say hello')
    await tick()
    r.stdin.write(KEY.enter)
    await eventually(() => expect(all(r)).toContain('Run this command?'))
    expect(all(r)).toContain('$ echo hello-from-shell')
    r.stdin.write('y')
    await eventually(() => expect(all(r)).toContain('All done.'))
    await eventually(() => expect(all(r)).toMatch(/Worked for \d+s · 2 requests · 2\.1k in · 30 out/))
    expect(all(r)).toContain('Ran echo hello-from-shell')
    expect(all(r)).toContain('hello-from-shell')
    // The chat is saved and resumable.
    expect(host.store.list({ cwd })).toHaveLength(1)
    r.unmount()
  })

  it('runs slash commands without calling the model', async () => {
    const { host, provider } = await setup([])
    const r = renderUi(<App host={host} session={host.newSession()} mode="ask" columns={100} onExit={() => {}} />)
    await tick(50)
    r.stdin.write('/mode plan')
    await tick()
    r.stdin.write(KEY.enter)
    await eventually(() => expect(all(r)).toContain('Mode: Plan'))
    r.stdin.write('/status')
    await tick()
    r.stdin.write(KEY.enter)
    await eventually(() => expect(all(r)).toContain('Status'))
    expect(all(r)).toMatch(/model\s+m · Mock/)
    expect(provider.requests).toHaveLength(0)
    r.unmount()
  })

  it('says how to fix a provider without a key instead of sending', async () => {
    const { host } = await setup([])
    const session = host.newSession({ providerId: 'openrouter', modelId: 'openrouter/free' })
    host.updateSettings((s) => ({ ...s, providers: [...s.providers, { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, headers: {}, requestUsageCost: true, requiresKey: true }] }))
    const r = renderUi(<App host={host} session={session} mode="ask" columns={100} onExit={() => {}} />)
    await tick(50)
    r.stdin.write('hi')
    await tick()
    r.stdin.write(KEY.enter)
    await eventually(() => expect(all(r)).toContain('No API key for OpenRouter. Run /login openrouter, or set OPENROUTER_API_KEY.'))
    r.unmount()
  })
})
