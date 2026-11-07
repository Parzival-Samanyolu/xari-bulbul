import { describe, expect, it } from 'vitest'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import type { Tool } from '../src/tools/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, tmpDir } from './helpers.js'

/** An MCP-style tool with a long description, like a big MCP server's. */
const bigTool = (i: number): Tool => ({
  name: `mcp__big__tool_${i}`,
  description: 'x'.repeat(4000),
  parameters: { type: 'object', properties: {} },
  kind: 'read',
  readOnly: true,
  source: 'mcp',
  execute: async () => ({ content: 'ok' }),
}) as unknown as Tool

async function setup(script: ConstructorParameters<typeof MockProvider>[0], contextLength: number) {
  const provider = new MockProvider(script, { contextLength })
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const settings = defaultSettings()
  settings.permissions.mode = 'auto'
  const events: AgentEvent[] = []
  const dir = tmpDir()
  const agent = new Agent({
    session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
    registry,
    tools: [...builtinTools(), ...Array.from({ length: 10 }, (_, i) => bigTool(i))],
    settings,
    usage: new UsageTracker(null),
    permissions: new Permissions(settings.permissions, dir),
    askPermission: async () => ({ type: 'allow' }),
    onEvent: (e) => events.push(e),
  })
  return { agent, provider, events }
}

describe('tool budget', () => {
  it('leaves MCP tools out when they would crowd a small context, and says so', async () => {
    const { agent, provider, events } = await setup([[{ type: 'text', delta: 'hi' }]], 32_768)
    await agent.send('hello')
    const sent = provider.requests[0].tools!.map((t) => t.name)
    expect(sent.some((n) => n.startsWith('mcp__'))).toBe(false)
    expect(sent).toContain('read_file')
    expect(events.some((e) => e.type === 'notice' && /Left out 10 MCP tools/.test(e.text))).toBe(true)
  })

  it('keeps every tool when the context has room', async () => {
    const { agent, provider, events } = await setup([[{ type: 'text', delta: 'hi' }]], 200_000)
    await agent.send('hello')
    expect(provider.requests[0].tools!.filter((t) => t.name.startsWith('mcp__'))).toHaveLength(10)
    expect(events.some((e) => e.type === 'notice' && /Left out/.test(e.text))).toBe(false)
  })
})

describe('empty replies', () => {
  it('asks once more when the model stops after thinking with no answer', async () => {
    const { agent, provider } = await setup([[{ type: 'reasoning', delta: 'thinking…' }], [{ type: 'text', delta: 'hiiii' }]], 200_000)
    await agent.send('hello')
    expect(provider.requests).toHaveLength(2)
    expect(agent.session.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['hiiii'])
  })
})
