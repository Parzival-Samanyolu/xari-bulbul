export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function cost(usd: number, partial = false): string {
  const s = usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
  return partial ? `${s}+` : s
}

/** Per-token USD → "$x / M tokens". */
export function perMillion(perToken?: number): string {
  if (perToken == null) return '—'
  const m = perToken * 1_000_000
  return m === 0 ? 'free' : `$${m < 1 ? m.toFixed(2) : m.toFixed(m < 10 ? 2 : 0)}`
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** "anthropic/claude-sonnet-5" → "claude-sonnet-5"; OpenRouter's own routers keep their prefix ("openrouter/free"). */
export function modelLabel(id: string): string {
  if (!id.includes('/') || id.startsWith('openrouter/')) return id
  return id.split('/').slice(1).join('/')
}
