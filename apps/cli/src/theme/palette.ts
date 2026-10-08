import { createContext, useContext } from 'react'
import { oklchToHex, TOKENS, type TokenName } from './tokens.js'

/** 0 = no colour (NO_COLOR or dumb terminal), 1 = 16 colours, 2 = 256, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): ColorLevel {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 0
  const force = env.FORCE_COLOR
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0
    if (force === '1' || force === '' || force === 'true') return 1
    if (force === '2') return 2
    if (force === '3') return 3
  }
  if (!isTTY || env.TERM === 'dumb') return 0
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3
  const prog = env.TERM_PROGRAM ?? ''
  if (['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby'].includes(prog) || env.WT_SESSION || env.KITTY_WINDOW_ID) return 3
  if (prog === 'Apple_Terminal' || /256/.test(env.TERM ?? '')) return 2
  return 1
}

/** Light or dark from COLORFGBG ("15;0" = light text on dark), when the terminal sets it. */
export function themeFromEnv(env: NodeJS.ProcessEnv = process.env): 'dark' | 'light' | null {
  const forced = env.XB_THEME
  if (forced === 'dark' || forced === 'light') return forced
  const parts = env.COLORFGBG?.split(';')
  const bg = parts ? Number(parts.at(-1)) : NaN
  if (Number.isNaN(bg)) return null
  return bg === 7 || bg >= 9 ? 'light' : 'dark'
}

/** Parses an OSC 11 reply (`rgb:RRRR/GGGG/BBBB`) into light or dark. */
export function themeFromOsc11(reply: string): 'dark' | 'light' | null {
  const m = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply)
  if (!m) return null
  const n = (h: string) => parseInt(h, 16) / (16 ** h.length - 1)
  const lum = 0.2126 * n(m[1]) + 0.7152 * n(m[2]) + 0.0722 * n(m[3])
  return lum > 0.5 ? 'light' : 'dark'
}

/**
 * Asks the terminal for its background colour (OSC 11). Most modern terminals answer within a few
 * milliseconds; ones that don't are given up on after `timeoutMs`.
 */
export async function queryTerminalTheme(timeoutMs = 120): Promise<'dark' | 'light' | null> {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return null
  return new Promise((resolve) => {
    let buf = ''
    const wasRaw = stdin.isRaw
    const done = (v: 'dark' | 'light' | null) => {
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      resolve(v)
    }
    const onData = (d: Buffer) => {
      buf += d.toString('latin1')
      const v = themeFromOsc11(buf)
      if (v) done(v)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    stdin.setRawMode(true)
    stdin.on('data', onData)
    stdin.resume()
    stdout.write('\x1b]11;?\x07')
  })
}

export interface Palette {
  level: ColorLevel
  dark: boolean
  /** Colour for an ink `color`/`backgroundColor` prop, or undefined for the terminal default. */
  accent?: string
  muted?: string
  border?: string
  ok?: string
  warn?: string
  danger?: string
  info?: string
  sepal?: string
  addBg?: string
  delBg?: string
  /** Shaded background for the composer; only when the background is known. */
  panel?: string
  /** How to draw the orchid. */
  orchid: 'color' | 'ascii'
}

const NAMED: Pick<Palette, 'accent' | 'muted' | 'border' | 'ok' | 'warn' | 'danger' | 'info' | 'sepal'> = {
  accent: 'magenta',
  muted: 'gray',
  border: 'gray',
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
  info: 'blue',
  sepal: 'green',
}

export function makePalette(theme: 'dark' | 'light', level: ColorLevel, themeKnown = true): Palette {
  if (level === 0) return { level, dark: theme === 'dark', orchid: 'ascii' }
  if (level === 1) return { level, dark: theme === 'dark', orchid: 'ascii', ...NAMED }
  const t = (n: TokenName) => oklchToHex(TOKENS[theme][n])
  return {
    level,
    dark: theme === 'dark',
    accent: t('accent'),
    muted: t('muted'),
    border: t('control-border'),
    ok: t('ok'),
    warn: t('warn'),
    danger: t('danger'),
    info: t('info'),
    sepal: t('sepal'),
    addBg: t('add-bg'),
    delBg: t('del-bg'),
    // 256-colour terminals round the subtle panel shade to a loud grey; skip it there.
    panel: themeKnown && level === 3 ? t('panel-2') : undefined,
    orchid: 'color',
  }
}

export const ThemeContext = createContext<Palette>(makePalette('dark', 3))
export const useTheme = () => useContext(ThemeContext)
