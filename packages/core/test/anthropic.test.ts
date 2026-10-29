import { describe, expect, it } from 'vitest'
import { AnthropicProvider, anthropicCost, toAnthropicMessages } from '../src/providers/anthropic.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { BUILTIN_PROVIDERS } from '../src/settings/schema.js'
import type { StreamEvent } from '../src/providers/types.js'
import { sseResponse } from './helpers.js'
import { BATCH_POLL } from '../src/providers/batch.js'

const config = BUILTIN_PROVIDERS.find((c) => c.id === 'anthropic')!

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const opus = {
  id: 'claude-opus-5-5',
  display_name: 'Claude Opus 5.5',
  created_at: '2026-09-01T00:00:00Z',
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { supported: true } },
}
const old = {
  id: 'claude-old',
  display_name: 'Claude Old',
  max_tokens: 8192,
  capabilities: { thinking: { supported: false, types: { adaptive: { supported: false } } }, effort: { supported: false } },
}

/** Serves the model list and records every /messages request. */
function fakeApi(stream: unknown[], models: unknown[] = [opus, old]) {
  const sent: { body: any; headers: Record<string, string> }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.includes('/models')) return new Response(JSON.stringify({ data: models, has_more: false }))
    sent.push({ body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> })
    return sseResponse(stream)
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

const toolTurn = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me look.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'both.' } },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu2', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

describe('AnthropicProvider', () => {
  it('streams thinking, text and parallel tool calls, with cache usage and replayable blocks', async () => {
    const { fetch, sent } = fakeApi(toolTurn)
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    const events = await collect(
      p.chat({ model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }] }),
    )

    expect(events.filter((e) => e.type === 'reasoning').map((e: any) => e.delta).join('')).toBe('Let me look.')
    expect(events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Reading both.')
    expect(events.filter((e) => e.type === 'tool_call').map((e: any) => e.call)).toEqual([
      { id: 'tu1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { id: 'tu2', name: 'read_file', arguments: '{"path":"b.ts"}' },
    ])
    // Opus 5.5: 10 in × $4 + 5 cache writes × $5 + 90 cache reads × $0.20 + 42 out × $20, per million.
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { promptTokens: 105, completionTokens: 42, cachedTokens: 90, cost: (40 + 25 + 18 + 840) / 1e6 },
    })
    const extra = (events.find((e) => e.type === 'extra') as any).extra.anthropic
    expect(extra.content).toEqual([
      { type: 'thinking', thinking: 'Let me look.', signature: 'sig' },
      { type: 'text', text: 'Reading both.' },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'tu2', name: 'read_file', input: { path: 'b.ts' } },
    ])
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' })

    const { body, headers } = sent[0]
    expect(headers['x-api-key']).toBe('k')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toContain('thinking-binding-controls-2026-08-01')
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(body.system).toBe('sys')
    expect(body.max_tokens).toBe(64_000)
    expect(body.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(body).not.toHaveProperty('output_config')
    expect(body.fallbacks).toBe('default')
    expect(body.tools).toEqual([{ name: 'read_file', description: 'd', input_schema: { type: 'object' } }])
    expect(body).not.toHaveProperty('temperature')
  })

  it("leaves thinking and effort out for models that don't support them", async () => {
    const { fetch, sent } = fakeApi([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    await collect(p.chat({ model: 'claude-old', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] }))
    expect(sent[0].body).not.toHaveProperty('thinking')
    expect(sent[0].body).not.toHaveProperty('output_config')
    expect(sent[0].body).not.toHaveProperty('fallbacks')
    expect(sent[0].body.max_tokens).toBe(8192)
    expect(sent[0].headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01')
  })

  it('sends a chosen effort, mapping "none" to low', async () => {
    const { fetch, sent } = fakeApi([])
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    await collect(p.chat({ model: 'claude-opus-5-5', reasoningEffort: 'none', messages: [{ role: 'user', content: 'hi' }] }))
    await collect(p.chat({ model: 'claude-opus-5-5', reasoningEffort: 'high', messages: [{ role: 'user', content: 'hi' }] }))
    expect(sent.map((r) => r.body.output_config)).toEqual([{ effort: 'low' }, { effort: 'high' }])
  })

  it('passes xhigh and max through, and sends the closest level older models accept', async () => {
    const { fetch, sent } = fakeApi([])
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    const run = (model: string, reasoningEffort: 'xhigh' | 'max') => collect(p.chat({ model, reasoningEffort, messages: [{ role: 'user', content: 'hi' }] }))
    await run('claude-opus-5-5', 'xhigh')
    await run('claude-opus-5-5', 'max')
    await run('claude-sonnet-4-6', 'xhigh')
    await run('claude-opus-4-5', 'max')
    expect(sent.map((r) => r.body.output_config.effort)).toEqual(['xhigh', 'max', 'high', 'high'])
  })

  it('turns on fast mode only for models that have it', async () => {
    const usage = [{ type: 'message_start', message: { usage: { input_tokens: 1_000_000, output_tokens: 0, speed: 'fast' } } }]
    const { fetch, sent } = fakeApi(usage)
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    const events = await collect(p.chat({ model: 'claude-opus-5-5', speed: 'fast', messages: [{ role: 'user', content: 'hi' }] }))
    await collect(p.chat({ model: 'claude-sonnet-5-5', speed: 'fast', messages: [{ role: 'user', content: 'hi' }] }))
    expect(sent[0].body.speed).toBe('fast')
    expect(sent[0].headers['anthropic-beta']).toContain('fast-mode-2026-02-01')
    expect(sent[1].body).not.toHaveProperty('speed')
    expect(sent[1].headers['anthropic-beta']).not.toContain('fast-mode')
    // Fast mode bills at twice the standard rate ($4/M input on Opus 5.5).
    expect(events).toContainEqual({ type: 'usage', usage: expect.objectContaining({ cost: 8 }) })
  })

  it('falls back to standard speed when fast mode is rate limited', async () => {
    const sent: any[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      if (url.includes('/models')) return new Response(JSON.stringify({ data: [opus], has_more: false }))
      const body = JSON.parse(init.body as string)
      sent.push(body)
      if (body.speed === 'fast') return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
      return sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    }) as typeof globalThis.fetch
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    await collect(p.chat({ model: 'claude-opus-5-5', speed: 'fast', messages: [{ role: 'user', content: 'hi' }] }))
    expect(sent.map((b) => b.speed ?? 'standard')).toEqual(['fast', 'standard'])
  })

  it('sends batch requests through Message Batches at half price', async () => {
    BATCH_POLL.firstMs = 1
    const calls: { url: string; method: string; body?: any }[] = []
    let polls = 0
    const message = {
      model: 'claude-opus-5-5',
      content: [
        { type: 'thinking', thinking: 'Plan.', signature: 'sig' },
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.ts' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined })
      if (url.endsWith('/models?limit=1000')) return new Response(JSON.stringify({ data: [opus], has_more: false }))
      if (url.endsWith('/messages/batches')) return new Response(JSON.stringify({ id: 'b1', processing_status: 'in_progress' }))
      if (url.endsWith('/messages/batches/b1'))
        return new Response(JSON.stringify({ id: 'b1', processing_status: ++polls > 1 ? 'ended' : 'in_progress', results_url: 'https://api.anthropic.com/v1/messages/batches/b1/results' }))
      if (url.endsWith('/results')) return new Response(JSON.stringify({ custom_id: 'step', result: { type: 'succeeded', message } }) + '\n')
      throw new Error(`unexpected ${url}`)
    }) as typeof globalThis.fetch
    const p = new AnthropicProvider({ config, apiKey: 'k', fetch })
    const events = await collect(p.chat({ model: 'claude-opus-5-5', speed: 'batch', messages: [{ role: 'user', content: 'hi' }] }))
    const create = calls.find((c) => c.url.endsWith('/messages/batches'))!
    expect(create.body.requests[0].params).not.toHaveProperty('stream')
    expect(create.body.requests[0].params).not.toHaveProperty('fallbacks')
    expect(polls).toBe(2)
    expect(events[0]).toMatchObject({ type: 'status' })
    expect(events).toContainEqual({ type: 'text', delta: 'Reading it.' })
    expect(events).toContainEqual({ type: 'reasoning', delta: 'Plan.' })
    expect(events).toContainEqual({ type: 'tool_call', call: { id: 'tu1', name: 'read_file', arguments: '{"path":"a.ts"}' } })
    expect(events).toContainEqual({ type: 'usage', usage: expect.objectContaining({ cost: 2 }) })
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' })
  })

  it('prices known models, including dated ids and the Haiku 5.5 long-prompt tier', () => {
    const t = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }
    expect(anthropicCost('claude-sonnet-5-5', t)).toBe(12)
    expect(anthropicCost('claude-haiku-4-5-20251001', t)).toBe(6)
    expect(anthropicCost('claude-haiku-5-5', { ...t, input: 50_000, output: 0 })).toBeCloseTo(0.005)
    expect(anthropicCost('claude-haiku-5-5', { ...t, input: 200_000, output: 0 })).toBeCloseTo(0.1)
    expect(anthropicCost('claude-unknown', t)).toBeUndefined()
  })

  it('raises refusals as non-retryable errors and stream errors as retryable', async () => {
    const refusal = fakeApi([{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { explanation: 'Not allowed.' } } }])
    await expect(collect(new AnthropicProvider({ config, apiKey: 'k', fetch: refusal.fetch }).chat({ model: 'claude-opus-5-5', messages: [] }))).rejects.toMatchObject({
      message: expect.stringMatching(/declined this request\. Not allowed\./),
      retryable: false,
    })
    const overloaded = fakeApi([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
    await expect(collect(new AnthropicProvider({ config, apiKey: 'k', fetch: overloaded.fetch }).chat({ model: 'claude-opus-5-5', messages: [] }))).rejects.toMatchObject({
      retryable: true,
    })
    await expect(collect(new AnthropicProvider({ config, fetch: overloaded.fetch }).chat({ model: 'x', messages: [] }))).rejects.toThrow(/No API key/)
  })

  it('pages through the model list and maps it', async () => {
    const urls: string[] = []
    const fetch = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(url.includes('after_id') ? { data: [old], has_more: false } : { data: [opus], has_more: true, last_id: 'claude-opus-5-5' }))
    }) as unknown as typeof globalThis.fetch
    const models = await new AnthropicProvider({ config, apiKey: 'k', fetch }).listModels()
    expect(urls).toEqual(['https://api.anthropic.com/v1/models?limit=1000', 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5'])
    expect(models.map((m) => m.id)).toEqual(['claude-old', 'claude-opus-5-5'])
    expect(models[1]).toMatchObject({ name: 'Claude Opus 5.5', contextLength: 1_000_000, supportsTools: true, supportsImages: true, free: false, created: Date.parse('2026-09-01T00:00:00Z') / 1000 })
  })

  it('is picked by the registry for api: anthropic', () => {
    const r = new ProviderRegistry(BUILTIN_PROVIDERS, () => 'k')
    expect(r.get('anthropic')).toBeInstanceOf(AnthropicProvider)
    expect(r.get('openai')).not.toBeInstanceOf(AnthropicProvider)
  })
})

describe('toAnthropicMessages', () => {
  it('merges tool results into one user turn, replays stored blocks verbatim, and sends images', () => {
    const stored = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'tool_use', id: 'b', name: 'x', input: {} }]
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look', images: [{ name: 'p.png', mediaType: 'image/png', data: 'AAA' }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }, { id: 'b', name: 'x', arguments: '{}' }], extra: { anthropic: { model: 'm', content: stored } } },
      { role: 'tool', toolCallId: 'a', name: 'x', content: 'one' },
      { role: 'tool', toolCallId: 'b', name: 'x', content: '' },
      { role: 'user', content: '', note: 'reminder', synthetic: 'reminder' },
      { role: 'assistant', content: 'Done.', toolCalls: [{ id: 'c', name: 'y', arguments: '{"q":1}' }] },
    ])
    expect(system).toBe('sys')
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'look' },
    ])
    expect(messages[1].content).toEqual(stored)
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'one' },
      { type: 'tool_result', tool_use_id: 'b', content: '(no output)' },
      { type: 'text', text: '<system-reminder>\nreminder\n</system-reminder>' },
    ])
    expect(messages[3].content).toEqual([
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', id: 'c', name: 'y', input: { q: 1 } },
    ])
  })
})
