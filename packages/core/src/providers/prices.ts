import type { ModelPricing, Usage } from '../types.js'

/**
 * OpenAI's list prices in USD per million tokens: input, output, cached input. OpenAI's model list
 * has no prices, so without this the OpenAI API spend can't be counted and ChatGPT plan usage can't
 * be shown at what it would cost on the API. Snapshot of published prices (2026-11); unknown models
 * report no price.
 */
const OPENAI_PRICES: Record<string, [input: number, output: number, cachedInput: number]> = {
  'gpt-6-astra': [10, 50, 1],
  'gpt-6.1-terra': [1, 5, 0.05],
}

const priceOf = (model: string) => OPENAI_PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')]

/** Per-token pricing for the model picker, or undefined for an unknown model. */
export function openaiPricing(model: string): ModelPricing | undefined {
  const p = priceOf(model)
  return p && { prompt: p[0] / 1e6, completion: p[1] / 1e6 }
}

/** Request cost in USD at OpenAI's API prices, cached input included; undefined for an unknown model. */
export function openaiCost(model: string, u: Usage): number | undefined {
  const p = priceOf(model)
  if (!p) return undefined
  const cached = Math.min(u.cachedTokens ?? 0, u.promptTokens) // prompt tokens include the cached ones
  return ((u.priceFactor ?? 1) * ((u.promptTokens - cached) * p[0] + cached * p[2] + u.completionTokens * p[1])) / 1e6
}

/** True for OpenAI's own API (the built-in provider or a custom one pointing at it). */
export function isOpenAiApi(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com'
  } catch {
    return false
  }
}
