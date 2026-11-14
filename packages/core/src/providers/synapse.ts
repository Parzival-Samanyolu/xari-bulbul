// Samanyolu AI Synapse (samanyoluai.duckdns.org): an OpenAI-compatible API whose limits depend on the key's plan.
// Newer servers report them in `/v1/models` and `/v1/key`; older ones only list `synapse-2`.
import type { ModelInfo } from '../types.js'

export const SYNAPSE_PROVIDER_ID = 'synapse'
export const SYNAPSE_SITE = 'https://samanyoluai.duckdns.org'

/** The free plan's limits: the safe guess when the server doesn't say. */
export const SYNAPSE_FREE_CONTEXT = 32_000
export const SYNAPSE_FREE_CONCURRENT = 1

export function isSynapse(baseUrl: string): boolean {
  return /^https:\/\/samanyoluai\.duckdns\.org\//.test(baseUrl)
}

/**
 * Fills what an older Synapse server leaves out, so compaction and parallel subagents stay inside the free plan.
 * Newer servers price tokens (measured against the plan's weekly allowance, never billed per token), so the
 * Usage page shows how much of the allowance went where.
 */
export function withSynapseDefaults(m: ModelInfo, baseUrl: string): ModelInfo {
  if (!isSynapse(baseUrl)) return m
  return {
    ...m,
    name: m.name === m.id && m.id === 'synapse-2' ? 'Synapse 2' : m.name,
    contextLength: m.contextLength ?? SYNAPSE_FREE_CONTEXT,
    maxConcurrent: m.maxConcurrent ?? SYNAPSE_FREE_CONCURRENT,
    free: m.pricing ? m.free : true,
  }
}

export interface SynapseAccount {
  /** Internal plan id ("free" = Neuron, "pro" = Myelin). */
  plan: string
  /** What people see: "Neuron", "Myelin". */
  planLabel: string
  limits: {
    requestsPerMinute: number
    /** Weekly allowance in USD, measured at the prices below. */
    usdPerWeek: number
    pricePerMillion: number
    cachePricePerMillion: number
    maxOutputTokens: number
    maxConcurrent: number
    maxContextTokens: number
  }
  usdThisWeek: number
  tokensToday: number
  /** Epoch ms when the weekly allowance resets (Monday 00:00 UTC). */
  resetsAt: number
}

interface RawKey {
  data?: {
    plan?: string
    plan_label?: string
    limits?: Record<string, number>
    usage?: { usd_this_week?: number; tokens_today?: number; resets_at?: number }
  }
}

/** The key's plan and today's use from `GET /v1/key`; null when the server is too old to have it. Throws on network or key errors. */
export async function fetchSynapseAccount(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<SynapseAccount | null> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Synapse answered ${res.status}`)
  const d = ((await res.json()) as RawKey).data
  if (!d?.plan || !d.limits) return null
  const n = (k: string) => Number(d.limits?.[k] ?? 0)
  return {
    plan: d.plan,
    planLabel: d.plan_label ?? d.plan,
    limits: {
      requestsPerMinute: n('requests_per_minute'),
      usdPerWeek: n('usd_per_week'),
      pricePerMillion: n('price_per_million_usd'),
      cachePricePerMillion: n('cache_price_per_million_usd'),
      maxOutputTokens: n('max_output_tokens'),
      maxConcurrent: n('max_concurrent'),
      maxContextTokens: n('max_context_tokens'),
    },
    usdThisWeek: Number(d.usage?.usd_this_week ?? 0),
    tokensToday: Number(d.usage?.tokens_today ?? 0),
    resetsAt: Number(d.usage?.resets_at ?? 0) * 1000,
  }
}
