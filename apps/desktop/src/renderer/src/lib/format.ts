import { formatNumber, type Lang } from '@harness/core/i18n'

/** Token counts as "950", "1.2k", "34k", "1.05M", with the language's decimal separator. */
export function tokens(lang: Lang, n: number): string {
  const fixed = (v: number, digits: number) => formatNumber(lang, v, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
  if (n < 1000) return fixed(n, 0)
  if (n < 1_000_000) return `${fixed(n / 1000, n < 10_000 ? 1 : 0)}k`
  return `${fixed(n / 1_000_000, 2)}M`
}

/** USD as "$0.0042" or "$1.25" (two decimals from a cent up); `partial` adds "+" when some costs are unknown. */
export function cost(lang: Lang, usd: number, partial = false): string {
  const digits = usd === 0 ? 0 : usd < 0.01 ? 4 : 2
  const s = `$${formatNumber(lang, usd, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  return partial ? `${s}+` : s
}

/** Per-token USD → "$x / M tokens"; `free` is the word for a zero price, in the interface language. */
export function perMillion(perToken?: number, free = 'free'): string {
  if (perToken == null) return '—'
  const m = perToken * 1_000_000
  return m === 0 ? free : `$${m < 1 ? m.toFixed(2) : m.toFixed(m < 10 ? 2 : 0)}`
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** "anthropic/claude-sonnet-5" → "claude-sonnet-5"; OpenRouter's own routers keep their prefix ("openrouter/free"). */
export function modelLabel(id: string): string {
  if (!id.includes('/') || id.startsWith('openrouter/')) return id
  return id.split('/').slice(1).join('/')
}
