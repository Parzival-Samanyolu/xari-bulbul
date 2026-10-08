import { Box, Text, useAnimation } from 'ink'
import type { PermissionMode, UsageTotals } from '@harness/core'
import { useTheme } from '../theme/palette.js'
import { duration, MODE_LABEL, shortModel, tokens, usd } from './format.js'

export interface FooterProps {
  mode: PermissionMode
  model: string
  session: UsageTotals
  today: UsageTotals
  context: { used: number; length: number }
  columns: number
  /** Replaces the key hints (e.g. "press ctrl+c again to quit"). */
  hint?: string | null
}

/** Usage pieces, most important first; dropped from the end until they fit. */
export function usageParts(p: Pick<FooterProps, 'session' | 'today' | 'context' | 'model'>): string[] {
  const s = p.session
  const pct = p.context.length ? Math.min(100, Math.round((p.context.used / p.context.length) * 100)) : 0
  const parts = [`${pct}% context`, `↑${tokens(s.promptTokens)} ↓${tokens(s.completionTokens)}`, usd(s.cost, s.costPartial)]
  if (s.cachedTokens) parts.push(`${tokens(s.cachedTokens)} cached`)
  parts.push(`today ${usd(p.today.cost, p.today.costPartial)}`, `${s.requests} req`)
  return parts
}

export function Footer(p: FooterProps) {
  const t = useTheme()
  const modeColor = p.mode === 'auto' ? t.warn : p.mode === 'plan' ? t.info : p.mode === 'acceptEdits' ? t.ok : t.accent
  const left = p.hint ?? null
  // Narrow terminals drop the "? for shortcuts" hint before any usage number.
  const wide = p.columns >= 100
  const leftWidth = left ? left.length : MODE_LABEL[p.mode].length + (wide ? 25 : 6)
  const budget = Math.max(0, p.columns - leftWidth - 6)
  const model = shortModel(p.model, Math.max(10, Math.min(32, Math.floor(budget / 3))))
  const parts = usageParts(p)
  let right = model
  for (const part of parts) {
    if ((right + ' · ' + part).length > budget) break
    right += ' · ' + part
  }
  return (
    <Box justifyContent="space-between" paddingX={2} width={p.columns}>
      {left ? (
        <Text color={t.muted}>{left}</Text>
      ) : (
        <Text color={t.muted}>
          <Text color={modeColor}>{MODE_LABEL[p.mode]}</Text> (⇧⇥){wide ? ' · ? for shortcuts' : ''}
        </Text>
      )}
      <Text color={t.muted}>{right}</Text>
    </Box>
  )
}

const FRAMES = ['◦', '•', '●', '•']

/** "• Working (12s · esc to interrupt)" while a turn runs. */
export function Status({ startedAt, label, queued }: { startedAt: number; label: string; queued: string[] }) {
  const t = useTheme()
  const { frame } = useAnimation({ interval: 250 })
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={t.accent}>{FRAMES[frame % FRAMES.length]} </Text>
        <Text bold>{label}</Text>
        <Text color={t.muted}> ({duration(Date.now() - startedAt)} · esc to interrupt)</Text>
      </Text>
      {queued.slice(0, 3).map((q, i) => (
        <Text key={i} color={t.muted} italic>
          {'  ↳ '}
          {q.split('\n')[0]}
        </Text>
      ))}
      {queued.length > 0 && <Text color={t.muted}>{'    '}queued; sent when this turn ends</Text>}
    </Box>
  )
}

export const SHORTCUTS: [string, string][] = [
  ['enter', 'send (queues while working)'],
  ['shift+enter, ctrl+j', 'new line (or end the line with \\)'],
  ['shift+tab', 'cycle mode: Ask → Auto-edit → Plan → Full auto'],
  ['ctrl+k', 'switch model (also /model)'],
  ['esc', 'interrupt the agent · close a popup'],
  ['ctrl+c', 'clear input · twice to quit'],
  ['ctrl+o', 'expand the last tool output'],
  ['↑ ↓', 'input history'],
  ['@path', 'mention a file (its contents are attached)'],
  ['/', 'commands, including yours from .harness/commands'],
]

export function Shortcuts() {
  const t = useTheme()
  const w = Math.max(...SHORTCUTS.map(([k]) => k.length))
  return (
    <Box flexDirection="column" paddingX={2} marginTop={1}>
      {SHORTCUTS.map(([k, v]) => (
        <Box key={k}>
          <Box width={w + 2} flexShrink={0}>
            <Text color={t.accent}>{k}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={t.muted}>{v}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
