import { isContextOverflow } from '../providers/http.js'
import { ProviderError } from '../providers/types.js'
import type { ModelRef } from '../types.js'

/**
 * What a failed model request means for the fallback chain:
 * - `next`: try the next model; this one may work again next step (outage, rate limit, network).
 * - `skip`: try the next model and leave this one out for the rest of the turn (not found, no key, not connected).
 * - `context`: the request is too long; only a model with a bigger context window can help.
 * - `null`: don't fall back (aborted, our own bad request, a refusal), so real bugs aren't hidden.
 */
export type FailoverKind = 'next' | 'skip' | 'context' | null

/** The provider for a model isn't set up or is turned off. */
export class ProviderUnavailableError extends Error {
  constructor(readonly providerId: string) {
    super(`The provider "${providerId}" isn't connected. Add it in Settings › Providers.`)
    this.name = 'ProviderUnavailableError'
  }
}

const NO_KEY = /^No API key set for /
const NETWORK = /^Network error: /
const MODEL_MISSING = /model.{0,60}(not found|does ?n[o']t exist|not exist|is not available|no longer available|unknown|not supported)|(unknown|invalid|unsupported) model/i

export function failoverKind(err: unknown, signal?: AbortSignal): FailoverKind {
  if (signal?.aborted) return null
  if (err instanceof ProviderUnavailableError) return 'skip'
  if (!(err instanceof ProviderError)) return null
  if (isContextOverflow(err)) return 'context'
  const s = err.status
  if (s == null) {
    if (NO_KEY.test(err.message)) return 'skip'
    if (NETWORK.test(err.message) || err.retryable) return 'next'
    return null
  }
  // 401/403: a bad or missing key; 402: out of credits; 404: the model is gone.
  if (s === 401 || s === 402 || s === 403 || s === 404) return 'skip'
  if (s === 408 || s === 409 || s === 429 || s >= 500) return 'next'
  // A 400 is usually our own payload; only an unknown model is worth moving on from.
  if (s === 400 && MODEL_MISSING.test(err.message)) return 'skip'
  return null
}

/** A few words on why a model failed, for the notice ("429", "not found", "no API key"). */
export function failureLabel(err: unknown): string {
  if (err instanceof ProviderUnavailableError) return 'not connected'
  if (!(err instanceof ProviderError)) return 'error'
  if (isContextOverflow(err)) return 'context too long'
  if (err.status === 404 || (err.status === 400 && MODEL_MISSING.test(err.message))) return 'not found'
  if (err.status != null) return String(err.status)
  if (NO_KEY.test(err.message)) return 'no API key'
  if (NETWORK.test(err.message)) return 'network error'
  return 'error'
}

/** The chat model first, then the fallbacks, without repeats or models left out this turn. */
export function fallbackChain(main: ModelRef, fallbacks: ModelRef[], skipped: Set<string>): ModelRef[] {
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const r of [main, ...fallbacks]) {
    const k = `${r.providerId}:${r.modelId}`
    if (seen.has(k) || skipped.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/** A short model name for notices: the listed name without its maker prefix, else the id's last part. */
export function shortModelName(ref: ModelRef, listedName?: string): string {
  const name = listedName?.replace(/^[^:]{1,40}:\s*/, '').trim()
  if (name) return name
  const id = ref.modelId
  if (!id.includes('/') || id.startsWith('openrouter/')) return id
  return id.split('/').slice(1).join('/')
}
