import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AppState, UiEvent } from '../../../shared/ipc'
import { api } from '../lib/api'
import { basename } from '../lib/format'

/** Any CSS color (the theme uses oklch) as #rrggbb, which xterm understands. */
function toHex(css: string, fallback: string): string {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx || !css) return fallback
  ctx.fillStyle = fallback
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => toHex(css.getPropertyValue(name).trim(), fallback)
  return {
    background: v('--code-bg', '#16171a'),
    foreground: v('--text', '#eeeeee'),
    cursor: v('--accent', '#cc88aa'),
    cursorAccent: v('--code-bg', '#16171a'),
    selectionBackground: v('--accent-soft', '#553344'),
    selectionForeground: v('--text', '#eeeeee'),
  }
}

/** App shortcuts that should reach the window instead of the shell. */
function isAppShortcut(e: KeyboardEvent, mac: boolean): boolean {
  if (e.type !== 'keydown') return false
  const k = e.key.toLowerCase()
  if (mac) return e.metaKey && (k === 'j' || k === 'k' || k === 'n' || k === ',' || /^[1-9]$/.test(k) || (e.altKey && e.code === 'KeyB'))
  // Elsewhere Ctrl+letters belong to the shell; only the panel toggles are taken.
  return e.ctrlKey && ((k === 'j' && !e.altKey) || (e.altKey && e.code === 'KeyB'))
}

interface ViewProps {
  cwd: string
  active: boolean
  mac: boolean
  font: string
  onExit: () => void
  onError: (e: unknown) => void
}

/** One xterm bound to one PTY in main. The PTY starts on mount and is killed on unmount. */
function TerminalView({ cwd, active, mac, font, onExit, onError }: ViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const xterm = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const ptyId = useRef<string | null>(null)
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  useEffect(() => {
    const el = host.current!
    const term = new XTerm({ fontFamily: font, fontSize: 13, cursorBlink: true, scrollback: 5000, theme: themeFromCss(), allowProposedApi: false, macOptionIsMeta: false })
    const fitter = new FitAddon()
    term.loadAddon(fitter)
    term.open(el)
    term.attachCustomKeyEventHandler((e) => !isAppShortcut(e, mac))
    xterm.current = term
    fit.current = fitter
    try {
      fitter.fit()
    } catch {
      // Hidden: fits when shown.
    }

    let disposed = false
    let id: string | null = null
    // Output can arrive before `open` resolves; keep it until the id is known.
    const early: Extract<UiEvent, { type: 'term_data' }>[] = []
    const off = api.onEvent((e) => {
      if (e.type === 'term_data') {
        if (id === null) early.push(e)
        else if (e.id === id) term.write(e.data)
      } else if (e.type === 'term_exit' && e.id === id) {
        id = null
        ptyId.current = null
        if (!disposed) exitRef.current()
      }
    })
    api.term.open(cwd, term.cols, term.rows).then(
      (newId) => {
        if (disposed) return api.term.kill(newId)
        id = newId
        ptyId.current = newId
        for (const e of early) if (e.id === newId) term.write(e.data)
        early.length = 0
      },
      (e) => {
        term.write(`\r\n${String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\r\n`)
        onError(e)
      },
    )
    const input = term.onData((d) => ptyId.current && api.term.write(ptyId.current, d))
    const resize = term.onResize(({ cols, rows }) => ptyId.current && api.term.resize(ptyId.current, cols, rows))
    const ro = new ResizeObserver(() => {
      if (el.offsetParent === null) return
      try {
        fitter.fit()
      } catch {
        // Not laid out yet.
      }
    })
    ro.observe(el)
    // Follow theme changes.
    const mo = new MutationObserver(() => (term.options.theme = themeFromCss()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      disposed = true
      ro.disconnect()
      mo.disconnect()
      input.dispose()
      resize.dispose()
      off()
      if (id) api.term.kill(id)
      term.dispose()
      xterm.current = null
    }
    // The PTY lives as long as this view; cwd never changes for a mounted view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (xterm.current) xterm.current.options.fontFamily = font
  }, [font])

  useEffect(() => {
    if (!active) return
    try {
      fit.current?.fit()
    } catch {
      // Not laid out yet.
    }
    xterm.current?.focus()
  }, [active])

  return <div ref={host} className="term-host" hidden={!active} />
}

interface Tab {
  key: number
  cwd: string
}

let tabKey = 0

interface PanelProps {
  app: AppState
  /** The bottom panel is open (terminals keep running while it's closed). */
  visible: boolean
  onError: (e: unknown) => void
}

/** Terminals for the bottom panel, per folder: the chat's folder shows its own. */
export function TerminalPanel({ app, visible, onError }: PanelProps) {
  const cwd = app.workspace
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<Record<string, number>>({})
  const mine = tabs.filter((t) => t.cwd === cwd)
  const current = cwd ? (mine.find((t) => t.key === active[cwd]) ?? mine.at(-1)) : undefined
  const mac = app.platform === 'darwin'

  /** Starts a terminal in the folder; with `ifNone`, only when the folder has none yet. */
  const add = (ifNone = false) => {
    if (!cwd) return
    const t = { key: ++tabKey, cwd }
    // Pure updaters (StrictMode runs effects and updaters twice).
    setTabs((ts) => (ifNone && ts.some((x) => x.cwd === cwd) ? ts : [...ts, t]))
    if (!ifNone) setActive((a) => ({ ...a, [cwd]: t.key }))
  }
  const close = (key: number) => setTabs((ts) => ts.filter((t) => t.key !== key))

  // Opening the panel in a folder with no terminal starts one.
  useEffect(() => {
    if (visible && cwd) add(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, cwd])

  // Folders closed in the sidebar: their terminals are killed in main; drop the tabs too.
  const open = app.settings.app.openWorkspaces.join('\0')
  useEffect(() => {
    const folders = new Set(app.settings.app.openWorkspaces)
    setTabs((ts) => (ts.every((t) => folders.has(t.cwd)) ? ts : ts.filter((t) => folders.has(t.cwd))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div className="bpanel">
      <div className="ptabs" role="group" aria-label="Terminals">
        <span className="ptabs-title">Terminal</span>
        {mine.map((t, i) => (
          <span key={t.key} className={`ttab ${current?.key === t.key ? 'active' : ''}`}>
            <button aria-pressed={current?.key === t.key} onClick={() => setActive((a) => ({ ...a, [t.cwd]: t.key }))} title={t.cwd}>
              {basename(t.cwd)}
              {mine.length > 1 ? ` ${i + 1}` : ''}
            </button>
            <button className="ttab-close" aria-label="Close terminal" title="Close terminal" onClick={() => close(t.key)}>
              ×
            </button>
          </span>
        ))}
        <button className="ttab-add" aria-label="New terminal" title="New terminal" onClick={() => add()} disabled={!cwd}>
          +
        </button>
      </div>
      <div className="term-body">
        {!cwd && <p className="muted small pad">Open a folder to use the terminal.</p>}
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            cwd={t.cwd}
            active={visible && t.key === current?.key}
            mac={mac}
            font={app.settings.appearance.codeFontFamily}
            onExit={() => close(t.key)}
            onError={onError}
          />
        ))}
      </div>
    </div>
  )
}
