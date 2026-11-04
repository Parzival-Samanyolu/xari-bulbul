import { describe, expect, it } from 'vitest'
import { newBot, newLobby } from '../src/bots/bots.js'
import { addressedBots, cleanReply, lastSpeaker, lobbySystemPrompt, lobbyTranscript, LobbyChat } from '../src/bots/lobby.js'
import type { AgentEvent } from '../src/loop/agent.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings, parseSettings, type Bot, type Settings } from '../src/settings/schema.js'
import type { ChatMessage } from '../src/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider } from './helpers.js'

const say = (t: string): StreamEvent[] => [{ type: 'text', delta: t }, { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } }]

function bot(name: string, over: Partial<Bot> = {}): Bot {
  return { ...newBot(name, []), ...over }
}

const ali = bot('Ali', { tagline: 'Grumpy chef' })
const bea = bot('Bea', { tagline: 'Optimist' })
const cem = bot('Cem Yılmaz')

function setup(script: (StreamEvent[] | { events: StreamEvent[]; fail: Error })[], opts: { bots?: Bot[]; maxRounds?: number; providers?: Record<string, MockProvider> } = {}) {
  const settings: Settings = defaultSettings()
  settings.models.default = { providerId: 'mock', modelId: 'm' }
  settings.agent.requestRetries = 0
  settings.bots = opts.bots ?? [ali, bea, cem]
  settings.lobbies = [{ ...newLobby('Kitchen', settings.bots.map((b) => b.id), []), maxRounds: opts.maxRounds ?? 0 }]
  const provider = new MockProvider(script)
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  for (const p of Object.values(opts.providers ?? {})) registry.register(p)
  const usage = new UsageTracker(null)
  const session = newSession('/tmp', settings.models.default, { lobbyId: settings.lobbies[0].id })
  const events: AgentEvent[] = []
  const saved: number[] = []
  const chat = new LobbyChat({ session, settings, registry, usage, onEvent: (e) => events.push(e), onSave: (s) => saved.push(s.messages.length) })
  const lines = () => session.messages.map((m) => (m.role === 'user' ? `You: ${m.content}` : m.role === 'assistant' ? `${m.speaker?.name}: ${m.content}` : '?'))
  return { settings, provider, usage, session, events, saved, chat, lines }
}

describe('lobby transcript', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Hi all' },
    { role: 'assistant', content: 'Hello.', speaker: { id: ali.id, name: 'Ali' } },
    { role: 'assistant', content: 'Hey!', speaker: { id: bea.id, name: 'Bea' } },
    { role: 'user', content: 'reminder', synthetic: 'reminder' },
    { role: 'user', content: 'How are you?' },
    { role: 'assistant', content: 'Fine.', speaker: { id: ali.id, name: 'Ali' } },
  ]

  it("maps a bot's own lines to assistant and the rest to labeled user lines", () => {
    const out = lobbyTranscript(messages, bea, [ali, bea, cem])
    expect(out).toEqual([
      { role: 'user', content: '[You]: Hi all\n\n[Ali]: Hello.' },
      { role: 'assistant', content: 'Hey!' },
      { role: 'user', content: '[You]: How are you?\n\n[Ali]: Fine.' },
    ])
  })

  it('ends with a user message even when the bot spoke last', () => {
    const out = lobbyTranscript(messages, ali, [ali, bea, cem])
    expect(out[0]).toEqual({ role: 'user', content: '[You]: Hi all' })
    expect(out.at(-1)!.role).toBe('user')
    expect(out.at(-2)).toEqual({ role: 'assistant', content: 'Fine.' })
  })

  it('names a deleted bot by the name it had', () => {
    const out = lobbyTranscript(messages, cem, [bea, cem])
    expect(out[0].content).toContain('[Ali]: Hello.')
  })

  it('keeps only the latest lines', () => {
    const many: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    const out = lobbyTranscript(many, ali, [ali], 3)
    expect(out).toEqual([{ role: 'user', content: '[You]: m7\n\n[You]: m8\n\n[You]: m9' }])
  })

  it('knows who spoke last', () => {
    expect(lastSpeaker(messages)).toBe(ali.id)
    expect(lastSpeaker(messages.slice(0, 5))).toBeUndefined()
  })
})

describe('lobby mentions', () => {
  it('orders bots by where they are first named', () => {
    expect(addressedBots('@bea what do you think, and Ali?', [ali, bea, cem]).map((b) => b.name)).toEqual(['Bea', 'Ali'])
    expect(addressedBots('@Cem tell a joke', [ali, bea, cem]).map((b) => b.name)).toEqual(['Cem Yılmaz'])
    expect(addressedBots('cem yılmaz, hi', [ali, bea, cem]).map((b) => b.name)).toEqual(['Cem Yılmaz'])
  })

  it('needs whole words', () => {
    expect(addressedBots('Alice and Beatrice are coming', [ali, bea, cem])).toEqual([])
    expect(addressedBots('hello everyone', [ali, bea, cem])).toEqual([])
  })
})

describe('lobby replies', () => {
  it('drops its own label, cuts lines for others and reads [pass]', () => {
    expect(cleanReply('[Ali]: Hi there', ali, [ali, bea])).toBe('Hi there')
    expect(cleanReply('**Ali:** Hi', ali, [ali, bea])).toBe('Hi')
    expect(cleanReply('Sure thing.\n[Bea]: I agree!\n[You]: ok', ali, [ali, bea])).toBe('Sure thing.')
    expect(cleanReply(' [pass] ', ali, [ali, bea])).toBe('')
    expect(cleanReply('[PASS]', ali, [ali, bea])).toBe('')
    expect(cleanReply('Bea: and then', ali, [ali, bea])).toBe('')
  })

  it('writes the lobby note into the system prompt', () => {
    const p = lobbySystemPrompt({ ...ali, persona: 'Hates cilantro.' }, { name: 'Kitchen' }, [ali, bea, cem], { name: 'Murad' })
    expect(p).toContain('Hates cilantro.')
    expect(p).toContain('Group chat "Kitchen"')
    expect(p).toContain('- Bea: Optimist')
    expect(p).toContain('- You: the user (Murad)')
    expect(p).not.toContain('- Ali')
    expect(p).toContain('[pass]')
    expect(p).toMatch(/1–4 sentences/)
  })
})

describe('LobbyChat', () => {
  it('has every member reply once in order, each seeing the others', async () => {
    const { chat, provider, lines, events, usage, session } = setup([say('Ali here.'), say('Bea here.'), say('Cem here.')])
    expect(await chat.send('hello')).toBe('done')
    expect(lines()).toEqual(['You: hello', 'Ali: Ali here.', 'Bea: Bea here.', 'Cem Yılmaz: Cem here.'])
    // Cem saw the user and both earlier replies as labeled user content.
    const last = provider.requests[2].messages
    expect(last[0].role).toBe('system')
    expect(last[0].content).toContain('You are "Cem Yılmaz"')
    expect(last.slice(1)).toEqual([{ role: 'user', content: '[You]: hello\n\n[Ali]: Ali here.\n\n[Bea]: Bea here.' }])
    expect(provider.requests.every((r) => !r.tools)).toBe(true)
    expect(events.filter((e) => e.type === 'speaker').map((e) => (e as { botId: string | null }).botId)).toEqual([ali.id, bea.id, cem.id, null])
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'done' })
    expect(usage.summary(session.meta.id).session.requests).toBe(3)
    expect(session.meta.title).toBe('Kitchen')
  })

  it('lets only the named bots answer first', async () => {
    const { chat, lines } = setup([say('Me? Sure.'), say('And me.')])
    await chat.send('@Cem and Bea, what now?')
    expect(lines()).toEqual(['You: @Cem and Bea, what now?', 'Cem Yılmaz: Me? Sure.', 'Bea: And me.'])
  })

  it('keeps talking for up to maxRounds and ends when everyone passes', async () => {
    const { chat, lines, provider } = setup(
      [
        say('A1'), say('B1'), say('C1'), // answers to you
        say('A2'), say('[pass]'), say('C2'), // round 1
        say('[pass]'), say('[pass]'), // round 2: Ali and Bea pass; Cem spoke last, so it's skipped
      ],
      { maxRounds: 5 },
    )
    await chat.send('go')
    expect(lines()).toEqual(['You: go', 'Ali: A1', 'Bea: B1', 'Cem Yılmaz: C1', 'Ali: A2', 'Cem Yılmaz: C2'])
    expect(provider.requests).toHaveLength(8)
  })

  it('stops after maxRounds and skips a bot with nothing new to react to', async () => {
    const { chat, lines, provider } = setup([say('A1'), say('B1'), say('A2'), say('B2')], { bots: [ali, bea], maxRounds: 1 })
    await chat.send('go')
    expect(lines()).toEqual(['You: go', 'Ali: A1', 'Bea: B1', 'Ali: A2', 'Bea: B2'])
    expect(provider.requests).toHaveLength(4)
    // Keep talking: Bea spoke last, so Ali goes first; one more round.
    const more = setup([say('A1'), say('B1'), say('A3'), say('[pass]')], { bots: [ali, bea], maxRounds: 1 })
    await more.chat.send('@Ali hi')
    expect(more.lines()).toEqual(['You: @Ali hi', 'Ali: A1', 'Bea: B1'])
    expect(await more.chat.keepTalking()).toBe('done')
    expect(more.lines().at(-1)).toBe('Ali: A3')
  })

  it("never shows a pass while it streams, and skips turned-off members", async () => {
    const { chat, events, lines } = setup(
      [
        [
          { type: 'text', delta: '[pa' },
          { type: 'text', delta: 'ss]' },
        ],
        say('Hi'),
      ],
      { bots: [ali, bea, { ...cem, enabled: false }] },
    )
    await chat.send('yo')
    expect(lines()).toEqual(['You: yo', 'Bea: Hi'])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Hi'])
  })

  it("uses each bot's own model and thinking setting", async () => {
    const other = new MockProvider([say('From other')], { id: 'other' })
    const { chat, provider } = setup([say('From mock')], { bots: [ali, { ...bea, model: { providerId: 'other', modelId: 'm' }, thinking: 'high' }], providers: { other } })
    await chat.send('hi')
    expect(provider.requests).toHaveLength(1)
    expect(other.requests[0].reasoningEffort).toBe('high')
    expect(other.requests[0].messages[0].content).toContain('You are "Bea"')
  })

  it('reports a failing bot and lets the others talk', async () => {
    const { chat, lines, events } = setup([{ events: [], fail: new Error('boom') }, say('Still here')], { bots: [ali, bea] })
    expect(await chat.send('hi')).toBe('done')
    expect(lines()).toEqual(['You: hi', 'Bea: Still here'])
    expect(events.some((e) => e.type === 'notice' && e.text.startsWith("Ali couldn't reply"))).toBe(true)
  })

  it('aborts the reply streaming right away on stop', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = {
      id: 'mock',
      name: 'Mock',
      listModels: async () => [],
      async *chat(req: { signal?: AbortSignal }) {
        yield { type: 'text', delta: 'Half a ' } as StreamEvent
        await Promise.race([gate, new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))))])
        yield { type: 'text', delta: 'sentence' } as StreamEvent
      },
    }
    const { chat, lines, events } = setup([], { bots: [ali, bea] })
    ;(chat as unknown as { o: { registry: ProviderRegistry } }).o.registry.register(slow)
    const done = chat.send('hi')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.running).toBe(true)
    chat.stop()
    expect(await done).toBe('aborted')
    release()
    expect(lines()).toEqual(['You: hi', 'Ali: Half a…'])
    expect(chat.running).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'aborted' })
  })
})

describe('lobby settings', () => {
  it('defaults to no lobbies and fills a partial lobby', () => {
    expect(parseSettings({}).lobbies).toEqual([])
    const s = parseSettings({ lobbies: [{ id: 'l', botIds: ['a', 'b'] }] })
    expect(s.lobbies[0]).toEqual({ id: 'l', name: 'Lobby', botIds: ['a', 'b'], maxRounds: 3 })
    expect(parseSettings({ lobbies: [{ id: 'l', maxRounds: 99 }] }).lobbies[0].maxRounds).toBe(3)
  })
})
