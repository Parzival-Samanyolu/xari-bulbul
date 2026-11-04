import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { RepeatGuard } from '../src/loop/repetition.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings, SettingsSchema } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { defineTool, type Tool } from '../src/tools/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, tmpDir } from './helpers.js'

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const text = (t: string): StreamEvent => ({ type: 'text', delta: t })

async function setup(script: ConstructorParameters<typeof MockProvider>[0], extraTools: Tool[] = []) {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'app.txt'), 'hello world\n')
  const provider = new MockProvider(script)
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const settings = defaultSettings()
  settings.permissions.mode = 'auto'
  const events: AgentEvent[] = []
  const agent = new Agent({
    session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
    registry,
    tools: [...builtinTools(), ...extraTools],
    settings,
    usage: new UsageTracker(null),
    permissions: new Permissions(settings.permissions, dir),
    askPermission: async () => ({ type: 'allow' }),
    onEvent: (e) => events.push(e),
  })
  return { dir, agent, provider, events }
}

/** A tool that ignores its abort signal and never finishes, like a hung MCP server. */
function hangingTool(readOnly: boolean, started: () => void): Tool {
  return defineTool({
    name: 'hang',
    description: 'Waits forever.',
    input: z.object({ n: z.number().optional() }),
    kind: 'read',
    readOnly,
    subject: () => 'forever',
    execute: () => {
      started()
      return new Promise(() => {})
    },
  }) as Tool
}

describe('Repeat detection', () => {
  it('nudges after the same call repeats, then stops if it goes on', async () => {
    const same = Array.from({ length: 8 }, (_, i) => [call(String(i), 'read_file', { path: 'app.txt' })])
    const { agent, provider, events } = await setup(same)
    expect(await agent.send('read it')).toBe('repeating')
    // Third identical call → a hidden nudge before the fourth request; fifth → stop.
    expect(provider.requests).toHaveLength(5)
    const nudges = agent.session.messages.filter((m) => m.role === 'user' && m.synthetic === 'reminder' && /going in circles/.test(m.content))
    expect(nudges).toHaveLength(1)
    expect(provider.requests[3].messages.at(-1)?.content).toMatch(/repeated the same read_file call 3 times/)
    const notice = events.findLast((e) => e.type === 'notice')
    expect(notice).toMatchObject({ level: 'warn', text: expect.stringMatching(/^Stopped: the model repeated the same read_file call 5 times.*continue/) })
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'repeating' })
  })

  it('lets the turn go on when the model changes approach after the nudge', async () => {
    const { agent } = await setup([
      [call('1', 'read_file', { path: 'app.txt' })],
      [call('2', 'read_file', { path: 'app.txt' })],
      [call('3', 'read_file', { path: 'app.txt' })],
      [call('4', 'list_dir', {})],
      [text('Found it.')],
    ])
    expect(await agent.send('read it')).toBe('done')
  })

  it('treats reordered arguments as the same call, and a different result as progress', () => {
    const g = new RepeatGuard()
    g.startTurn()
    const step = (args: string, result: string) => ({ text: '', calls: [{ name: 'bash', arguments: args, result }] })
    expect(g.observe(step('{"command":"npm test","timeout":5}', 'fail 1')).action).toBe('ok')
    expect(g.observe(step('{"timeout":5, "command":"npm test"}', 'fail 2')).action).toBe('ok')
    expect(g.observe(step('{"command":"npm test","timeout":5}', 'fail 1')).action).toBe('ok')
    expect(g.observe(step('{ "timeout": 5, "command": "npm test" }', 'fail 1')).action).toBe('nudge')
  })

  it('notices the same text coming back with different calls', () => {
    const g = new RepeatGuard()
    g.startTurn()
    const msg = 'I will now check the configuration file again to see what is wrong with it.'
    const step = (i: number, t: string) => ({ text: t, calls: [{ name: 'read_file', arguments: `{"path":"f${i}"}`, result: String(i) }] })
    expect(g.observe(step(1, msg)).action).toBe('ok')
    expect(g.observe(step(2, msg.toUpperCase())).action).toBe('ok')
    expect(g.observe(step(3, `${msg}!`)).action).toBe('nudge')
    expect(g.observe(step(4, msg)).action).toBe('ok')
    expect(g.observe(step(5, msg))).toMatchObject({ action: 'stop', what: 'the same message', count: 5 })
    g.startTurn()
    expect(g.observe(step(6, msg)).action).toBe('ok')
  })
})

describe('Stop', () => {
  it('ends the turn while a tool that ignores the signal is still running, without another step', async () => {
    let agent!: Agent
    const tool = hangingTool(false, () => setTimeout(() => agent.stop(), 5))
    const s = await setup([[call('1', 'hang', {})], [text('should not be asked')]], [tool])
    agent = s.agent
    expect(await agent.send('go')).toBe('aborted')
    expect(s.provider.requests).toHaveLength(1)
    expect(agent.session.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: '1', content: expect.stringMatching(/Interrupted/) })
  })

  it('stops parallel read-only calls and gives each one a result', async () => {
    let agent!: Agent
    const tool = hangingTool(true, () => setTimeout(() => agent.stop(), 5))
    const s = await setup([[call('a', 'hang', { n: 1 }), call('b', 'hang', { n: 2 }), call('c', 'read_file', { path: 'app.txt' })], [text('no')]], [tool])
    agent = s.agent
    expect(await agent.send('go')).toBe('aborted')
    expect(s.provider.requests).toHaveLength(1)
    const results = agent.session.messages.filter((m) => m.role === 'tool')
    expect(results.map((m) => m.role === 'tool' && m.toolCallId)).toEqual(['a', 'b', 'c'])
  })

  it('stops a running subagent and does not start another parent step', async () => {
    let agent!: Agent
    const tool = hangingTool(true, () => setTimeout(() => agent.stop(), 5))
    const s = await setup(
      [[call('T', 'task', { description: 'Look', prompt: 'look around', type: 'explore' })], [call('s1', 'hang', {})], [text('child report')], [text('parent reply')]],
      [tool],
    )
    agent = s.agent
    expect(await agent.send('go')).toBe('aborted')
    // One parent request and one subagent request; nothing after the stop.
    expect(s.provider.requests).toHaveLength(2)
    expect(agent.session.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'T', content: expect.stringMatching(/interrupted/i) })
  })

  it("doesn't start another step when the provider ends its stream quietly after Stop", async () => {
    const s = await setup([[text('thinking…'), call('1', 'read_file', { path: 'app.txt' })], [text('no')]])
    s.events.length = 0
    const origEmit = s.events.push.bind(s.events)
    s.events.push = (...e: AgentEvent[]) => {
      if (e[0]?.type === 'text') s.agent.stop()
      return origEmit(...e)
    }
    expect(await s.agent.send('go')).toBe('aborted')
    expect(s.provider.requests).toHaveLength(1)
    expect(s.agent.session.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: '1', content: expect.stringMatching(/Interrupted/) })
  })
})

describe('maxStepsPerTurn', () => {
  it('lowers a saved value above the new cap instead of failing', () => {
    expect(SettingsSchema.parse({ agent: { maxStepsPerTurn: 1000 } }).agent.maxStepsPerTurn).toBe(500)
    expect(SettingsSchema.parse({ agent: { maxStepsPerTurn: 300 } }).agent.maxStepsPerTurn).toBe(300)
    expect(SettingsSchema.parse({}).agent.maxStepsPerTurn).toBe(200)
    expect(SettingsSchema.safeParse({ agent: { maxStepsPerTurn: 0 } }).success).toBe(false)
  })
})
