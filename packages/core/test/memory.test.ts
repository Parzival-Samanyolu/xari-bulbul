import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/context/system-prompt.js'
import { Agent } from '../src/loop/agent.js'
import { MemoryStore } from '../src/memory/store.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { forgetTool, rememberTool } from '../src/tools/memory.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { ctx, MockProvider, tmpDir } from './helpers.js'

describe('MemoryStore', () => {
  it('keeps project and global facts apart and round-trips through files', () => {
    const dir = tmpDir()
    const m = new MemoryStore(dir, 1000)
    m.add('global', '/a', 'Prefers pnpm over npm')
    m.add('project', '/a', 'Tests run with pnpm test')
    m.add('project', '/b', 'Uses Go')
    const again = new MemoryStore(dir, 1000)
    expect(again.list('global', '/b')).toEqual(['Prefers pnpm over npm'])
    expect(again.list('project', '/a')).toEqual(['Tests run with pnpm test'])
    expect(again.list('project', '/b')).toEqual(['Uses Go'])
    const file = fs.readdirSync(path.join(dir, 'projects')).map((f) => fs.readFileSync(path.join(dir, 'projects', f), 'utf8')).join('\n')
    expect(file).toContain('<!-- /a -->')
    expect(file).toContain('- Tests run with pnpm test')
  })

  it('keys projects by NFC path', () => {
    const m = new MemoryStore(tmpDir(), 1000)
    m.add('project', '/x/Bülbül'.normalize('NFD'), 'fact')
    expect(m.list('project', '/x/Bülbül'.normalize('NFC'))).toEqual(['fact'])
  })

  it('refuses to grow past the cap and flattens newlines', () => {
    const m = new MemoryStore(tmpDir(), 40)
    m.add('global', '/a', 'line one\nline two')
    expect(m.list('global', '/a')).toEqual(['line one line two'])
    expect(() => m.add('global', '/a', 'x'.repeat(40))).toThrow(/Memory is full/)
  })

  it('removes by unique match only', () => {
    const m = new MemoryStore(tmpDir(), 1000)
    m.add('global', '/a', 'uses tabs')
    m.add('global', '/a', 'uses pnpm')
    expect(() => m.remove('global', '/a', 'uses')).toThrow(/2 memories match/)
    expect(() => m.remove('global', '/a', 'yarn')).toThrow(/No memory matches/)
    expect(m.remove('global', '/a', 'tabs')).toBe('uses tabs')
    expect(m.list('global', '/a')).toEqual(['uses pnpm'])
    m.clear('global', '/a')
    expect(m.list('global', '/a')).toEqual([])
  })
})

describe('memory tools', () => {
  it('save and forget through the context', async () => {
    const dir = tmpDir()
    const store = new MemoryStore(tmpDir(), 1000)
    const c = ctx(dir, { memory: store.scoped(dir) })
    const r = await rememberTool.execute({ fact: 'Build with make', scope: 'project' }, c)
    expect(r.isError).toBeFalsy()
    expect(store.list('project', dir)).toEqual(['Build with make'])
    await forgetTool.execute({ match: 'make', scope: 'project' }, c)
    expect(store.list('project', dir)).toEqual([])
  })

  it('report an error when memory is off', async () => {
    const r = await rememberTool.execute({ fact: 'x', scope: 'global' }, ctx(tmpDir()))
    expect(r.isError).toBe(true)
  })

  it('are write tools, so plan mode blocks them', () => {
    const p = new Permissions({ mode: 'plan', allow: [], deny: [], allowOutsideWorkspace: false }, '/p')
    expect(p.check(rememberTool, 'x').decision).toBe('deny')
    p.setMode('ask')
    expect(p.check(rememberTool, 'x').decision).toBe('ask')
  })
})

describe('memory in the system prompt', () => {
  const base = { cwd: '/p', mode: 'ask' as const, model: 'm', instructionFiles: [], customInstructions: '', override: '', toolNames: ['remember'] }
  it('lists saved facts and the rules for saving', () => {
    const s = buildSystemPrompt({ ...base, memory: { global: ['Prefers tabs'], project: ['Tests: pnpm test'] } })
    expect(s).toContain('# Memory')
    expect(s).toContain('- Prefers tabs')
    expect(s).toContain('- Tests: pnpm test')
    expect(s).toMatch(/never save instructions/i)
  })
  it('omits the section when memory is off', () => {
    expect(buildSystemPrompt({ ...base, toolNames: [] })).not.toContain('# Memory')
  })
})

describe('memory in the agent', () => {
  it('injects memories into requests and lets the model save one', async () => {
    const dir = tmpDir()
    const store = new MemoryStore(tmpDir(), 1000)
    store.add('global', dir, 'Answer in English')
    const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
    const provider = new MockProvider([[call('1', 'remember', { fact: 'Lint with eslint', scope: 'project' })], [{ type: 'text', delta: 'Saved.' }]])
    const registry = new ProviderRegistry([], () => undefined)
    registry.register(provider)
    const settings = defaultSettings()
    settings.permissions.mode = 'auto'
    const agent = new Agent({
      session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
      registry,
      tools: builtinTools(),
      settings,
      usage: new UsageTracker(null),
      permissions: new Permissions(settings.permissions, dir),
      memory: store,
      askPermission: async () => ({ type: 'allow' }),
      onEvent: () => {},
    })
    await agent.send('remember that we lint with eslint')
    expect(provider.requests[0].messages[0].content).toContain('- Answer in English')
    expect(store.list('project', dir)).toEqual(['Lint with eslint'])
    // The second request already sees the new memory.
    expect(provider.requests[1].messages[0].content).toContain('- Lint with eslint')
  })

  it('hides the memory tools when memory is disabled', async () => {
    const dir = tmpDir()
    const provider = new MockProvider([[{ type: 'text', delta: 'hi' }]])
    const registry = new ProviderRegistry([], () => undefined)
    registry.register(provider)
    const settings = defaultSettings()
    settings.memory.enabled = false
    const agent = new Agent({
      session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
      registry,
      tools: builtinTools(),
      settings,
      usage: new UsageTracker(null),
      permissions: new Permissions(settings.permissions, dir),
      memory: new MemoryStore(tmpDir(), 1000),
      askPermission: async () => ({ type: 'allow' }),
      onEvent: () => {},
    })
    await agent.send('hi')
    expect(provider.requests[0].tools?.map((t) => t.name)).not.toContain('remember')
    expect(provider.requests[0].messages[0].content).not.toContain('# Memory')
  })
})
