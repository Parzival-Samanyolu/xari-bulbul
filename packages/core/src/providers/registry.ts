import type { ModelInfo } from '../types.js'
import type { ProviderConfig } from '../settings/schema.js'
import { AccountCooldowns, accountKeyId, accountOrder, RotatingProvider } from './accounts.js'
import { AnthropicProvider } from './anthropic.js'
import { contextIndex, fillContext, publicContextIndex } from './context-catalog.js'
import { OpenAICompatProvider } from './openai-compat.js'
import { OpenAIResponsesProvider } from './openai-responses.js'
import type { Provider } from './types.js'

export type KeyLookup = (providerId: string) => string | undefined

/** Builds providers from settings and caches their model lists. */
export class ProviderRegistry {
  private providers = new Map<string, Provider>()
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>()

  constructor(
    configs: ProviderConfig[],
    getKey: KeyLookup,
    private readonly opts: {
      retries?: number
      fetch?: typeof fetch
      /** Fill context sizes a provider doesn't report from OpenRouter's public model list. */
      fillContext?: boolean
      /** Pass the same instance across rebuilds so cooled-down accounts stay remembered. */
      cooldowns?: AccountCooldowns
      /** Access-token source for providers paid by a sign-in (`auth: 'chatgpt'`); unset or undefined: signed out. */
      tokenFor?: (providerId: string) => (() => Promise<string>) | undefined
    } = {},
  ) {
    this.cooldowns = opts.cooldowns ?? new AccountCooldowns()
    for (const config of configs) {
      if (!config.enabled) continue
      if (config.auth === 'chatgpt') {
        // One signed-in account, refreshed by the host; no key rotation.
        const token = opts.tokenFor?.(config.id)
        if (token) this.providers.set(config.id, new OpenAIResponsesProvider({ config, token, retries: opts.retries, fetch: opts.fetch }))
        continue
      }
      const make = (apiKey: string | undefined): Provider => {
        const o = { config, apiKey, retries: opts.retries, fetch: opts.fetch }
        return config.api === 'anthropic' ? new AnthropicProvider(o) : new OpenAICompatProvider(o)
      }
      // Accounts that can serve: keyed ones, or every enabled one when the provider needs no key.
      const accounts = accountOrder(config)
        .map((account) => ({ account, key: getKey(accountKeyId(config.id, account.id)) }))
        .filter((a) => a.key || !config.requiresKey)
      this.providers.set(
        config.id,
        accounts.length > 1
          ? new RotatingProvider(config, accounts.map((a) => ({ account: a.account, provider: make(a.key) })), this.cooldowns)
          : make(accounts[0]?.key),
      )
    }
  }

  /** Accounts resting after a rate limit, quota or key error. */
  readonly cooldowns: AccountCooldowns

  /** For tests and custom (non OpenAI-compatible) providers. */
  register(provider: Provider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: string): Provider {
    const p = this.providers.get(id)
    if (!p) throw new Error(`Unknown or disabled provider "${id}"`)
    return p
  }

  /** True when the provider is set up and enabled. */
  has(id: string): boolean {
    return this.providers.has(id)
  }

  list(): Provider[] {
    return [...this.providers.values()]
  }

  async models(providerId: string, opts: { refresh?: boolean; maxAgeMs?: number } = {}): Promise<ModelInfo[]> {
    const provider = this.get(providerId)
    const visible = (ms: ModelInfo[]) => (provider.unavailable ? ms.filter((m) => !provider.unavailable!(m.id)) : ms)
    const hit = this.modelCache.get(providerId)
    if (hit && !opts.refresh && Date.now() - hit.at < (opts.maxAgeMs ?? 30 * 60_000)) return visible(hit.models)
    let models = await provider.listModels()
    if (this.opts.fillContext && providerId !== 'openrouter' && models.some((m) => !m.contextLength)) {
      const own = this.modelCache.get('openrouter')?.models
      const index = own ? contextIndex(own) : await publicContextIndex(this.opts.fetch)
      if (index) models = fillContext(models, index)
    }
    this.modelCache.set(providerId, { at: Date.now(), models })
    return visible(models)
  }

  /** Cached lookup only — never hits the network. */
  cachedModel(providerId: string, modelId: string): ModelInfo | undefined {
    return this.modelCache.get(providerId)?.models.find((m) => m.id === modelId)
  }

  /** Carry model lists over when the registry is rebuilt (settings/key changes). */
  cacheSnapshot(): Map<string, { at: number; models: ModelInfo[] }> {
    return new Map(this.modelCache)
  }

  restoreCache(snapshot: Map<string, { at: number; models: ModelInfo[] }>): void {
    for (const [id, v] of snapshot) if (this.providers.has(id)) this.modelCache.set(id, v)
  }

  seedCache(providerId: string, models: ModelInfo[]): void {
    this.modelCache.set(providerId, { at: Date.now(), models })
  }
}
