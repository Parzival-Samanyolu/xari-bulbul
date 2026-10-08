import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORCHID_ASCII } from '../src/theme/logo.js'
import { ORCHID } from '../src/theme/orchid.generated.js'
import { detectColorLevel, makePalette, themeFromEnv, themeFromOsc11 } from '../src/theme/palette.js'
import { oklchToHex, TOKENS } from '../src/theme/tokens.js'

describe('colour tokens', () => {
  it('match the desktop stylesheet exactly', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/src/styles.css'), 'utf8')
    for (const theme of ['dark', 'light'] as const) {
      const block = new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(css)![1]
      for (const [name, [l, c, h]] of Object.entries(TOKENS[theme])) {
        const m = new RegExp(`--${name}:\\s*oklch\\(([^)]*)\\)`).exec(block)
        expect(m, `${theme} --${name}`).not.toBeNull()
        expect(m![1].trim().split(/\s+/).map(Number), `${theme} --${name}`).toEqual([l, c, h])
      }
    }
  })

  it('converts OKLCH to sRGB', () => {
    expect(oklchToHex([1, 0, 0])).toBe('#ffffff')
    expect(oklchToHex([0, 0, 0])).toBe('#000000')
    // Velvet plum: red-dominant with blue, little green.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(oklchToHex(TOKENS.light.accent).slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(g)
  })
})

describe('terminal detection', () => {
  it('respects NO_COLOR and FORCE_COLOR', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(0)
    expect(detectColorLevel({ FORCE_COLOR: '0' }, true)).toBe(0)
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true)).toBe(3)
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true)).toBe(2)
    expect(detectColorLevel({ TERM: 'xterm' }, true)).toBe(1)
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, false)).toBe(0)
  })

  it('reads the background from COLORFGBG and OSC 11', () => {
    expect(themeFromEnv({ COLORFGBG: '15;0' })).toBe('dark')
    expect(themeFromEnv({ COLORFGBG: '0;15' })).toBe('light')
    expect(themeFromEnv({})).toBeNull()
    expect(themeFromOsc11('\x1b]11;rgb:ffff/fefe/fdfd\x07')).toBe('light')
    expect(themeFromOsc11('\x1b]11;rgb:1c1c/1616/1919\x1b\\')).toBe('dark')
  })

  it('drops colour entirely with NO_COLOR and uses named colours with 16', () => {
    const none = makePalette('dark', 0)
    expect([none.accent, none.ok, none.danger, none.addBg]).toEqual([undefined, undefined, undefined, undefined])
    expect(none.orchid).toBe('ascii')
    expect(makePalette('dark', 1).accent).toBe('magenta')
    expect(makePalette('light', 3).accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(makePalette('dark', 3, false).panel).toBeUndefined()
  })
})

describe('the orchid', () => {
  it('has a symmetric ASCII fallback', () => {
    const mirror: Record<string, string> = { '/': '\\', '\\': '/', '(': ')', ')': '(', '`': "'", "'": '`' }
    const center = ORCHID_ASCII[0].indexOf('_')
    for (const line of ORCHID_ASCII) {
      for (let i = 0; i < line.length; i++) {
        const j = 2 * center - i
        const a = line[i] ?? ' '
        const b = line[j] ?? ' '
        expect(mirror[a] ?? a, `"${line}" col ${i}`).toBe(b)
      }
    }
  })

  it('has generated half-block art in two sizes', () => {
    for (const size of ['small', 'large'] as const) {
      const rows = ORCHID[size]
      expect(rows.length).toBeGreaterThan(5)
      expect(new Set(rows.map((r) => r.length)).size).toBe(1)
      expect(rows.flat().every(([ch]) => ch === ' ' || ch === '▀' || ch === '▄')).toBe(true)
    }
  })
})
