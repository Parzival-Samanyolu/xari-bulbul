// Xarı's stand-ins for the parts of Gemini CLI the vendored components expect: the colour theme,
// settings, logging, a few small helpers, the arrow-key selection hook and Xarı's interface
// language (`useT`). Written for Xarı.
import { useEffect, useRef, useState } from 'react'
import { useInput } from 'ink'
import { Theme, type ColorsTheme } from './theme.js'
import type { SemanticColors } from './semantic-tokens.js'
import { makeDefaultTheme } from './default-dark.js'

export const DEFAULT_INPUT_BACKGROUND_OPACITY = 0.5
export const DEFAULT_SELECTION_OPACITY = 0.2
export const LRU_BUFFER_PERF_CACHE_LIMIT = 20_000

/** Xarı's palette: the orchid's plum and lime on the terminal's own background. */
const xariDark: ColorsTheme = {
  type: 'dark',
  Background: '#16121a',
  Foreground: '#ece4ea',
  LightBlue: '#9fc4ff',
  AccentBlue: '#7fb0ff',
  AccentPurple: '#e46bb4',
  AccentCyan: '#5fd0d8',
  AccentGreen: '#b9d63f',
  AccentYellow: '#f0c674',
  AccentRed: '#ff6b7a',
  DiffAdded: '#21402a',
  DiffRemoved: '#4a1f28',
  Comment: '#8a7f88',
  Gray: '#9a8f98',
  DarkGray: '#4c4450',
}

const xariLight: ColorsTheme = {
  type: 'light',
  Background: '#fdfafc',
  Foreground: '#1f1720',
  LightBlue: '#1f5fbf',
  AccentBlue: '#1f5fbf',
  AccentPurple: '#a3236f',
  AccentCyan: '#0f6f78',
  AccentGreen: '#4f7a10',
  AccentYellow: '#8a5b00',
  AccentRed: '#c0283a',
  DiffAdded: '#d8f0d0',
  DiffRemoved: '#f6d4d8',
  Comment: '#7a6f78',
  Gray: '#6f646c',
  DarkGray: '#c9bfc6',
}

/** Light when the terminal says its background is light (COLORFGBG), or XARI_THEME=light. */
function pickPalette(): ColorsTheme {
  const want = process.env.XARI_THEME
  if (want === 'light') return xariLight
  if (want === 'dark') return xariDark
  const bg = Number(process.env.COLORFGBG?.split(';').pop())
  return Number.isFinite(bg) && (bg === 7 || bg === 15) ? xariLight : xariDark
}

const palette = pickPalette()
const active: Theme = makeDefaultTheme(palette, palette.type === 'light' ? 'Xarı light' : 'Xarı dark')

export const themeManager = { getActiveTheme: () => active, getSemanticColors: () => active.semanticColors }

/** Semantic colours, with the accent and focus turned to Xarı's plum and lime. */
export const theme: SemanticColors = {
  ...active.semanticColors,
  text: { ...active.semanticColors.text, accent: palette.AccentPurple, link: palette.AccentBlue },
  ui: { ...active.semanticColors.ui, focus: palette.AccentPurple, active: palette.AccentPurple },
}

export const colors = palette

/** Xarı's messages in the interface language, for the text Xarı wrote in these components. */
export { useT } from '../../t.js'

export const debugLogger = { warn: (..._a: unknown[]) => {}, debug: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} }

/** The few settings the vendored components read. */
export interface LoadedSettings {
  merged: { ui: { showLineNumbers: boolean; useAlternateBuffer: boolean } }
}
const settings: LoadedSettings = { merged: { ui: { showLineNumbers: false, useAlternateBuffer: false } } }
export const useSettings = (): LoadedSettings => settings
export const useAlternateBuffer = () => false

export const safeRepeat = (s: string, n: number) => (n > 0 && Number.isFinite(n) ? s.repeat(Math.floor(n)) : '')

export function getFileExtension(filename: string | undefined): string | null {
  if (!filename) return null
  const m = /\.([^./\\]+)$/.exec(filename)
  return m ? m[1].toLowerCase() : null
}

/** A small least-recently-used cache (what Gemini CLI takes from mnemonist). */
export class LRUCache<K, V> {
  private map = new Map<K, V>()
  constructor(private readonly limit: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: K, value: V) {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K)
    return this
  }
  has(key: K) {
    return this.map.has(key)
  }
  clear() {
    this.map.clear()
  }
}

export interface SelectionListItem<T> {
  key: string
  value: T
  disabled?: boolean
  hideNumber?: boolean
}

export interface UseSelectionListOptions<T> {
  items: Array<SelectionListItem<T>>
  initialIndex?: number
  onSelect: (value: T) => void
  onHighlight?: (value: T) => void
  isFocused?: boolean
  showNumbers?: boolean
  wrapAround?: boolean
  focusKey?: string
  priority?: boolean
}

/** Arrow keys (and j/k), number keys and Enter for a list, on Ink's own input hook. */
export function useSelectionList<T>({ items, initialIndex = 0, onSelect, onHighlight, isFocused = true, showNumbers = true, wrapAround = true }: UseSelectionListOptions<T>) {
  const [activeIndex, setIndexState] = useState(Math.min(initialIndex, Math.max(0, items.length - 1)))
  // Keys can arrive in one burst (↓ then Enter); the ref sees each move before React redraws.
  const current = useRef(activeIndex)
  const setActiveIndex = (i: number) => {
    current.current = i
    setIndexState(i)
  }
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(Math.max(0, items.length - 1))
  }, [items.length, activeIndex])
  const move = (dir: 1 | -1) => {
    if (!items.length) return
    let i = current.current
    for (let n = 0; n < items.length; n++) {
      i += dir
      if (i < 0) i = wrapAround ? items.length - 1 : 0
      if (i >= items.length) i = wrapAround ? 0 : items.length - 1
      if (!items[i].disabled) break
    }
    setActiveIndex(i)
    onHighlight?.(items[i].value)
  }
  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') move(-1)
      else if (key.downArrow || input === 'j') move(1)
      else if (key.return) {
        const it = items[activeIndex]
        if (it && !it.disabled) onSelect(it.value)
      } else if (showNumbers && /^[1-9]$/.test(input)) {
        const it = items[Number(input) - 1]
        if (it && !it.disabled) {
          setActiveIndex(Number(input) - 1)
          onSelect(it.value)
        }
      }
    },
    { isActive: isFocused },
  )
  return { activeIndex, setActiveIndex }
}

/** Gemini CLI can click list items with the mouse; Xarı's terminal UI is keyboard-only. */
export const useMouseClick = (..._a: unknown[]) => {}
