import { ORCHID, type OrchidCell } from './orchid.generated.js'

/**
 * Ophrys caucasica in plain characters, for terminals without truecolor. Symmetric about the
 * middle column: the dorsal sepal on top, the lateral sepals as wings, the column (O), and the
 * furry lip with its H-shaped mirror.
 */
export const ORCHID_ASCII = [
  '              _',
  '             / \\',
  '            /   \\',
  '    __      \\   /      __',
  "   /  `-.__  \\ /  __.-'  \\",
  "   \\      `-. V .-'      /",
  "    `-.__   _(O)_   __.-'",
  "         `-/ ::: \\-'",
  '          | ::::: |',
  '          | :#H#: |',
  '           \\ :#: /',
  "            `---'",
]

/** Which part of the flower a line of ORCHID_ASCII belongs to, for colouring. */
export const ORCHID_ASCII_PARTS: ('sepal' | 'column' | 'lip')[] = ORCHID_ASCII.map((_, i) => (i < 6 ? 'sepal' : i === 6 ? 'column' : 'lip'))

export const ORCHID_ASCII_WIDTH = Math.max(...ORCHID_ASCII.map((l) => l.length))

export function orchidCells(size: 'small' | 'large'): OrchidCell[][] {
  return ORCHID[size]
}

const ESC = '\x1b['
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';')

/** The orchid as ANSI text (for `xb --version`, outside Ink). Transparent cells are drawn on black. */
export function orchidAnsi(size: 'small' | 'large'): string {
  return ORCHID[size]
    .map((row) =>
      row
        .map(([ch, fg, bg]) => `${fg ? `${ESC}38;2;${rgb(fg)}m` : ''}${ESC}48;2;${rgb(bg ?? '#000000')}m${ch}${ESC}0m`)
        .join(''),
    )
    .join('\n')
}
