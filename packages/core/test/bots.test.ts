import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOT_COLORS, BOT_SHAPES, activeBot, botFace, botThreads, chatBot, chatDefaults, chatPreview, faceForName, filterBotSkills, filterBotTools, isBotChat, latestBotThread, newBot, newBotId, shownBots } from '../src/bots/bots.js'
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
  avatar: { kind: 'emoji', emoji: '🧐', color: '#884466', locked: true },
  tagline: '',
  persona: 'Be blunt about problems.',
  greeting: 'Show me the code.',
  mode: 'auto',
  tools: ['read_file', 'grep', 'mcp__gh__*'],
  memory: 'shared',
  muted: false,
  cwd: null,
}

function botSettings(over: Partial<Bot> = {}, on = true): Settings {
  const s = defaultSettings()
  s.permissions.mode = 'auto'
  s.botOptions.enabled = on
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
  it('start with no bots, and the Bots tab on', () => {
    const s = defaultSettings()
    expect(s.bots).toEqual([])
    expect(STARTER_BOTS).toEqual([])
    expect(s.botOptions).toEqual({ enabled: true, muted: false })
    // A user who saved the old starter bots keeps them.
    const kept = parseSettings({ bots: [{ id: 'reviewer', name: 'Reviewer', avatar: '🔍', color: '#9b4d6e', mode: 'plan', tools: ['read_file'], memory: 'shared' }] }).bots
    expect(kept.map((b) => [b.name, b.mode, b.memory])).toEqual([['Reviewer', 'plan', 'shared']])
  })

  it('give a new bot every tool, full auto and its own memory', () => {
    const parsed = parseSettings({ bots: [{ id: 'pip', name: 'Pip' }] }).bots[0]
    expect(parsed).toMatchObject({ enabled: true, tools: 'all', mode: 'auto', memory: 'own', muted: false, cwd: null })
    expect(parsed.avatar).toEqual({ kind: 'shape', ...faceForName('Pip'), locked: false })
    const made = newBot('Pip', ['pip'])
    expect(made).toMatchObject({ id: 'pip-2', name: 'Pip', tools: 'all', mode: 'auto', memory: 'own' })
    // What the dialog makes survives a save and reload unchanged.
    expect(parseSettings({ bots: [made] }).bots[0]).toEqual(made)
  })

  it('migrate old emoji and picture avatars, keeping their color', () => {
    const [emoji, picture, blank] = parseSettings({
      bots: [
        { id: 'a', name: 'A', avatar: '🚀', color: '#5a7d3a' },
        { id: 'b', name: 'B', avatar: '/data/bots/b-1.png', color: '#3d7a8c' },
        { id: 'c', name: 'C', avatar: '', color: '#111111' },
      ],
    }).bots
    expect(emoji.avatar).toEqual({ kind: 'emoji', emoji: '🚀', color: '#5a7d3a', locked: true })
    expect(picture.avatar).toEqual({ kind: 'image', image: '/data/bots/b-1.png', color: '#3d7a8c', locked: true })
    expect(blank.avatar).toMatchObject({ kind: 'shape', color: '#111111', locked: true })
    expect(emoji).not.toHaveProperty('color')
    expect(botFace(emoji.name, emoji.avatar)).toEqual({ kind: 'emoji', emoji: '🚀', color: '#5a7d3a' })
    // A broken avatar can't drop the user's bots.
    const odd = parseSettings({ bots: [{ id: 'd', name: 'D', avatar: { kind: 'robot', shape: 'nope', color: '#123456', locked: true } }] }).bots[0]
    expect(odd.avatar).toMatchObject({ kind: 'shape', shape: undefined, color: '#123456' })
  })

  it('pick the face from the name until it is locked', () => {
    expect(faceForName('Pip')).toEqual(faceForName('  pip '))
    expect(BOT_SHAPES).toContain(faceForName('Pip').shape)
    expect(BOT_COLORS.map((c) => c.value)).toContain(faceForName('Pip').color)
    // Names spread over the shapes.
    const shapes = new Set(['Pip', 'Mochi', 'Ziggy', 'Biscuit', 'Nova', 'Pickle', 'Echo', 'Waffles', 'Juniper', 'Dot', 'Sprout', 'Bean'].map((n) => faceForName(n).shape))
    expect(shapes.size).toBeGreaterThan(4)
    const free = { kind: 'shape' as const, shape: 'star' as const, color: '#000000', locked: false }
    expect(botFace('Mochi', free)).toEqual({ kind: 'shape', ...faceForName('Mochi') })
    expect(botFace('Pip', free)).toEqual({ kind: 'shape', ...faceForName('Pip') })
    expect(botFace('Mochi', { ...free, locked: true })).toEqual({ kind: 'shape', shape: 'star', color: '#000000' })
    // Animals keep their animal; the color follows the name unless locked.
    expect(botFace('Mochi', { kind: 'pet', pet: 'fox', color: '#000000', locked: false })).toEqual({ kind: 'pet', pet: 'fox', color: faceForName('Mochi').color })
    expect(botFace('Mochi', { kind: 'pet', pet: 'fox', color: '#000000', locked: true })).toEqual({ kind: 'pet', pet: 'fox', color: '#000000' })
  })

  it('migrate the old experimental flag to the Bots tab switch', () => {
    // Every install saved `false` as the old default, so both values turn the tab on.
    for (const bots of [true, false]) {
      const s = parseSettings({ experimental: { bots } })
      expect(s.botOptions.enabled).toBe(true)
      expect(s).not.toHaveProperty('experimental')
    }
    // A saved choice wins.
    expect(parseSettings({ experimental: { bots: true }, botOptions: { enabled: false } }).botOptions.enabled).toBe(false)
    expect(parseSettings({ botOptions: { enabled: false } }).botOptions).toEqual({ enabled: false, muted: false })
  })

  it("keep one ongoing chat per bot: its latest, until a new one starts", () => {
    const metas = [
      { id: 'plain', updatedAt: 50 },
      { id: 'old', botId: 'critic', updatedAt: 10 },
      { id: 'other', botId: 'pip', updatedAt: 40 },
      { id: 'recent', botId: 'critic', updatedAt: 30 },
    ]
    expect(latestBotThread(metas, 'critic')?.id).toBe('recent')
    expect(botThreads(metas, 'critic').map((m) => m.id)).toEqual(['recent', 'old'])
    expect(latestBotThread(metas, 'nobody')).toBeUndefined()
    // "New conversation": a fresh chat with the bot becomes the one it opens to.
    const fresh = newSession('/x', { providerId: 'mock', modelId: 'm' }, { botId: 'critic' })
    expect(fresh.meta.botId).toBe('critic')
    expect(latestBotThread([...metas, { ...fresh.meta, updatedAt: 60 }], 'critic')?.id).toBe(fresh.meta.id)
    // Bot chats leave the Sessions list while the tab is on and the bot exists.
    expect(isBotChat(botSettings(), { botId: 'critic' })).toBe(true)
    expect(isBotChat(botSettings({ enabled: false }), { botId: 'critic' })).toBe(true)
    expect(isBotChat(botSettings({}, false), { botId: 'critic' })).toBe(false)
    expect(isBotChat(botSettings(), { botId: 'gone' })).toBe(false)
    expect(isBotChat(botSettings(), {})).toBe(false)
  })

  it('preview the last real line of a chat', () => {
    expect(chatPreview([])).toBe('')
    expect(
      chatPreview([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '**Hey** there,\n  friend' },
        { role: 'tool', toolCallId: '1', name: 'x', content: 'tool output' },
        { role: 'user', content: 'note', synthetic: 'reminder' },
      ]),
    ).toBe('Hey there, friend')
    expect(chatPreview([{ role: 'assistant', content: 'a'.repeat(200) }], 10)).toBe(`${'a'.repeat(9)}…`)
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
    // The tab lists turned-off bots too (dimmed); nothing while the tab is off.
    expect(shownBots(botSettings({ enabled: false })).map((b) => b.id)).toEqual(['critic'])
    expect(shownBots(botSettings({}, false))).toEqual([])
  })

  it("start chats with the bot's model and mode, else the defaults", () => {
    const fallback = { model: { providerId: 'openrouter', modelId: 'openrouter/free' }, mode: 'ask' as const }
    const model = { providerId: 'mock', modelId: 'big' }
    expect(chatDefaults(botSettings({ model, mode: 'plan' }), 'critic', fallback)).toEqual({ model, mode: 'plan' })
    expect(chatDefaults(botSettings(), 'critic', fallback)).toEqual({ model: fallback.model, mode: 'auto' })
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
    expect(system(req)).toContain('# Character: Critic')
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
      expect(system(req)).not.toContain('# Character')
      expect(toolNames(req)).toEqual(toolNames(base.provider.requests[0]))
      expect(req.reasoningEffort).toBeUndefined()
      // The chat keeps its bot, so turning it back on restores the persona.
      expect(agent.session.meta.botId).toBe('critic')
    }
  })

  it("applies a change to the bot's settings on the next request", async () => {
    const s = botSettings()
    const { agent, provider } = await run(s, { botId: 'critic', script: [text('one'), text('two')] })
    agent.updateSettings({ ...s, botOptions: { enabled: false, muted: false } })
    await agent.send('again')
    expect(system(provider.requests[0])).toContain('# Character: Critic')
    expect(system(provider.requests[1])).not.toContain('# Character')
  })
})
