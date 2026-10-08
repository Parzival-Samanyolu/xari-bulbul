import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { PermissionAnswer, PermissionRequest } from '@harness/core'
import { useTheme } from '../theme/palette.js'
import { clip } from './format.js'

export interface ApprovalOption {
  key: string
  label: string
  answer: 'allow' | 'always' | 'deny'
}

/** "Always" is left out when the engine offers no rule (destructive commands, writes outside the project). */
export function approvalOptions(req: PermissionRequest): ApprovalOption[] {
  const opts: ApprovalOption[] = [{ key: 'y', label: 'Yes, once', answer: 'allow' }]
  if (req.suggestedRule) opts.push({ key: 'a', label: `Yes, and allow ${clip(req.suggestedRule, 48)} for the rest of this chat`, answer: 'always' })
  opts.push({ key: 'n', label: 'No, and tell Xarı Bülbül what to do instead', answer: 'deny' })
  return opts
}

function title(req: PermissionRequest): string {
  if (req.tool === 'bash') return 'Run this command?'
  if (req.tool === 'edit_file') return 'Apply this edit?'
  if (req.tool === 'write_file') return 'Write this file?'
  if (req.tool.startsWith('mcp__')) return `Use ${req.tool.split('__').slice(1).join(' › ')}?`
  return `Use ${req.tool}?`
}

const PREVIEW_LINES = 10

function Preview({ req }: { req: PermissionRequest }) {
  const t = useTheme()
  const input = (req.input ?? {}) as Record<string, unknown>
  if (req.tool === 'bash') {
    const lines = String(input.command ?? req.subject).split('\n')
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {lines.slice(0, PREVIEW_LINES).map((l, i) => (
          <Text key={i}>
            <Text color={t.muted}>{i === 0 ? '$ ' : '  '}</Text>
            {l}
          </Text>
        ))}
        {lines.length > PREVIEW_LINES && <Text color={t.muted}>  … {lines.length - PREVIEW_LINES} more lines</Text>}
      </Box>
    )
  }
  const diff: { sign: '+' | '-'; text: string }[] = []
  if (req.tool === 'edit_file') {
    for (const l of String(input.old_string ?? '').split('\n')) diff.push({ sign: '-', text: l })
    for (const l of String(input.new_string ?? '').split('\n')) diff.push({ sign: '+', text: l })
  } else if (req.tool === 'write_file') {
    for (const l of String(input.content ?? '').split('\n')) diff.push({ sign: '+', text: l })
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{req.subject}</Text>
      {diff.slice(0, PREVIEW_LINES * 2).map((d, i) => (
        <Text key={i} backgroundColor={d.sign === '+' ? t.addBg : t.delBg}>
          <Text color={d.sign === '+' ? t.ok : t.danger}>{d.sign}</Text>
          {d.text || ' '}
        </Text>
      ))}
      {diff.length > PREVIEW_LINES * 2 && <Text color={t.muted}>… {diff.length - PREVIEW_LINES * 2} more lines</Text>}
    </Box>
  )
}

export interface ApprovalProps {
  req: PermissionRequest
  /** `interrupt` stops the turn so the user can type new instructions (Esc). */
  onAnswer: (a: PermissionAnswer, opts?: { interrupt?: boolean }) => void
}

/** Inline approval prompt, drawn above the composer like the rest of the live area. */
export function Approval({ req, onAnswer }: ApprovalProps) {
  const t = useTheme()
  const opts = approvalOptions(req)
  const [sel, setSel] = useState(0)
  const [feedback, setFeedback] = useState<string | null>(null)
  const once = !req.suggestedRule

  const choose = (o: ApprovalOption) => {
    if (o.answer === 'allow') onAnswer({ type: 'allow' })
    else if (o.answer === 'always') onAnswer({ type: 'allowAlways' })
    else setFeedback('')
  }

  useInput((input, key) => {
    if (feedback !== null) {
      if (key.escape) return setFeedback(null)
      if (key.return) return onAnswer({ type: 'deny', feedback: feedback.trim() || undefined })
      if (key.backspace || key.delete) return setFeedback(feedback.slice(0, -1))
      if (input && !key.ctrl && !key.meta) setFeedback(feedback + input)
      return
    }
    if (key.escape) return onAnswer({ type: 'deny' }, { interrupt: true })
    if (key.upArrow) return setSel((s) => (s + opts.length - 1) % opts.length)
    if (key.downArrow || key.tab) return setSel((s) => (s + 1) % opts.length)
    if (key.return) return choose(opts[sel])
    const n = Number(input)
    if (n >= 1 && n <= opts.length) return choose(opts[n - 1])
    const byKey = opts.find((o) => o.key === input.toLowerCase())
    if (byKey) choose(byKey)
  })

  const destructive = once && req.kind === 'exec'
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={destructive ? t.danger : t.accent} paddingX={1}>
      <Text bold>{title(req)}</Text>
      <Text color={destructive ? t.danger : t.muted}>{clip(req.reason, 200)}</Text>
      <Box marginY={1}>
        <Preview req={req} />
      </Box>
      {opts.map((o, i) => (
        <Text key={o.key}>
          <Text color={t.accent}>{i === sel ? '› ' : '  '}</Text>
          <Text bold={i === sel} color={i === sel ? t.accent : undefined}>
            {i + 1}. {o.label}
          </Text>
          <Text color={t.muted}> ({o.key})</Text>
        </Text>
      ))}
      {feedback !== null ? (
        <Box marginTop={1}>
          <Text color={t.accent}>why? </Text>
          <Text>{feedback}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      <Text color={t.muted}>
        {feedback !== null
          ? 'enter to send (empty is fine) · esc to go back'
          : `enter to confirm · esc to stop and give new instructions${once ? ' · this one can only be allowed once' : ''}`}
      </Text>
    </Box>
  )
}
