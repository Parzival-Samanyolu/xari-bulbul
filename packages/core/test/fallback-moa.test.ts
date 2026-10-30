import { describe, expect, it } from 'vitest'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { failoverKind } from '../src/loop/fallback.js'
import { moaOn, moaReady } from '../src/moa/config.js'
import { mixtureTranscript } from '../src/moa/mixture.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { ProviderError, type Provider, type StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings, type Settings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import type { ChatMessage, ModelInfo } from '../src/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, tmpDir } from './helpers.js'

type Script = ConstructorParameters<typeof MockProvider>[0]
const text = (t: string, p = 10, c = 5): StreamEvent[] => [{ type: 'text', delta: t }, { type: 'usage', usage: { promptTokens: p, completionTokens: c } }]
const fail = (status: number | undefined, message = `error ${status}`, retryable = status != null && (status === 429 || status >= 500)) => ({
  events: [],
  fail: new ProviderError(message, status, retryable),
})
const ref = (providerId: string) => ({ providerId, modelId: 'm' })
/** Cost of one request at MockProvider's prices. */
const cost = (p: number, c: number) => p * 1e-6 + c * 2e-6

async function setup(
  providers: Record<string, Script | { script: Script; contextLength?: number; name?: string } | Provider>,
  opts: { model?: string; configure?: (s: Settings) => void } = {},
) {
  const dir = tmpDir()
  const registry = new ProviderRegistry([], () => undefined)
  const mocks: Record<string, MockProvider> = {}
  for (const [id, p] of Object.entries(providers)) {
    if ('chat' in p) {
      registry.register(p)
      registry.seedCache(id, await p.listModels())
      continue
    }
    const o = Array.isArray(p) ? { script: p } : p
    const mock = new MockProvider(o.script, { id, contextLength: o.contextLength, modelName: o.name })
    mocks[id] = mock
    registry.register(mock)
    registry.seedCache(id, await mock.listModels())
  }
  const settings = defaultSettings()
  settings.permissions.mode = 'auto'
  settings.agent.requestRetries = 0
  opts.configure?.(settings)
  const events: AgentEvent[] = []
  const usage = new UsageTracker(null)
  const agent = new Agent({
    session: newSession(dir, ref(opts.model ?? 'main')),
    registry,
    tools: builtinTools(),
    settings,
    usage,
    permissions: new Permissions(settings.permissions, dir),
    askPermission: async () => ({ type: 'allow' }),
    onEvent: (e) => events.push(e),
  })
  const last = () => agent.session.messages.at(-1) as Extract<ChatMessage, { role: 'assistant' }>
  return { dir, agent, mocks, events, usage, settings, last }
}

const fallbacks = (...ids: string[]) => (s: Settings) => (s.models.fallbacks = ids.map(ref))

describe('Fallback models', () => {
  it('continues on the next model after a 5xx outlasts the retries, and attributes usage to it', async () => {
    const { agent, mocks, events, usage, last } = await setup(
      {
        main: { script: [fail(503), fail(503)], name: 'Gemini' },
        fb: { script: [text('From the fallback.', 20, 8)], name: 'Meta: Llama 3.3' },
      },
      { configure: (s) => ((s.agent.requestRetries = 1), fallbacks('fb')(s)) },
    )
    expect(await agent.send('hi')).toBe('done')
    expect(mocks.main.requests).toHaveLength(2)
    expect(last()).toMatchObject({ role: 'assistant', content: 'From the fallback.' })
    expect(events).toContainEqual({ type: 'fallback', from: ref('main'), to: ref('fb'), reason: '503', text: 'Gemini failed (503). Continued on Llama 3.3.' })
    const records = events.flatMap((e) => (e.type === 'usage' ? [e.record] : []))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ providerId: 'fb', modelId: 'm', promptTokens: 20, completionTokens: 8 })
    expect(usage.summary(agent.session.meta.id).session.cost).toBeCloseTo(cost(20, 8))
  })

  it('falls back on a 429 once retries are used up', async () => {
    const { agent, events, last } = await setup({ main: [fail(429)], fb: [text('ok')] }, { configure: fallbacks('fb') })
    expect(await agent.send('hi')).toBe('done')
    expect(last().content).toBe('ok')
    expect(events.find((e) => e.type === 'fallback')).toMatchObject({ reason: '429' })
  })

  it('skips a model that is not found for the rest of the turn, then tries it again next turn', async () => {
    const { agent, mocks, last } = await setup(
      {
        main: [fail(404, 'Mock lists m but does not serve it (404)'), text('main is back')],
        fb: [[{ type: 'tool_call', call: { id: '1', name: 'list_dir', arguments: '{}' } }], text('done on fallback')],
      },
      { configure: fallbacks('fb') },
    )
    expect(await agent.send('look around')).toBe('done')
    expect(mocks.main.requests).toHaveLength(1)
    expect(mocks.fb.requests).toHaveLength(2)
    expect(last().content).toBe('done on fallback')
    expect(await agent.send('again')).toBe('done')
    expect(last().content).toBe('main is back')
  })

  it('tries the main model first on every step after a passing failure', async () => {
    const { agent, mocks, last } = await setup(
      {
        main: [fail(502), text('main answered step two')],
        fb: [[{ type: 'tool_call', call: { id: '1', name: 'list_dir', arguments: '{}' } }]],
      },
      { configure: fallbacks('fb') },
    )
    expect(await agent.send('hi')).toBe('done')
    expect(mocks.main.requests).toHaveLength(2)
    expect(mocks.fb.requests).toHaveLength(1)
    expect(last().content).toBe('main answered step two')
  })

  it('follows the fallback order, chaining notices', async () => {
    const { agent, mocks, events, last } = await setup({ main: [fail(500)], fb1: [fail(500)], fb2: [text('third time')] }, { configure: fallbacks('fb1', 'fb2') })
    expect(await agent.send('hi')).toBe('done')
    expect(last().content).toBe('third time')
    expect(mocks.fb1.requests).toHaveLength(1)
    const hops = events.flatMap((e) => (e.type === 'fallback' ? [[e.from.providerId, e.to.providerId]] : []))
    expect(hops).toEqual([
      ['main', 'fb1'],
      ['fb1', 'fb2'],
    ])
  })

  it('moves on from a provider that is not connected or has no key', async () => {
    const { agent, events, last } = await setup({ fb1: [fail(undefined, 'No API key set for Fb1. Add one in Settings.')], fb2: [text('ok')] }, { model: 'gone', configure: fallbacks('fb1', 'fb2') })
    expect(await agent.send('hi')).toBe('done')
    expect(last().content).toBe('ok')
    expect(events.flatMap((e) => (e.type === 'fallback' ? [e.reason] : []))).toEqual(['not connected', 'no API key'])
  })

  it('does not fall back when the user stops the turn', async () => {
    let agent!: Agent
    const stopping: Provider = {
      id: 'main',
      name: 'Main',
      listModels: async (): Promise<ModelInfo[]> => [],
      async *chat() {
        agent.stop()
        throw new ProviderError('Main error 503', 503, true)
      },
    }
    const s = await setup({ main: stopping, fb: [text('should not run')] }, { configure: fallbacks('fb') })
    agent = s.agent
    expect(await agent.send('hi')).toBe('aborted')
    expect(s.mocks.fb.requests).toHaveLength(0)
    expect(s.events.some((e) => e.type === 'fallback')).toBe(false)
  })

  it('does not fall back on a 400 from our own request', async () => {
    const { agent, mocks, events } = await setup({ main: [fail(400, 'Main error 400: invalid tool schema')], fb: [text('no')] }, { configure: fallbacks('fb') })
    expect(await agent.send('hi')).toBe('error')
    expect(mocks.fb.requests).toHaveLength(0)
    expect(events).toContainEqual({ type: 'error', message: 'Main error 400: invalid tool schema' })
  })

  it('on a context overflow, only falls back to a model with a bigger context', async () => {
    const overflow = fail(400, "Main error 400: This model's maximum context length is 8192 tokens")
    const { agent, mocks, last } = await setup(
      { main: [overflow], small: { script: [text('no')], contextLength: 50_000 }, big: { script: [text('fits now')], contextLength: 400_000 } },
      { configure: fallbacks('small', 'big') },
    )
    expect(await agent.send('a very long question')).toBe('done')
    expect(mocks.small.requests).toHaveLength(0)
    expect(last().content).toBe('fits now')
  })

  it('names the fallbacks it tried when every model fails', async () => {
    const { agent, events } = await setup({ main: [fail(503, 'Main error 503: down')], fb: { script: [fail(429, 'Fb error 429')], name: 'Backup' } }, { configure: fallbacks('fb') })
    expect(await agent.send('hi')).toBe('error')
    const err = events.find((e) => e.type === 'error')
    expect(err).toMatchObject({ message: expect.stringContaining('Fallback models tried first') })
  })

  it('names the chat with a fallback when the title model fails', async () => {
    const { agent, mocks } = await setup(
      { main: [text('Sure.')], tm: [fail(503)], fb: [text('Count words in files')] },
      { configure: (s) => ((s.models.title = ref('tm')), fallbacks('fb')(s)) },
    )
    await agent.send('how many words are in my files?')
    await new Promise((r) => setTimeout(r, 10))
    expect(mocks.tm.requests).toHaveLength(1)
    expect(agent.session.meta.title).toBe('Count words in files')
  })

  it('classifies errors', () => {
    expect(failoverKind(new ProviderError('x', 500, true))).toBe('next')
    expect(failoverKind(new ProviderError('Network error: ECONNRESET'))).toBe('next')
    expect(failoverKind(new ProviderError('x', 401))).toBe('skip')
    expect(failoverKind(new ProviderError('X error 400: model "foo" does not exist', 400))).toBe('skip')
    expect(failoverKind(new ProviderError('X error 400: messages: field required', 400))).toBeNull()
    expect(failoverKind(new Error('TypeError'))).toBeNull()
    const ac = new AbortController()
    ac.abort()
    expect(failoverKind(new ProviderError('x', 500, true), ac.signal)).toBeNull()
  })
})

const mixture = (proposers: string[], aggregator: string | null = 'agg', enabled = true) => (s: Settings) => {
  s.moa.enabled = enabled
  s.moa.proposers = proposers.map(ref)
  s.moa.aggregator = aggregator ? ref(aggregator) : null
}

describe('Mixture of Agents', () => {
  it('asks the proposers, then the aggregator writes the reply from every answer', async () => {
    const { agent, mocks, events, last } = await setup(
      { main: [text('The draft.')], p1: { script: [text('Answer one.')], name: 'One' }, p2: { script: [text('Answer two.')], name: 'Two' }, agg: [text('Combined.')] },
      { configure: mixture(['p1', 'p2']) },
    )
    expect(await agent.send('what is 2+2?')).toBe('done')
    expect(last()).toMatchObject({
      role: 'assistant',
      content: 'Combined.',
      moa: {
        aggregator: ref('agg'),
        proposals: [
          { model: ref('p1'), content: 'Answer one.' },
          { model: ref('p2'), content: 'Answer two.' },
        ],
        draft: { model: ref('main'), content: 'The draft.' },
      },
    })
    // The draft is held back; only the aggregator's reply streams.
    expect(events.flatMap((e) => (e.type === 'text' ? [e.delta] : []))).toEqual(['Combined.'])
    expect(agent.session.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    for (const p of [mocks.p1, mocks.p2]) {
      expect(p.requests[0].tools).toBeUndefined()
      expect(p.requests[0].messages.at(-1)!.content).toContain('what is 2+2?')
    }
    const aggInput = mocks.agg.requests[0].messages.at(-1)!.content
    expect(aggInput).toContain('Answer one.')
    expect(aggInput).toContain('Answer two.')
    expect(aggInput).toContain('The draft.')
    expect(events.flatMap((e) => (e.type === 'mixing' ? [e.phase] : []))).toEqual(['proposing', 'combining'])
  })

  it('runs the proposers in parallel', async () => {
    let started = 0
    const gated = (id: string): Provider => ({
      id,
      name: id,
      listModels: async () => [{ id: 'm', name: id, providerId: id, free: true, supportsTools: true }],
      async *chat() {
        started++
        const t0 = Date.now()
        // Only finishes once all three have started, which can't happen if they run one by one.
        while (started < 3) {
          if (Date.now() - t0 > 2000) throw new Error('not parallel')
          await new Promise((r) => setTimeout(r, 5))
        }
        yield { type: 'text', delta: `answer from ${id}` }
      },
    })
    const { agent, last } = await setup({ main: [text('draft')], p1: gated('p1'), p2: gated('p2'), p3: gated('p3'), agg: [text('ok')] }, { configure: mixture(['p1', 'p2', 'p3']) })
    await agent.send('hi')
    expect(last().moa?.proposals.map((p) => p.content)).toEqual(['answer from p1', 'answer from p2', 'answer from p3'])
  })

  it('leaves out a proposer that fails', async () => {
    const { agent, mocks, last } = await setup(
      { main: [text('draft')], p1: [fail(500, 'P1 error 500: down')], p2: [text('Answer two.')], agg: [text('Combined.')] },
      { configure: mixture(['p1', 'p2']) },
    )
    expect(await agent.send('hi')).toBe('done')
    expect(last().content).toBe('Combined.')
    expect(last().moa?.proposals[0]).toEqual({ model: ref('p1'), error: 'P1 error 500: down' })
    expect(mocks.agg.requests[0].messages.at(-1)!.content).not.toContain('P1 error')
  })

  it("gives the chat model's own answer when every proposer fails", async () => {
    const { agent, mocks, events, last } = await setup({ main: [text('Plain answer.')], p1: [fail(500)], p2: [fail(429)], agg: [text('never')] }, { configure: mixture(['p1', 'p2']) })
    expect(await agent.send('hi')).toBe('done')
    expect(last().content).toBe('Plain answer.')
    expect(last().moa).toBeUndefined()
    expect(mocks.agg.requests).toHaveLength(0)
    expect(events.some((e) => e.type === 'notice' && e.text.includes('None of the mixture models answered'))).toBe(true)
  })

  it("gives the chat model's own answer when the aggregator fails", async () => {
    const { agent, last, events } = await setup({ main: [text('Plain answer.')], p1: [text('a')], p2: [text('b')], agg: [fail(503)] }, { configure: mixture(['p1', 'p2']) })
    expect(await agent.send('hi')).toBe('done')
    expect(last().content).toBe('Plain answer.')
    expect(events.some((e) => e.type === 'notice' && e.text.includes("couldn't combine"))).toBe(true)
  })

  it("adds every proposer's and the aggregator's usage to the chat", async () => {
    const { agent, usage, events } = await setup(
      { main: [text('draft', 100, 10)], p1: [text('a', 50, 20)], p2: [text('b', 60, 30)], agg: [text('c', 200, 40)] },
      { configure: mixture(['p1', 'p2']) },
    )
    await agent.send('hi')
    const records = events.flatMap((e) => (e.type === 'usage' ? [e.record.providerId] : []))
    expect(records.sort()).toEqual(['agg', 'main', 'p1', 'p2'])
    expect(usage.summary(agent.session.meta.id).session.cost).toBeCloseTo(cost(100, 10) + cost(50, 20) + cost(60, 30) + cost(200, 40))
  })

  it('mixes only the final answer; tool steps run on the chat model', async () => {
    const { agent, mocks, last } = await setup(
      {
        main: [[{ type: 'tool_call', call: { id: '1', name: 'list_dir', arguments: '{}' } }], text('There are no files.')],
        p1: [text('a')],
        p2: [text('b')],
        agg: [text('Combined.')],
      },
      { configure: mixture(['p1', 'p2']) },
    )
    expect(await agent.send('what is here?')).toBe('done')
    expect(mocks.p1.requests).toHaveLength(1)
    expect(mocks.p1.requests[0].messages.at(-1)!.content).toContain('[Result of list_dir]')
    expect(last().content).toBe('Combined.')
    expect(agent.session.messages[1]).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'list_dir' }] })
  })

  it('is off unless configured, and follows the chat toggle', async () => {
    const one = await setup({ main: [text('plain')], p1: [text('a')], agg: [text('c')] }, { configure: mixture(['p1']) })
    await one.agent.send('hi')
    expect(one.mocks.p1.requests).toHaveLength(0)
    expect(one.last().content).toBe('plain')

    const off = await setup({ main: [text('plain'), text('draft')], p1: [text('a')], p2: [text('b')], agg: [text('mixed')] }, { configure: mixture(['p1', 'p2'], 'agg', false) })
    await off.agent.send('hi')
    expect(off.mocks.p1.requests).toHaveLength(0)
    off.agent.setMoa(true)
    expect(off.agent.session.meta.moa).toBe(true)
    await off.agent.send('again')
    expect(off.last().content).toBe('mixed')

    const s = defaultSettings()
    expect(moaReady(s)).toBe(false)
    mixture(['p1', 'p2'])(s)
    expect(moaOn(s, {})).toBe(true)
    expect(moaOn(s, { moa: false })).toBe(false)
    s.moa.aggregator = null
    expect(moaOn(s, { moa: true })).toBe(false)
  })

  it('keeps the latest user message when trimming the transcript', () => {
    const big = 'x'.repeat(5000)
    const messages: ChatMessage[] = [
      ...Array.from({ length: 10 }, (_, i): ChatMessage[] => [
        { role: 'user', content: `old ${i} ${big}` },
        { role: 'assistant', content: `reply ${i}` },
      ]).flat(),
      { role: 'user', content: 'the latest question' },
    ]
    const t = mixtureTranscript(messages, 12_000)
    expect(t.startsWith('[Earlier messages left out]')).toBe(true)
    expect(t).toContain('the latest question')
    expect(t).not.toContain('old 0')
    expect(t.length).toBeLessThan(13_000)
  })
})
