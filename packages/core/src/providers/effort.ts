// Thinking levels and fast modes per provider. No Node imports: the renderer uses this too (`@harness/core/catalog`).

export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof EFFORT_LEVELS)[number]

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

type ProviderLike = { id: string; baseUrl: string; api?: 'openai' | 'anthropic' }
export type ProviderKind = 'anthropic' | 'openai' | 'openrouter' | 'other'

export function providerKind(p: ProviderLike): ProviderKind {
  if (p.api === 'anthropic') return 'anthropic'
  if (/^https:\/\/api\.openai\.com\//.test(p.baseUrl)) return 'openai'
  if (p.id === 'openrouter' || /^https:\/\/openrouter\.ai\//.test(p.baseUrl)) return 'openrouter'
  return 'other'
}

/** Claude models with fast mode (research preview, Claude API only). */
export const ANTHROPIC_FAST_MODELS = /^claude-opus-(4-8|5|5-5)(-\d{8})?$/

/** Whether a fast option exists for this model, and what it does. */
export function fastMode(p: ProviderLike, modelId: string): { supported: boolean; hint: string } {
  switch (providerKind(p)) {
    case 'anthropic':
      return ANTHROPIC_FAST_MODELS.test(modelId)
        ? { supported: true, hint: 'Up to 2.5× faster output, about 2× the price' }
        : { supported: false, hint: 'Only Claude Opus 4.8, 5 and 5.5 have fast mode' }
    case 'openai':
      return { supported: true, hint: 'Priority processing, higher price' }
    case 'openrouter':
      return { supported: true, hint: 'Routes to the fastest host for this model' }
    default:
      return { supported: false, hint: 'This provider has no fast mode' }
  }
}

/** Whether the provider has a Batch API this app can use. */
export function batchMode(p: ProviderLike): { supported: boolean; hint: string } {
  const kind = providerKind(p)
  return kind === 'anthropic' || kind === 'openai'
    ? { supported: true, hint: 'About half price; each step can take minutes' }
    : { supported: false, hint: 'This provider has no batch API' }
}

/** The closest level an OpenAI-compatible provider accepts as `reasoning_effort`. */
export function openAIEffort(kind: ProviderKind, e: ReasoningEffort): string {
  if (kind === 'openai' || kind === 'openrouter') return e === 'max' ? 'xhigh' : e
  return e === 'xhigh' || e === 'max' ? 'high' : e
}

/** The closest `output_config.effort` a Claude model accepts. Thinking can't be turned off on current models. */
export function anthropicEffort(model: string, e: ReasoningEffort): string {
  if (e === 'none') return 'low'
  // Opus 4.5 knows low/medium/high; 4.6-era models lack xhigh.
  if (/^claude-opus-4-5/.test(model)) return e === 'xhigh' || e === 'max' ? 'high' : e
  if (/^claude-(opus-4-6|sonnet-4-6)/.test(model)) return e === 'xhigh' ? 'high' : e
  return e
}
