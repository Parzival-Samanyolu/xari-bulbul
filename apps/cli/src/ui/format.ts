import os from 'node:os'
import type { PermissionMode } from '@harness/core'

export const MODES: PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'auto']

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'Ask',
  acceptEdits: 'Auto-edit',
  plan: 'Plan',
  auto: 'Full auto',
}

export const MODE_HELP: Record<PermissionMode, string> = {
  ask: 'asks before every edit and command',
  acceptEdits: 'edits apply, commands ask',
  plan: 'read-only, proposes a plan',
  auto: 'runs edits and commands; destructive ones still ask',
}

export function nextMode(m: PermissionMode): PermissionMode {
  return MODES[(MODES.indexOf(m) + 1) % MODES.length]
}

/** Accepts `ask`, `auto-edit`, `acceptEdits`, `plan`, `full-auto`, `auto`, `yolo`… */
export function parseMode(s: string): PermissionMode | null {
  const k = s.toLowerCase().replace(/[\s_-]/g, '')
  if (k === 'ask' || k === 'default') return 'ask'
  if (k === 'autoedit' || k === 'acceptedits' || k === 'edits') return 'acceptEdits'
  if (k === 'plan' || k === 'readonly') return 'plan'
  if (k === 'auto' || k === 'fullauto' || k === 'full') return 'auto'
  return null
}

/** 1234 → "1.2k", 1_234_567 → "1.23M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Exact enough to be honest about small amounts: $0.00042, $0.012, $1.23. */
export function usd(n: number, partial = false): string {
  const s = n === 0 ? '$0' : n < 0.01 ? `$${n.toPrecision(2)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`
  return partial ? `${s}+` : s
}

/** 0s, 12s, 1m 05s, 1h 02m. */
export function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Home → ~, and long paths shortened in the middle. */
export function shortPath(p: string, max = 48, home = os.homedir()): string {
  let s = home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
  if (s.length > max) s = s.slice(0, Math.floor(max / 3)) + '…' + s.slice(s.length - Math.ceil((max * 2) / 3) + 1)
  return s
}

/** Cuts a single line to `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  const line = s.replace(/\s*\n[\s\S]*$/, ' …')
  return line.length > max ? line.slice(0, Math.max(1, max - 1)) + '…' : line
}

/** "openrouter/free" stays; "z-ai/glm-4.6:free" → "glm-4.6:free" when space is short. */
export function shortModel(id: string, max = 28): string {
  if (id.length <= max) return id
  const tail = id.slice(id.lastIndexOf('/') + 1)
  return tail.length <= max ? tail : clip(tail, max)
}
