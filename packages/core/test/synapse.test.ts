import { describe, expect, it } from 'vitest'
import { OpenAICompatProvider } from '../src/providers/openai-compat.js'
import { fetchSynapseAccount, withSynapseDefaults } from '../src/providers/synapse.js'
import { modelMaker } from '../src/providers/catalog.js'
import { defaultSettings } from '../src/settings/schema.js'
import { computeCost } from '../src/usage/tracker.js'

const BASE = 'https://samanyoluai.duckdns.org/v1'
const config = defaultSettings().providers.find((p) => p.id === 'synapse')!
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Samanyolu AI Synapse', () => {
  it('is built in at the Synapse address', () => {
    expect(config.baseUrl).toBe(BASE)
  })

  it('reads the plan limits a newer server reports in /v1/models', async () => {
    const fetch = (async () =>
      json({ data: [{ id: 'synapse-2', name: 'Synapse 2', context_length: 120_000, max_concurrent: 3, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })) as typeof globalThis.fetch
    const [m] = await new OpenAICompatProvider({ config, apiKey: 'syn_sk_x', fetch }).listModels()
    expect(m).toMatchObject({ id: 'synapse-2', name: 'Synapse 2', contextLength: 120_000, maxConcurrent: 3, free: true, supportsTools: true })
  })

  it('reads priced Synapse models with a cheaper cache price and costs cached tokens at it', async () => {
    const fetch = (async () =>
      json({ data: [{ id: 'synapse-2', context_length: 128_000, pricing: { prompt: '0.000001', completion: '0.000001', input_cache_read: '0.0000001' } }] })) as typeof globalThis.fetch
    const [m] = await new OpenAICompatProvider({ config, apiKey: 'syn_sk_x', fetch }).listModels()
    expect(m.free).toBe(false)
    expect(m.pricing).toEqual({ prompt: 1e-6, completion: 1e-6, cacheRead: 1e-7 })
    // 1M prompt tokens, all cached: a tenth of the price
    expect(computeCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 }, m.pricing)).toBeCloseTo(0.1)
    expect(computeCost({ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 }, m.pricing)).toBeCloseTo(1.55)
  })

  it("assumes the free plan's limits when an older server only lists the id", async () => {
    const fetch = (async () => json({ data: [{ id: 'synapse-2', object: 'model' }] })) as typeof globalThis.fetch
    const [m] = await new OpenAICompatProvider({ config, apiKey: 'syn_sk_x', fetch }).listModels()
    expect(m).toMatchObject({ name: 'Synapse 2', contextLength: 32_000, maxConcurrent: 1, free: true })
  })

  it('leaves other providers alone', () => {
    const m = { id: 'x', name: 'x', providerId: 'p', free: false, supportsTools: true }
    expect(withSynapseDefaults(m, 'https://api.groq.com/openai/v1')).toBe(m)
  })

  it('reads the key plan and today’s tokens from /v1/key', async () => {
    let url = ''
    let auth = ''
    const fetch = (async (u: string, init: RequestInit) => {
      url = u
      auth = (init.headers as Record<string, string>).Authorization
      return json({
        data: {
          plan: 'free', plan_label: 'Neuron',
          limits: { requests_per_minute: 20, usd_per_week: 10, price_per_million_usd: 1, cache_price_per_million_usd: 0.1, max_output_tokens: 8192, max_concurrent: 1, max_context_tokens: 128_000 },
          usage: { usd_this_week: 0.42, tokens_today: 1234, resets_at: 1_800_000_000 },
        },
      })
    }) as unknown as typeof globalThis.fetch
    const a = await fetchSynapseAccount(BASE, 'syn_sk_x', fetch)
    expect(url).toBe(`${BASE}/key`)
    expect(auth).toBe('Bearer syn_sk_x')
    expect(a).toEqual({
      plan: 'free', planLabel: 'Neuron',
      limits: { requestsPerMinute: 20, usdPerWeek: 10, pricePerMillion: 1, cachePricePerMillion: 0.1, maxOutputTokens: 8192, maxConcurrent: 1, maxContextTokens: 128_000 },
      usdThisWeek: 0.42, tokensToday: 1234, resetsAt: 1_800_000_000_000,
    })
  })

  it('returns null on a server without /v1/key and throws on a rejected key', async () => {
    expect(await fetchSynapseAccount(BASE, 'k', (async () => json({ detail: 'Not Found' }, 404)) as typeof fetch)).toBeNull()
    await expect(fetchSynapseAccount(BASE, 'k', (async () => json({ error: {} }, 401)) as typeof fetch)).rejects.toThrow(/401/)
  })

  it('shows the Synapse mark as the maker of synapse models', () => {
    expect(modelMaker('synapse-2')).toBe('synapse')
    expect(modelMaker('samanyolu-ai/synapse-2')).toBe('synapse')
  })
})
