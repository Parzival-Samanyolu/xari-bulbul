import { describe, expect, it } from 'vitest'
import { OpenAICompatProvider } from '../src/providers/openai-compat.js'
import { fetchSynapseAccount, withSynapseDefaults } from '../src/providers/synapse.js'
import { modelMaker } from '../src/providers/catalog.js'
import { defaultSettings } from '../src/settings/schema.js'

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
          plan: 'free', plan_label: 'Free',
          limits: { requests_per_minute: 10, tokens_per_day: 200_000, max_output_tokens: 4096, max_concurrent: 1, max_context_tokens: 32_000 },
          usage: { tokens_today: 1234, resets_at: 1_800_000_000 },
        },
      })
    }) as unknown as typeof globalThis.fetch
    const a = await fetchSynapseAccount(BASE, 'syn_sk_x', fetch)
    expect(url).toBe(`${BASE}/key`)
    expect(auth).toBe('Bearer syn_sk_x')
    expect(a).toEqual({
      plan: 'free', planLabel: 'Free',
      limits: { requestsPerMinute: 10, tokensPerDay: 200_000, maxOutputTokens: 4096, maxConcurrent: 1, maxContextTokens: 32_000 },
      tokensToday: 1234, resetsAt: 1_800_000_000_000,
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
