import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeBot, chatBot, chatDefaults, filterBotSkills, filterBotTools, newBotId, shownBots } from '../src/bots/bots.js'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { MemoryStore } from '../src/memory/store.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { ChatRequest, StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { STARTER_BOTS, defaultSettings, parseSettings, type Bot, type Settings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, tmpDir } from './helpers.js'

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const text = (t: string): StreamEvent[] => [{ type: 'text', delta: t }]

const BOT: Bot = {
  id: 'critic',
  enabled: true,
  name: 'Critic',
  avatar: '🧐',
  color: '#884466',
  tagline: '',
  persona: 'Be blunt about problems.',
  greeting: 'Show me the code.',
  tools: ['read_file', 'grep', 'mcp__gh__*'],
  memory: 'shared',
}

function botSettings(over: Partial<Bot> = {}, on = true): Settings {
  const s = defaultSettings()
  s.permissions.mode = 'auto'
  s.experimental.bots = on
  s.bots = [{ ...BOT, ...over }]
  return s
}

async function run(settings: Settings, opts: { botId?: string; script?: ConstructorParameters<typeof MockProvider>[0]; memory?: MemoryStore; skills?: boolean } = {}) {
  const dir = tmpDir()
  const provider = new MockProvider(opts.script ?? [text('ok')])
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const events: AgentEvent[] = []
  const skills = opts.skills
    ? [
        { name: 'release', description: 'Cut a release', source: 'user' as const, dir: path.join(dir, 'release'), file: path.join(dir, 'release', 'SKILL.md') },
        { name: 'deploy', description: 'Deploy the app', source: 'user' as const, dir: path.join(dir, 'deploy'), file: path.join(dir, 'deploy', 'SKILL.md') },
      ]
    : undefined
  const agent = new Agent({
    session: newSession(dir, { providerId: 'mock', modelId: 'm' }, { botId: opts.botId }),
    registry,
    tools: builtinTools(),
    settings,
    usage: new UsageTracker(null),
    permissions: new Permissions(settings.permissions, dir),
    askPermission: async () => ({ type: 'allow' }),
    onEvent: (e) => events.push(e),
    memory: opts.memory,
    skills,
  })
  await agent.send('hi')
  return { agent, provider, events, dir }
}

const system = (r: ChatRequest) => String(r.messages[0].content)
const toolNames = (r: ChatRequest) => (r.tools ?? []).map((t) => t.name).sort()

describe('bot settings', () => {
  it('ship three starter bots, off behind the experimental flag', () => {
    const s = defaultSettings()
    expect(s.experimental.bots).toBe(false)
    expect(s.bots.map((b) => b.name)).toEqual(['Reviewer', 'Explainer', 'Shipper'])
    expect(s.bots.every((b) => b.enabled)).toBe(true)
    expect(shownBots(s)).toEqual([])
    // Editing the parsed copy never touches the built-in list.
    s.bots[0].name = 'Changed'
    expect(STARTER_BOTS[0].name).toBe('Reviewer')
    // A user who deleted every bot keeps none.
    expect(parseSettings({ bots: [] }).bots).toEqual([])
  })

  it('resolve a bot only while the feature and the bot are on', () => {
    expect(activeBot(botSettings(), 'critic')?.name).toBe('Critic')
    expect(activeBot(botSettings({}, false), 'critic')).toBeUndefined()
    expect(activeBot(botSettings({ enabled: false }), 'critic')).toBeUndefined()
    expect(activeBot(botSettings(), 'gone')).toBeUndefined()
    expect(activeBot(botSettings(), undefined)).toBeUndefined()
    // A turned-off bot is still known to its chats (for the note), but not with the feature off.
    expect(chatBot(botSettings({ enabled: false }), 'critic')?.enabled).toBe(false)
    expect(chatBot(botSettings({}, false), 'critic')).toBeNull()
    expect(shownBots(botSettings({ enabled: false }))).toEqual([])
  })

  it("start chats with the bot's model and mode, else the defaults", () => {
    const fallback = { model: { providerId: 'openrouter', modelId: 'openrouter/free' }, mode: 'ask' as const }
    const model = { providerId: 'mock', modelId: 'big' }
    expect(chatDefaults(botSettings({ model, mode: 'plan' }), 'critic', fallback)).toEqual({ model, mode: 'plan' })
    expect(chatDefaults(botSettings(), 'critic', fallback)).toEqual(fallback)
    expect(chatDefaults(botSettings({ model, mode: 'plan' }), undefined, fallback)).toEqual(fallback)
    expect(chatDefaults(botSettings({ model, mode: 'plan', enabled: false }), 'critic', fallback)).toEqual(fallback)
    expect(chatDefaults(botSettings({ model, mode: 'plan' }, false), 'critic', fallback)).toEqual(fallback)
  })

  it('filter tools by name and prefix, keeping memory and skill tools', () => {
    const tools = ['read_file', 'bash', 'grep', 'remember', 'skill', 'mcp__gh__issues', 'mcp__other__x'].map((name) => ({ name }))
    expect(filterBotTools(tools, BOT).map((t) => t.name)).toEqual(['read_file', 'grep', 'remember', 'skill', 'mcp__gh__issues'])
    expect(filterBotTools(tools, { ...BOT, tools: 'all' })).toBe(tools)
    expect(filterBotTools(tools, undefined)).toBe(tools)
    const skills = [{ name: 'a' }, { name: 'b' }]
    expect(filterBotSkills(skills, { ...BOT, skills: ['b'] })).toEqual([{ name: 'b' }])
    expect(filterBotSkills(skills, BOT)).toBe(skills)
  })

  it('make unique ids for new and copied bots', () => {
    expect(newBotId('Code Reviewer', [])).toBe('code-reviewer')
    expect(newBotId('Reviewer', ['reviewer', 'reviewer-2'])).toBe('reviewer-3')
    expect(newBotId('🚀', [])).toBe('bot')
  })
})

describe('bots in the agent', () => {
  it('adds the persona and limits the tools', async () => {
    const { provider } = await run(botSettings(), { botId: 'critic' })
    const req = provider.requests[0]
    expect(system(req)).toContain('# Persona: Critic')
    expect(system(req)).toContain('Be blunt about problems.')
    expect(system(req)).toContain('# Safety and secrets')
    // The greeting is for the screen only.
    expect(JSON.stringify(req.messages)).not.toContain('Show me the code.')
    expect(toolNames(req)).toEqual(['grep', 'read_file'])
  })

  it('refuses a tool the bot does not have', async () => {
    const { agent } = await run(botSettings(), { botId: 'critic', script: [[call('1', 'bash', { command: 'echo hi' })], text('done')] })
    const result = agent.session.messages.find((m) => m.role === 'tool')
    expect(result?.content).toBe('Error: Unknown or unavailable tool "bash".')
  })

  it("uses the bot's thinking unless the model has its own", async () => {
    const s = botSettings({ thinking: 'high' })
    s.models.reasoningEffort = 'low'
    expect((await run(s, { botId: 'critic' })).provider.requests[0].reasoningEffort).toBe('high')
    expect((await run(s)).provider.requests[0].reasoningEffort).toBe('low')
    s.models.overrides['mock:m'] = { reasoningEffort: 'medium' }
    expect((await run(s, { botId: 'critic' })).provider.requests[0].reasoningEffort).toBe('medium')
  })

  it("lists only the bot's skills", async () => {
    const { provider } = await run(botSettings({ tools: 'all', skills: ['deploy'] }), { botId: 'critic', skills: true })
    expect(system(provider.requests[0])).toContain('- deploy: Deploy the app')
    expect(system(provider.requests[0])).not.toContain('- release:')
  })

  it("keeps a bot's own memory in memory/bots/<id>.md", async () => {
    const memDir = tmpDir()
    const memory = new MemoryStore(memDir)
    const s = botSettings({ tools: 'all', memory: 'own' })
    const { provider } = await run(s, {
      botId: 'critic',
      memory,
      script: [[call('1', 'remember', { fact: 'User likes short reviews', scope: 'bot' })], text('saved'), text('again')],
    })
    expect(fs.readFileSync(path.join(memDir, 'bots', 'critic.md'), 'utf8')).toContain('- User likes short reviews')
    expect(system(provider.requests[1])).toContain('## Your own notes (only you see these)\n- User likes short reviews')
    // Other chats don't see it, and shared bots can't write there.
    const plain = await run(botSettings({ tools: 'all' }), { botId: 'critic', memory, script: [[call('1', 'remember', { fact: 'x', scope: 'bot' })], text('no')] })
    expect(system(plain.provider.requests[0])).not.toContain('User likes short reviews')
    expect(plain.agent.session.messages.find((m) => m.role === 'tool')?.content).toMatch(/no bot memory/)
  })

  it('turns memory off for a bot with memory off', async () => {
    const memory = new MemoryStore(tmpDir())
    memory.add('global', '/x', 'Prefers pnpm')
    const { provider } = await run(botSettings({ tools: 'all', memory: 'off' }), { botId: 'critic', memory })
    expect(system(provider.requests[0])).not.toContain('# Memory')
    expect(toolNames(provider.requests[0])).not.toContain('remember')
  })

  it('leaves chats without a bot exactly as before', async () => {
    const plain = defaultSettings()
    plain.permissions.mode = 'auto'
    const memory = new MemoryStore(tmpDir())
    const a = await run(plain, { memory })
    const b = await run(botSettings({ thinking: 'high' }), { memory })
    const strip = (r: ChatRequest) => system(r).replace(/Working directory: .*/, '')
    expect(strip(b.provider.requests[0])).toBe(strip(a.provider.requests[0]))
    expect(toolNames(b.provider.requests[0])).toEqual(toolNames(a.provider.requests[0]))
    expect(b.provider.requests[0].reasoningEffort).toBe(a.provider.requests[0].reasoningEffort)
    expect(b.agent.session.meta).not.toHaveProperty('botId')
  })

  it('falls back to the plain prompt and tools when the bot or the feature is off', async () => {
    const plain = defaultSettings()
    plain.permissions.mode = 'auto'
    const base = await run(plain)
    for (const s of [botSettings({ enabled: false, thinking: 'high' }), botSettings({ thinking: 'high' }, false)]) {
      const { provider, agent } = await run(s, { botId: 'critic' })
      const req = provider.requests[0]
      expect(system(req)).not.toContain('# Persona')
      expect(toolNames(req)).toEqual(toolNames(base.provider.requests[0]))
      expect(req.reasoningEffort).toBeUndefined()
      // The chat keeps its bot, so turning it back on restores the persona.
      expect(agent.session.meta.botId).toBe('critic')
    }
  })

  it("applies a change to the bot's settings on the next request", async () => {
    const s = botSettings()
    const { agent, provider } = await run(s, { botId: 'critic', script: [text('one'), text('two')] })
    agent.updateSettings({ ...s, experimental: { bots: false } })
    await agent.send('again')
    expect(system(provider.requests[0])).toContain('# Persona: Critic')
    expect(system(provider.requests[1])).not.toContain('# Persona')
  })
})
