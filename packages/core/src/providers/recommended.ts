import type { ModelRef } from '../types.js'

export type RecommendedTier = 'free' | 'paid' | 'frontier'

export interface RecommendedModel {
  tier: RecommendedTier
  ref: ModelRef
  name: string
  /** One line: why pick it, and what it costs (USD per million input / output tokens). */
  note: string
}

/**
 * Hand-picked models for coding, shown in Settings → Models. Check the ids against each
 * provider's model list when updating; bench scores are from `bench/results`.
 */
export const RECOMMENDED: RecommendedModel[] = [
  {
    tier: 'free',
    ref: { providerId: 'openrouter', modelId: 'openrouter/free' },
    name: 'OpenRouter free router',
    note: 'Picks an available free model for each request. Easiest start, uneven quality.',
  },
  {
    tier: 'free',
    ref: { providerId: 'openrouter', modelId: 'nvidia/nemotron-3.5-lightning:free' },
    name: 'Nemotron 3.5 Lightning',
    note: 'Best free model in our benchmark (82%). 1M context.',
  },
  {
    tier: 'free',
    ref: { providerId: 'ollama-cloud', modelId: 'gpt-oss:120b' },
    name: 'gpt-oss 120B',
    note: 'Strong on coding tasks in our benchmark (80%), fast. Ollama Cloud free tier.',
  },
  {
    tier: 'free',
    ref: { providerId: 'google', modelId: 'gemini-flash-lite-latest' },
    name: 'Gemini Flash-Lite',
    note: 'Fast and reliable with tools (80%). Google AI Studio free tier.',
  },
  {
    tier: 'paid',
    ref: { providerId: 'anthropic', modelId: 'claude-haiku-5-5' },
    name: 'Claude Haiku 5.5',
    note: 'Cheap and quick for everyday edits. $0.10 / $0.50.',
  },
  {
    tier: 'paid',
    ref: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash' },
    name: 'DeepSeek V4.1 Flash',
    note: 'Very low cost reasoning model. About $0.03 / $0.08.',
  },
  {
    tier: 'paid',
    ref: { providerId: 'openrouter', modelId: 'google/gemini-3.8-flash' },
    name: 'Gemini 3.8 Flash',
    note: 'Fast, 1M context. About $0.83 / $4.13.',
  },
  {
    tier: 'paid',
    ref: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
    name: 'Claude Sonnet 5.5',
    note: 'Everyday coding and agent work at a mid price. $2 / $10.',
  },
  {
    tier: 'frontier',
    ref: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
    name: 'Claude Opus 5.5',
    note: 'Top choice for long agentic coding tasks. $4 / $20.',
  },
  {
    tier: 'frontier',
    ref: { providerId: 'anthropic', modelId: 'claude-fable-5-1' },
    name: 'Claude Fable 5.1',
    note: "Anthropic's most capable model, for the hardest problems. $10 / $50.",
  },
  {
    tier: 'frontier',
    ref: { providerId: 'openrouter', modelId: 'openai/gpt-6-astra' },
    name: 'GPT-6 Astra',
    note: "OpenAI's top model. $10 / $50.",
  },
  {
    tier: 'frontier',
    ref: { providerId: 'openrouter', modelId: 'google/gemini-4-argon' },
    name: 'Gemini 4 Argon',
    note: "Google's top model, 1M context. $2 / $10.",
  },
]

export const TIER_LABELS: Record<RecommendedTier, string> = {
  free: 'Free',
  paid: 'Paid',
  frontier: 'Frontier',
}
