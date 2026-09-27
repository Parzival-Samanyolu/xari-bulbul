import { describe, expect, it } from 'vitest'
import { Agent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { newSession } from '../src/sessions/store.js'
import { BUILTIN_PROVIDERS, defaultSettings, parseSettings, PROVIDER_PRESETS, providerReady } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { UsageTracker } from '../src/usage/tracker.js'
import type { AgentEvent } from '../src/loop/agent.js'
import { MockProvider, tmpDir } from './helpers.js'

describe('provider readiness', () => {
  const local = { ...BUILTIN_PROVIDERS[0], id: 'ollama-local', requiresKey: false }

  it('is ready with a key, or without one when no key is needed', () => {
    expect(providerReady(BUILTIN_PROVIDERS[0], true)).toBe(true)
    expect(providerReady(BUILTIN_PROVIDERS[0], false)).toBe(false)
    expect(providerReady(local, false)).toBe(true)
    expect(providerReady({ ...local, enabled: false }, false)).toBe(false)
    expect(providerReady(undefined, true)).toBe(false)
  })

  it('defaults old settings to requiring a key and ships keyless local presets', () => {
    const s = parseSettings({ providers: [{ id: 'x', name: 'X', baseUrl: 'https://x.dev/v1' }] })
    expect(s.providers[0].requiresKey).toBe(true)
    expect(PROVIDER_PRESETS.find((p) => p.id === 'ollama-local')?.requiresKey).toBe(false)
    expect(defaultSettings().models.picker.freeOnly).toBe(true)
  })
})

describe('tool durations', () => {
  it('measure execution only, not time spent waiting for approval', async () => {
    const dir = tmpDir()
    const provider = new MockProvider([
      [{ type: 'tool_call', call: { id: '1', name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) } }],
      [{ type: 'text', delta: 'done' }],
    ])
    const registry = new ProviderRegistry([], () => undefined)
    registry.register(provider)
    const settings = defaultSettings()
    const events: AgentEvent[] = []
    const agent = new Agent({
      session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
      registry,
      tools: builtinTools(),
      settings,
      usage: new UsageTracker(null),
      permissions: new Permissions({ ...settings.permissions, mode: 'ask' }, dir),
      // The user takes 400ms to approve.
      askPermission: () => new Promise((r) => setTimeout(() => r({ type: 'allow' }), 400)),
      onEvent: (e) => events.push(e),
    })
    await agent.send('run it')
    const end = events.find((e) => e.type === 'tool_end')
    expect(end && end.type === 'tool_end' && end.durationMs).toBeLessThan(350)
  })
})
