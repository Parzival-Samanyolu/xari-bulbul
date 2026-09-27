import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, tmpDir } from './helpers.js'

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const usage = (p: number, c: number): StreamEvent => ({ type: 'usage', usage: { promptTokens: p, completionTokens: c } })

async function setup(script: ConstructorParameters<typeof MockProvider>[0], opts: { mode?: 'ask' | 'auto'; answer?: 'allow' | 'deny' } = {}) {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'app.txt'), 'hello world\n')
  const provider = new MockProvider(script)
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const settings = defaultSettings()
  settings.permissions.mode = opts.mode ?? 'auto'
  const events: AgentEvent[] = []
  const asked: string[] = []
  const askedIds: string[] = []
  const usageTracker = new UsageTracker(null)
  const agent = new Agent({
    session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
    registry,
    tools: builtinTools(),
    settings,
    usage: usageTracker,
    permissions: new Permissions(settings.permissions, dir),
    askPermission: async (req) => {
      asked.push(req.tool)
      askedIds.push(req.callId)
      return opts.answer === 'deny' ? { type: 'deny', feedback: 'not now' } : { type: 'allow' }
    },
    onEvent: (e) => events.push(e),
  })
  return { dir, agent, provider, events, asked, askedIds, usageTracker, settings }
}

describe('Agent loop', () => {
  it('runs tools until the model stops, tracking usage and cost', async () => {
    const { dir, agent, provider, events, usageTracker } = await setup([
      [call('1', 'read_file', { path: 'app.txt' }), usage(100, 10)],
      [call('2', 'edit_file', { path: 'app.txt', old_string: 'world', new_string: 'harness' }), usage(200, 10)],
      [{ type: 'text', delta: 'Done.' }, usage(300, 5)],
    ])
    const reason = await agent.send('change world to harness')
    expect(reason).toBe('done')
    expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('hello harness\n')
    expect(agent.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    expect(agent.session.meta.title).toBe('change world to harness')
    // The second request must include the first tool result.
    expect(provider.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: '1' })
    expect(provider.requests[0].messages[0].role).toBe('system')
    const s = usageTracker.summary(agent.session.meta.id)
    expect(s.session.requests).toBe(3)
    expect(s.session.promptTokens).toBe(600)
    expect(s.session.cost).toBeCloseTo(600e-6 + 25 * 2e-6)
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'done' })
  })

  it('asks permission and feeds denial feedback back to the model', async () => {
    const { agent, asked, events } = await setup(
      [[call('1', 'bash', { command: 'rm -rf build' })], [{ type: 'text', delta: 'OK, I will not.' }]],
      { mode: 'ask', answer: 'deny' },
    )
    await agent.send('clean up')
    expect(asked).toEqual(['bash'])
    const toolMsg = agent.session.messages.find((m) => m.role === 'tool')!
    expect(toolMsg.content).toMatch(/denied.*not now/)
    expect(events.some((e) => e.type === 'tool_end' && e.denied)).toBe(true)
  })

  it('reports invalid tool arguments to the model instead of crashing', async () => {
    const { agent } = await setup([
      [{ type: 'tool_call', call: { id: '1', name: 'read_file', arguments: '{bad json' } }],
      [{ type: 'text', delta: 'sorry' }],
    ])
    expect(await agent.send('x')).toBe('done')
    expect(agent.session.messages[2].content).toMatch(/not valid JSON/)
  })

  it('stops at max steps', async () => {
    const script = Array.from({ length: 5 }, (_, i) => [call(String(i), 'list_dir', {})])
    const { agent, events } = await setup(script)
    agent.updateSettings({ ...defaultSettings(), permissions: { ...defaultSettings().permissions, mode: 'auto' }, agent: { ...defaultSettings().agent, maxStepsPerTurn: 2 } })
    expect(await agent.send('loop')).toBe('max_steps')
    expect(events.some((e) => e.type === 'notice')).toBe(true)
  })

  it('surfaces provider errors as an error turn', async () => {
    const { agent, events } = await setup([])
    expect(await agent.send('x')).toBe('error')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: /script exhausted/ })
  })
})

describe('Subagents', () => {
  const text = (t: string): StreamEvent => ({ type: 'text', delta: t })
  const names = (r: { tools?: { name: string }[] }) => (r.tools ?? []).map((t) => t.name)

  it('delegates to a read-only subagent and returns its report', async () => {
    const { agent, provider, events, usageTracker } = await setup([
      [call('T', 'task', { description: 'Find greeting', prompt: 'Where is the greeting? Report the file.' }), usage(100, 10)],
      [call('s1', 'read_file', { path: 'app.txt' }), usage(50, 5)],
      [text('The greeting is in app.txt:1.'), usage(60, 5)],
      [text('It is in app.txt.'), usage(200, 5)],
    ])
    expect(await agent.send('find the greeting')).toBe('done')
    const result = agent.session.messages.find((m) => m.role === 'tool' && m.toolCallId === 'T')
    expect(result?.content).toBe('The greeting is in app.txt:1.')
    // The subagent's context is fresh, read-only, and cannot delegate further.
    const sub = provider.requests[1]
    expect(sub.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(sub.messages[0].content).toContain('You are a subagent')
    expect(names(sub)).not.toContain('task')
    expect(names(sub)).not.toContain('edit_file')
    expect(names(provider.requests[0])).toContain('task')
    // Subagent tokens count toward the parent chat.
    expect(usageTracker.summary(agent.session.meta.id).session.requests).toBe(4)
    expect(events.some((e) => e.type === 'tool_progress' && e.callId === 'T' && e.text.includes('read_file app.txt'))).toBe(true)
  })

  it('routes subagent approvals through the parent with unique ids', async () => {
    const { dir, agent, askedIds } = await setup(
      [
        [call('T', 'task', { description: 'Rename', prompt: 'Change world to harness in app.txt', type: 'general' })],
        [call('r', 'read_file', { path: 'app.txt' })],
        [call('e', 'edit_file', { path: 'app.txt', old_string: 'world', new_string: 'harness' })],
        [text('Changed app.txt.')],
        [text('Done.')],
      ],
      { mode: 'ask' },
    )
    expect(await agent.send('rename')).toBe('done')
    expect(askedIds).toEqual(['T/e'])
    expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('hello harness\n')
  })

  it('runs several subagents in parallel', async () => {
    const { agent } = await setup([
      [call('A', 'task', { description: 'a', prompt: 'a' }), call('B', 'task', { description: 'b', prompt: 'b' })],
      [text('report')],
      [text('report')],
      [text('Both done.')],
    ])
    expect(await agent.send('two things')).toBe('done')
    const results = agent.session.messages.filter((m) => m.role === 'tool').map((m) => m.role === 'tool' && m.toolCallId)
    expect(results.sort()).toEqual(['A', 'B'])
  })

  it('can be turned off', async () => {
    const { agent, provider, settings } = await setup([[text('ok')]])
    agent.updateSettings({ ...settings, agent: { ...settings.agent, subagents: { ...settings.agent.subagents, enabled: false } } })
    await agent.send('hi')
    expect(names(provider.requests[0])).not.toContain('task')
  })
})

describe('Attachments in the loop', () => {
  it('sends attached files and names the chat after them when there is no text', async () => {
    const { agent, provider } = await setup([[{ type: 'text', delta: 'ok' }]])
    await agent.send('', { files: [{ name: 'notes.md', text: '# hi' }] })
    expect(agent.session.meta.title).toBe('notes.md')
    expect(provider.requests[0].messages.at(-1)).toMatchObject({ role: 'user', files: [{ name: 'notes.md' }] })
  })
})

describe('Mid-reply failures', () => {
  it('retries a reply that broke off, discarding the partial text', async () => {
    const { ProviderError } = await import('../src/providers/types.js')
    const { agent, events } = await setup([
      { events: [{ type: 'text', delta: 'Half an ans' }], fail: new ProviderError('OpenRouter: the model failed partway', 502, true) },
      [{ type: 'text', delta: 'Full answer.' }],
    ])
    expect(await agent.send('hi')).toBe('done')
    expect(agent.session.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Full answer.' })
    expect(events.some((e) => e.type === 'stream_reset')).toBe(true)
  })

  it('does not retry client errors', async () => {
    const { ProviderError } = await import('../src/providers/types.js')
    const { agent } = await setup([{ events: [], fail: new ProviderError('context too long', 400, false) }])
    expect(await agent.send('hi')).toBe('error')
  })
})
