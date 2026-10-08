import type { ReactNode } from 'react'
import { render } from 'ink-testing-library'
import { makePalette, ThemeContext } from '../src/theme/palette.js'

export const strip = (s = '') => s.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

/** Renders with the truecolor dark palette (so colour paths run) and returns plain-text frames. */
export function renderUi(node: ReactNode, level: 0 | 1 | 2 | 3 = 3) {
  const r = render(<ThemeContext.Provider value={makePalette('dark', level)}>{node}</ThemeContext.Provider>)
  return { ...r, text: () => strip(r.lastFrame()) }
}

export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Waits until `fn` stops throwing (for async renders). */
export async function eventually(fn: () => void, timeout = 2000) {
  const end = Date.now() + timeout
  for (;;) {
    try {
      return fn()
    } catch (e) {
      if (Date.now() > end) throw e
      await tick(20)
    }
  }
}

export const KEY = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', shiftTab: '\x1b[Z', backspace: '\x7f', ctrlA: '\x01', ctrlC: '\x03', ctrlJ: '\n' }
