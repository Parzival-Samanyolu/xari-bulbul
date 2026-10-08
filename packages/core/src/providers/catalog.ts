// Model picker logic shared by the desktop picker and the terminal picker.
// Pure functions with no Node imports, so the renderer can use them too (`@harness/core/catalog`).
import type { ModelInfo, ModelRef } from '../types.js'

export type ModelSort = 'newest' | 'name' | 'context' | 'price'
export const MODEL_SORTS: ModelSort[] = ['newest', 'name', 'context', 'price']

export const refKey = (r: ModelRef) => `${r.providerId}:${r.modelId}`
export const refOf = (m: ModelInfo): ModelRef => ({ providerId: m.providerId, modelId: m.id })

export function sortModels(ms: ModelInfo[], sort: ModelSort): ModelInfo[] {
  const out = [...ms]
  if (sort === 'newest') out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
  else if (sort === 'context') out.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
  else if (sort === 'price') out.sort((a, b) => (a.pricing?.prompt ?? Infinity) - (b.pricing?.prompt ?? Infinity))
  else out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** "Qwen: Qwen3.8 27B (free)" → "Qwen3.8 27B"; the free badge and provider group say the rest. */
export function displayName(m: ModelInfo): string {
  let n = m.name.replace(/\s*\(free\)\s*$/i, '')
  const colon = n.indexOf(': ')
  if (colon > 0 && colon < 24) n = n.slice(colon + 2)
  return n
}

/** Every whitespace-separated term must appear in the id, name, provider or "free". */
export function matchesQuery(m: ModelInfo, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${m.id} ${m.name} ${m.providerId} ${m.free ? 'free' : ''}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/** Picker filters. Providers that report no pricing at all (e.g. Ollama) aren't hidden by "free only". */
export function passesFilters(m: ModelInfo, f: { freeOnly: boolean; toolsOnly: boolean }, providerPriced: boolean): boolean {
  return (!f.toolsOnly || m.supportsTools) && (!f.freeOnly || m.free || !providerPriced)
}

/** USD per token → "$0.30/M". */
export function perMillion(usdPerToken: number): string {
  const v = usdPerToken * 1e6
  return `$${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toPrecision(2).replace(/\.?0+$/, '')}/M`
}

export function priceLabel(m: ModelInfo): string {
  if (m.free) return 'free'
  if (!m.pricing) return '—'
  return `${perMillion(m.pricing.prompt)} in · ${perMillion(m.pricing.completion)} out`
}

export interface PickerSection {
  title: string
  kind: 'current' | 'favorites' | 'recent' | 'provider'
  providerId?: string
  models: ModelInfo[]
  /** For provider sections: how many models the provider has before filtering. */
  total?: number
}

export interface PickerInput {
  models: Record<string, ModelInfo[]>
  providers: { id: string; name: string }[]
  current?: ModelRef
  favorites: ModelRef[]
  recent: ModelRef[]
  query: string
  filters: { freeOnly: boolean; toolsOnly: boolean }
  sort: ModelSort
}

/**
 * Current, favorites and recents first (always shown, whatever the filters say), then each
 * provider's models filtered and sorted. A model appears once.
 */
export function pickerSections(i: PickerInput): PickerSection[] {
  const find = (r: ModelRef): ModelInfo =>
    i.models[r.providerId]?.find((m) => m.id === r.modelId) ?? { id: r.modelId, name: r.modelId, providerId: r.providerId, free: false, supportsTools: true }
  const out: PickerSection[] = []
  const seen = new Set<string>()
  const pin = (title: string, kind: PickerSection['kind'], ms: ModelInfo[]) => {
    const fresh = ms.filter((m) => !seen.has(refKey(refOf(m))) && matchesQuery(m, i.query))
    fresh.forEach((m) => seen.add(refKey(refOf(m))))
    if (fresh.length) out.push({ title, kind, models: fresh })
  }
  if (i.current) pin('Current', 'current', [find(i.current)])
  pin('Favorites', 'favorites', i.favorites.map(find))
  if (!i.query.trim()) pin('Recent', 'recent', i.recent.slice(0, 5).map(find))
  for (const p of i.providers) {
    const all = i.models[p.id] ?? []
    const priced = all.some((m) => m.pricing)
    const shown = sortModels(
      all.filter((m) => passesFilters(m, i.filters, priced) && matchesQuery(m, i.query) && !seen.has(refKey(refOf(m)))),
      i.sort,
    )
    out.push({ title: p.name, kind: 'provider', providerId: p.id, models: shown, total: all.length })
  }
  return out
}

/** Adds `ref` to the front of the recents list (deduped, capped). */
export function pushRecent(recent: ModelRef[], ref: ModelRef, cap = 8): ModelRef[] {
  return [ref, ...recent.filter((r) => refKey(r) !== refKey(ref))].slice(0, cap)
}
