import { Box, Text } from 'ink'
import { useTheme } from '../theme/palette.js'

export interface PopupRow {
  key: string
  label: string
  detail?: string
  /** Right-aligned note (price, age…). */
  note?: string
  /** Non-selectable group title. */
  header?: boolean
  /** Character indices of `label` to emphasise (fuzzy match). */
  match?: number[]
  dim?: boolean
}

export interface PopupProps {
  title?: string
  rows: PopupRow[]
  /** Index into the selectable rows. */
  selected: number
  maxRows?: number
  width: number
  footer?: string
  empty?: string
}

/** Selectable rows (headers skipped) for keyboard navigation. */
export const selectable = (rows: PopupRow[]) => rows.filter((r) => !r.header)

function Label({ row, active }: { row: PopupRow; active: boolean }) {
  const t = useTheme()
  if (!row.match?.length) return <Text bold={active} color={active ? t.accent : row.dim ? t.muted : undefined}>{row.label}</Text>
  const set = new Set(row.match)
  return (
    <Text color={active ? t.accent : undefined}>
      {[...row.label].map((ch, i) => (
        <Text key={i} bold={set.has(i) || active} color={set.has(i) && !active ? t.accent : undefined}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}

/** A list in the shared popup vocabulary: › marks the selection, details dim, notes on the right. */
export function Popup({ title, rows, selected, maxRows = 8, width, footer, empty }: PopupProps) {
  const t = useTheme()
  const sel = selectable(rows)
  const activeKey = sel[selected]?.key
  // Scroll so the selection stays visible; headers count as rows.
  const activeIdx = rows.findIndex((r) => !r.header && r.key === activeKey)
  const start = Math.max(0, Math.min(activeIdx - Math.floor(maxRows / 2), rows.length - maxRows))
  const visible = rows.slice(start, start + maxRows)
  const labelW = Math.min(Math.max(10, ...visible.map((r) => r.label.length)) + 2, Math.floor(width * 0.55))
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {title && (
        <Text bold color={t.accent}>
          {title}
        </Text>
      )}
      {rows.length === 0 && <Text color={t.muted}>{empty ?? 'Nothing here.'}</Text>}
      {start > 0 && <Text color={t.muted}>  ↑ {start} more</Text>}
      {visible.map((r) =>
        r.header ? (
          <Text key={`h:${r.key}`} color={t.muted}>
            {r.label}
            {r.detail ? <Text color={t.muted}> {r.detail}</Text> : null}
          </Text>
        ) : (
          <Box key={r.key} width={width - 2}>
            <Text color={t.accent}>{r.key === activeKey ? '› ' : '  '}</Text>
            <Box width={labelW} flexShrink={0}>
              <Label row={r} active={r.key === activeKey} />
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={t.muted} wrap="truncate-end">
                {r.detail ?? ''}
              </Text>
            </Box>
            {r.note ? <Text color={t.muted}> {r.note}</Text> : null}
          </Box>
        ),
      )}
      {start + maxRows < rows.length && <Text color={t.muted}>  ↓ {rows.length - start - maxRows} more</Text>}
      {footer && <Text color={t.muted}>{footer}</Text>}
    </Box>
  )
}
