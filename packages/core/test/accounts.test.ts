import { describe, expect, it } from 'vitest'
import { AccountCooldowns, accountKeyId, accountOrder, activeAccountKey, cooldownFor, hasAccountKey, RotatingProvider } from '../src/providers/accounts.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { OpenAICompatProvider } from '../src/providers/openai-compat.js'
import { BUILTIN_PROVIDERS, parseSettings, ProviderConfigSchema, type ProviderConfig } from '../src/settings/schema.js'
import { ProviderError, type StreamEvent } from '../src/providers/types.js'
import { sseResponse } from './helpers.js'

const base = BUILTIN_PROVIDERS[0] // openrouter

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

/** A fetch that answers per API key: 429 for keys in `limited`, else a one-word reply naming the key. */
function keyedFetch(limited: Record<string, number> = {}) {
  const seen: string[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    const key = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '')
    seen.push(key)
    const status = limited[key]
    if (status) return new Response(`{"error":{"message":"limited"}}`, { status, headers: { 'retry-after': '120' } })
    return sseResponse([{ choices: [{ delta: { content: key } }] }, '[DONE]'])
  }) as unknown as typeof globalThis.fetch
  return { fetch, seen }
}

const withAccounts = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  ...base,
  accounts: [
    { id: 'default', label: 'Personal', enabled: true },
    { id: 'work', label: 'Work', enabled: true },
    { id: 'spare', label: 'Spare', enabled: true },
  ],
  ...over,
})

const keys: Record<string, string> = { openrouter: 'k-personal', 'openrouter#work': 'k-work', 'openrouter#spare': 'k-spare' }
const text = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')

describe('provider accounts', () => {
  it('keeps a single saved key working as the implicit default account', () => {
    const config = ProviderConfigSchema.parse({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' })
    expect(config.accounts).toBeUndefined()
    expect(accountOrder(config).map((a) => a.id)).toEqual(['default'])
    expect(accountKeyId('openrouter', 'default')).toBe('openrouter')
    expect(accountKeyId('openrouter', 'work')).toBe('openrouter#work')
    expect(hasAccountKey(config, (id) => id === 'openrouter')).toBe(true)
    expect(activeAccountKey(config, (id) => keys[id])).toBe('k-personal')
    // Old settings files have no account fields and still parse.
    const s = parseSettings({ providers: [{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }] })
    expect(s.providers.find((p) => p.id === 'openrouter')!.accounts).toBeUndefined()
  })

  it('builds a plain provider from the plain key id when there is one account', async () => {
    const { fetch, seen } = keyedFetch()
    const registry = new ProviderRegistry([base], (id) => keys[id], { fetch })
    expect(registry.get('openrouter')).toBeInstanceOf(OpenAICompatProvider)
    expect(text(await collect(registry.get('openrouter').chat({ model: 'm', messages: [] })))).toBe('k-personal')
    expect(seen).toEqual(['k-personal'])
  })

  it('starts with the active account and skips disabled or keyless ones', () => {
    const config = withAccounts({ activeAccount: 'spare', accounts: [...withAccounts().accounts!.slice(0, 2), { id: 'spare', label: 'Spare', enabled: true }, { id: 'off', label: 'Off', enabled: false }] })
    expect(accountOrder(config).map((a) => a.id)).toEqual(['spare', 'default', 'work'])
    const registry = new ProviderRegistry([withAccounts()], (id) => (id === 'openrouter#work' ? undefined : keys[id]))
    expect(registry.get('openrouter')).toBeInstanceOf(RotatingProvider)
  })

  it('rotates to the next account on a 429 and says so', async () => {
    const { fetch, seen } = keyedFetch({ 'k-personal': 429 })
    const cooldowns = new AccountCooldowns()
    const registry = new ProviderRegistry([withAccounts()], (id) => keys[id], { fetch, cooldowns, retries: 3 })
    const events = await collect(registry.get('openrouter').chat({ model: 'm', messages: [] }))
    expect(text(events)).toBe('k-work')
    // No retries on the limited key: it fails fast because another account can take over.
    expect(seen).toEqual(['k-personal', 'k-work'])
    expect(events[0]).toEqual({ type: 'status', text: 'Switched to account Work (Personal hit a rate limit).' })
    const c = cooldowns.get('openrouter', 'default')
    expect(c?.reason).toBe('hit a rate limit')
    // Retry-After: 120 is honored.
    expect(c!.until - Date.now()).toBeGreaterThan(110_000)
  })

  it('skips a cooling-down account until its cooldown ends', async () => {
    let now = 1_000_000
    const cooldowns = new AccountCooldowns(() => now)
    cooldowns.cool('openrouter', 'default', 60_000, 'hit a rate limit')
    const { fetch, seen } = keyedFetch()
    const registry = new ProviderRegistry([withAccounts()], (id) => keys[id], { fetch, cooldowns })
    expect(text(await collect(registry.get('openrouter').chat({ model: 'm', messages: [] })))).toBe('k-work')
    expect(seen).toEqual(['k-work'])
    expect(activeAccountKey(withAccounts(), (id) => keys[id], cooldowns)).toBe('k-work')
    now += 61_000
    expect(cooldowns.get('openrouter', 'default')).toBeUndefined()
    expect(text(await collect(registry.get('openrouter').chat({ model: 'm', messages: [] })))).toBe('k-personal')
  })

  it('gives up with the last error when every account is limited, and tries the one free soonest when all rest', async () => {
    const { fetch, seen } = keyedFetch({ 'k-personal': 429, 'k-work': 402, 'k-spare': 401 })
    const cooldowns = new AccountCooldowns()
    const registry = new ProviderRegistry([withAccounts()], (id) => keys[id], { fetch, cooldowns, retries: 0 })
    await expect(collect(registry.get('openrouter').chat({ model: 'm', messages: [] }))).rejects.toThrow(/401/)
    expect(seen).toEqual(['k-personal', 'k-work', 'k-spare'])
    expect(cooldowns.get('openrouter', 'work')?.reason).toBe('ran out of credits')
    expect(cooldowns.get('openrouter', 'spare')?.reason).toBe('had its key rejected')
    seen.length = 0
    await expect(collect(registry.get('openrouter').chat({ model: 'm', messages: [] }))).rejects.toThrow(/429/)
    expect(seen).toEqual(['k-personal'])
  })

  it("doesn't rotate on errors another account can't fix", async () => {
    const fetch = (async () => new Response('{"error":{"message":"bad request"}}', { status: 400 })) as unknown as typeof globalThis.fetch
    const cooldowns = new AccountCooldowns()
    const registry = new ProviderRegistry([withAccounts()], (id) => keys[id], { fetch, cooldowns })
    await expect(collect(registry.get('openrouter').chat({ model: 'm', messages: [] }))).rejects.toThrow(/bad request/)
    expect(cooldowns.get('openrouter', 'default')).toBeUndefined()
    expect(cooldownFor(new ProviderError('x', 500, true))).toBeNull()
    expect(cooldownFor(new ProviderError('insufficient_quota', 429, true))?.reason).toBe('ran out of quota')
  })

  it('lists models with the active account', async () => {
    const seen: string[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).authorization))
      return new Response(JSON.stringify({ data: [{ id: 'a' }] }))
    }) as unknown as typeof globalThis.fetch
    const registry = new ProviderRegistry([withAccounts({ activeAccount: 'work' })], (id) => keys[id], { fetch })
    expect((await registry.models('openrouter')).map((m) => m.id)).toEqual(['a'])
    expect(seen).toEqual(['Bearer k-work'])
  })
})
