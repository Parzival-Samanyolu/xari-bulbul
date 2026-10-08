import { Box, Text } from 'ink'
import type { PermissionMode } from '@harness/core'
import { ORCHID_ASCII, ORCHID_ASCII_PARTS, orchidCells } from '../theme/logo.js'
import { useTheme } from '../theme/palette.js'
import { MODE_LABEL, shortPath } from './format.js'

/** The orchid on its own black field, drawn with half blocks (truecolor) or characters. */
export function Orchid({ size = 'small' }: { size?: 'small' | 'large' }) {
  const t = useTheme()
  if (t.orchid === 'ascii') {
    const colorOf = (part: (typeof ORCHID_ASCII_PARTS)[number]) => (part === 'lip' ? t.accent : part === 'column' ? t.warn : undefined)
    return (
      <Box flexDirection="column">
        {ORCHID_ASCII.map((l, i) => (
          <Text key={i} color={colorOf(ORCHID_ASCII_PARTS[i])}>
            {l}
          </Text>
        ))}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {orchidCells(size).map((row, i) => (
        <Text key={i}>
          {row.map(([ch, fg, bg], j) => (
            <Text key={j} color={fg ?? undefined} backgroundColor={bg ?? '#000000'}>
              {ch}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export interface HeaderProps {
  version: string
  model: string
  provider: string
  cwd: string
  mode: PermissionMode
  columns: number
  /** A problem to fix before the first message (e.g. a missing key). */
  problem?: string | null
  resumed?: string | null
  showLogo?: boolean
}

/**
 * The welcome box: orchid, name and version, then model, folder and permission mode.
 * The orchid is left out on narrow terminals (< 60 columns).
 */
export function Header(p: HeaderProps) {
  const t = useTheme()
  const logo = p.showLogo !== false && p.columns >= 60
  const width = Math.min(p.columns, 84)
  const info = Math.max(20, width - (logo ? (t.orchid === 'ascii' ? 28 : 22) : 0) - 6)
  const row = (label: string, value: string, color?: string) => (
    <Text>
      <Text color={t.muted}>{label.padEnd(10)}</Text>
      <Text color={color}>{value}</Text>
    </Text>
  )
  return (
    <Box borderStyle="round" borderColor={t.border} paddingX={1} width={width} flexDirection="row" gap={2}>
      {logo && <Orchid />}
      <Box flexDirection="column" width={info} justifyContent="center">
        <Text>
          <Text bold>Xarı Bülbül</Text>
          <Text color={t.muted}> v{p.version}</Text>
        </Text>
        <Text> </Text>
        {row('model', `${p.model}`)}
        {row('provider', p.provider)}
        {row('directory', shortPath(p.cwd, info - 10))}
        {row('mode', `${MODE_LABEL[p.mode]}`, p.mode === 'auto' ? t.warn : p.mode === 'plan' ? t.info : undefined)}
        {p.resumed ? row('resumed', p.resumed) : null}
        <Text> </Text>
        {p.problem ? (
          <Text color={t.warn}>{p.problem}</Text>
        ) : (
          <Text color={t.muted}>
            <Text color={t.accent}>/</Text> commands · <Text color={t.accent}>⇧⇥</Text> mode · <Text color={t.accent}>⌃K</Text> model
          </Text>
        )}
      </Box>
    </Box>
  )
}
