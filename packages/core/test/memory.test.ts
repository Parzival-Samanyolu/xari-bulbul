import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt } from '../src/context/system-prompt.js'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { applyReview, looksSecret, parseReview } from '../src/memory/review.js'
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

describe('memory review', () => {
  const json = (o: object): StreamEvent[] => [{ type: 'text', delta: JSON.stringify(o) }, { type: 'usage', usage: { promptTokens: 50, completionTokens: 5 } }]

  function setup(script: ConstructorParameters<typeof MockProvider>[0], opts: { review?: boolean; enabled?: boolean } = {}) {
    const dir = tmpDir()
    const store = new MemoryStore(tmpDir(), 1000)
    const provider = new MockProvider(script)
    const registry = new ProviderRegistry([], () => undefined)
    registry.register(provider)
    const settings = defaultSettings()
    settings.permissions.mode = 'auto'
    settings.memory.enabled = opts.enabled ?? true
    if (opts.review ?? true) settings.models.memoryReview = { providerId: 'mock', modelId: 'm' }
    const events: AgentEvent[] = []
    const usage = new UsageTracker(null)
    const agent = new Agent({
      session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
      registry,
      tools: builtinTools(),
      settings,
      usage,
      permissions: new Permissions(settings.permissions, dir),
      memory: store,
      askPermission: async () => ({ type: 'allow' }),
      onEvent: (e) => events.push(e),
    })
    return { dir, store, provider, agent, events, usage, settings }
  }

  it('saves durable facts after the turn and reports them', async () => {
    const { dir, store, provider, agent, events, usage } = setup([
      [{ type: 'text', delta: 'Done, tests pass with pnpm test.' }],
      json({ add: [{ scope: 'project', fact: 'Run tests with pnpm test' }, { scope: 'global', fact: 'Prefers short answers' }], remove: [] }),
    ])
    store.add('global', dir, 'Answer in English')
    await agent.send('run the tests; keep answers short please')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'memory')).toBe(true))
    expect(store.list('project', dir)).toEqual(['Run tests with pnpm test'])
    expect(store.list('global', dir)).toEqual(['Answer in English', 'Prefers short answers'])
    expect(events.at(-1)).toEqual({
      type: 'memory',
      added: [
        { scope: 'project', fact: 'Run tests with pnpm test' },
        { scope: 'global', fact: 'Prefers short answers' },
      ],
      removed: [],
    })
    // The turn ended before the review ran.
    expect(events.findIndex((e) => e.type === 'turn_end')).toBeLessThan(events.findIndex((e) => e.type === 'memory'))
    const review = provider.requests[1]
    expect(review.tools).toBeUndefined()
    expect(review.messages[1].content).toContain('- Answer in English')
    expect(review.messages[1].content).toContain('keep answers short please')
    expect(review.messages[1].content).toContain('Done, tests pass with pnpm test.')
    // Only the review reported usage.
    expect(usage.summary(agent.session.meta.id).session.promptTokens).toBe(50)
  })

  it('removes an out-of-date fact', async () => {
    const { dir, store, agent, events } = setup([[{ type: 'text', delta: 'ok' }], json({ add: [], remove: [{ scope: 'project', match: 'npm' }] })])
    store.add('project', dir, 'Uses npm')
    await agent.send('we switched to pnpm')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'memory')).toBe(true))
    expect(store.list('project', dir)).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'memory', added: [], removed: [{ scope: 'project', fact: 'Uses npm' }] })
  })

  it('falls back to the title model and is skipped when neither is set', async () => {
    const off = setup([[{ type: 'text', delta: 'ok' }]], { review: false })
    await off.agent.send('hello')
    await new Promise((r) => setTimeout(r, 10))
    expect(off.provider.requests).toHaveLength(1)

    const title = setup([[{ type: 'text', delta: 'Greeting' }], [{ type: 'text', delta: 'ok' }], json({ add: [{ scope: 'global', fact: 'Likes tea' }] })], { review: false })
    title.settings.models.title = { providerId: 'mock', modelId: 'm' }
    await title.agent.send('hello, I like tea')
    await vi.waitFor(() => expect(title.store.list('global', title.dir)).toEqual(['Likes tea']))
  })

  it('is skipped when memory is off', async () => {
    const { provider, agent } = setup([[{ type: 'text', delta: 'ok' }]], { enabled: false })
    await agent.send('hello')
    await new Promise((r) => setTimeout(r, 10))
    expect(provider.requests).toHaveLength(1)
  })

  it('ignores a reply that is not JSON', async () => {
    const { dir, store, provider, agent, events } = setup([[{ type: 'text', delta: 'ok' }], [{ type: 'text', delta: 'Sure! I will remember that.' }]])
    await agent.send('hello')
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(store.list('project', dir)).toEqual([])
    expect(store.list('global', dir)).toEqual([])
    expect(events.some((e) => e.type === 'memory')).toBe(false)
  })

  it('parses fenced JSON, drops secrets and malformed items', () => {
    const r = parseReview(
      '<think>hmm</think>```json\n' +
        JSON.stringify({
          add: [
            { scope: 'project', fact: 'Build with make' },
            { scope: 'project', fact: 'The OpenAI key is sk-abcdefghijklmnopqrstuvwx' },
            { scope: 'global', fact: 'password: hunter2secret' },
            { scope: 'elsewhere', fact: 'x' },
            'loose string',
          ],
          remove: ['old', { match: 'older', scope: 'global' }, 3],
        }) +
        '\n```',
    )
    expect(r).toEqual({
      add: [{ scope: 'project', fact: 'Build with make' }],
      remove: [{ match: 'old' }, { scope: 'global', match: 'older' }],
    })
    expect(parseReview('nothing here')).toBeNull()
    expect(parseReview('{"add": "no"}')).toBeNull()
  })

  it('recognizes common key and token shapes', () => {
    expect(looksSecret('Token ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(true)
    expect(looksSecret('AWS key AKIAABCDEFGHIJKLMNOP')).toBe(true)
    expect(looksSecret('db is postgres://admin:pw@localhost/db')).toBe(true)
    expect(looksSecret('Uses a 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a session id')).toBe(true)
    expect(looksSecret('API keys live in the OS keychain')).toBe(false)
    expect(looksSecret('Run tests with pnpm test in packages/core')).toBe(false)
  })

  it('skips duplicates, full memory and ambiguous removals when applying', () => {
    const dir = tmpDir()
    const store = new MemoryStore(tmpDir(), 60)
    store.add('project', dir, 'uses tabs')
    store.add('project', dir, 'uses pnpm')
    const r = applyReview(store.scoped(dir), {
      add: [
        { scope: 'project', fact: 'uses tabs' },
        { scope: 'project', fact: 'x'.repeat(80) },
      ],
      remove: [{ match: 'uses' }],
    })
    expect(r).toEqual({ added: [], removed: [] })
    expect(store.list('project', dir)).toEqual(['uses tabs', 'uses pnpm'])
  })
})
