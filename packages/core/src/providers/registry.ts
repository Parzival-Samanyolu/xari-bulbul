import type { ModelInfo } from '../types.js'
import type { ProviderConfig } from '../settings/schema.js'
import { OpenAICompatProvider } from './openai-compat.js'
import type { Provider } from './types.js'

export type KeyLookup = (providerId: string) => string | undefined

/** Builds providers from settings and caches their model lists. */
export class ProviderRegistry {
  private providers = new Map<string, Provider>()
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>()

  constructor(
    configs: ProviderConfig[],
    getKey: KeyLookup,
    opts: { retries?: number; fetch?: typeof fetch } = {},
  ) {
    for (const config of configs) {
      if (!config.enabled) continue
      this.providers.set(
        config.id,
        new OpenAICompatProvider({ config, apiKey: getKey(config.id), retries: opts.retries, fetch: opts.fetch }),
      )
    }
  }

  /** For tests and custom (non OpenAI-compatible) providers. */
  register(provider: Provider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: string): Provider {
    const p = this.providers.get(id)
    if (!p) throw new Error(`Unknown or disabled provider "${id}"`)
    return p
  }

  list(): Provider[] {
    return [...this.providers.values()]
  }

  async models(providerId: string, opts: { refresh?: boolean; maxAgeMs?: number } = {}): Promise<ModelInfo[]> {
    const hit = this.modelCache.get(providerId)
    if (hit && !opts.refresh && Date.now() - hit.at < (opts.maxAgeMs ?? 30 * 60_000)) return hit.models
    const models = await this.get(providerId).listModels()
    this.modelCache.set(providerId, { at: Date.now(), models })
    return models
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
