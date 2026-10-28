import type { ModelInfo } from '../types.js'

/** "openai/gpt-oss-120b", "gpt-oss:120b", "models/gemini-3.5-flash" → "gpt-oss-120b" / "gemini-3.5-flash". */
export function contextKey(id: string): string {
  let k = id.toLowerCase().replace(/:free$/, '')
  k = k.slice(k.lastIndexOf('/') + 1).replace(/:/g, '-')
  return k.replace(/-(latest|cloud)$/, '')
}

/** Context sizes by `contextKey`, from a provider list that reports them (OpenRouter's). */
export function contextIndex(models: { id: string; contextLength?: number }[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const m of models) if (m.contextLength && !index.has(contextKey(m.id))) index.set(contextKey(m.id), m.contextLength)
  return index
}

/** Fills in context sizes the provider didn't report. Only exact name matches, so a guess never lands on the wrong model. */
export function fillContext(models: ModelInfo[], index: Map<string, number>): ModelInfo[] {
  return models.map((m) => (m.contextLength ? m : { ...m, contextLength: index.get(contextKey(m.id)) ?? m.contextLength }))
}

const PUBLIC_LIST = 'https://openrouter.ai/api/v1/models'
let cached: { at: number; index: Map<string, number> } | undefined

/** OpenRouter's public model list (no key needed), as a context index. Cached for a day; undefined when offline. */
export async function publicContextIndex(fetchImpl: typeof fetch = fetch): Promise<Map<string, number> | undefined> {
  if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.index
  try {
    const res = await fetchImpl(PUBLIC_LIST, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return undefined
    const json = (await res.json()) as { data?: { id: string; context_length?: number }[] }
    const index = contextIndex((json.data ?? []).map((m) => ({ id: m.id, contextLength: m.context_length })))
    cached = { at: Date.now(), index }
    return index
  } catch {
    return undefined
  }
}
