import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AppState, UiEvent } from '../../../shared/ipc'
import { api } from '../lib/api'
import { basename } from '../lib/format'
import { useT } from '../lib/i18n'
import { errorText } from '../lib/errors'

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

type ClipAction = 'copy' | 'paste'

/**
 * Copy and paste keys: Ctrl+Shift+C/V everywhere, ⌘C/⌘V on macOS, Ctrl+V on Windows, and
 * Ctrl+C off macOS only while text is selected (otherwise it stays the shell's interrupt).
 */
function clipboardKey(e: KeyboardEvent, platform: string, hasSelection: boolean): ClipAction | null {
  const c = e.code
  if (c !== 'KeyC' && c !== 'KeyV') return null
  const action: ClipAction = c === 'KeyC' ? 'copy' : 'paste'
  if (e.altKey) return null
  if (e.ctrlKey && e.shiftKey && !e.metaKey) return action
  if (platform === 'darwin') return e.metaKey && !e.ctrlKey && !e.shiftKey ? action : null
  if (!e.ctrlKey || e.shiftKey || e.metaKey) return null
  if (action === 'copy') return hasSelection ? 'copy' : null
  return platform === 'win32' ? 'paste' : null
}

interface ViewProps {
  cwd: string
  active: boolean
  platform: string
  font: string
  onExit: () => void
  onRestart: () => void
  onClose: () => void
  onError: (e: unknown) => void
}

/** One xterm bound to one PTY in main. The PTY starts on mount and is killed on unmount. */
function TerminalView({ cwd, active, platform, font, onExit, onRestart, onClose, onError }: ViewProps) {
  const { t: tr } = useT()
  const mac = platform === 'darwin'
  const host = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null)
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
    term.attachCustomKeyEventHandler((e) => {
      const clip = clipboardKey(e, platform, term.hasSelection())
      if (clip) {
        // Handled here: not the shell's, and not an app shortcut.
        e.preventDefault()
        e.stopPropagation()
        // Like Windows Terminal: after Ctrl+C copies, the next Ctrl+C interrupts again.
        const plainCtrl = clip === 'copy' && e.ctrlKey && !e.shiftKey
        if (e.type === 'keydown') void clipboard(term, clip, onError).then(() => plainCtrl && term.clearSelection())
        return false
      }
      return !isAppShortcut(e, mac)
    })
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
        term.write(`\r\n${errorText(e)}\r\n`)
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

  const openMenu = (x: number, y: number) => {
    const term = xterm.current
    if (term) setMenu({ x, y, selection: term.hasSelection() })
  }
  const closeMenu = () => {
    setMenu(null)
    xterm.current?.focus()
  }
  const run = (fn: (term: XTerm) => void) => {
    const term = xterm.current
    closeMenu()
    if (term) fn(term)
  }
  const keys = mac ? { copy: '⌘C', paste: '⌘V' } : { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V' }

  return (
    <>
      <div
        ref={host}
        className="term-host"
        hidden={!active}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu(e.clientX, e.clientY)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            e.stopPropagation()
            const r = host.current!.getBoundingClientRect()
            openMenu(r.left + 24, r.top + 24)
          }
        }}
      />
      {menu && active && (
        <TermMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          <button role="menuitem" disabled={!menu.selection} onClick={() => run((t) => void clipboard(t, 'copy', onError))}>
            {tr('common.copy')}
            <span className="term-menu-key">{keys.copy}</span>
          </button>
          <button role="menuitem" onClick={() => run((t) => void clipboard(t, 'paste', onError))}>
            {tr('chat.terminal.paste')}
            <span className="term-menu-key">{keys.paste}</span>
          </button>
          <button role="menuitem" onClick={() => run((t) => t.selectAll())}>
            {tr('chat.terminal.selectAll')}
          </button>
          <button role="menuitem" onClick={() => run((t) => t.clear())}>
            {tr('chat.terminal.clear')}
          </button>
          <div className="term-menu-sep" role="separator" />
          <button role="menuitem" onClick={() => run(() => onRestart())}>
            {tr('chat.terminal.restart')}
          </button>
          <button role="menuitem" className="danger" onClick={() => run(() => onClose())}>
            {tr('chat.terminal.close')}
          </button>
        </TermMenu>
      )}
    </>
  )
}

/** Copies the selection, or pastes the clipboard into the shell (bracketed when the shell asks for it). */
async function clipboard(term: XTerm, action: ClipAction, onError: (e: unknown) => void) {
  try {
    if (action === 'copy') {
      const text = term.getSelection()
      if (text) await navigator.clipboard.writeText(text)
    } else {
      const text = await navigator.clipboard.readText()
      if (text) term.paste(text)
    }
  } catch (e) {
    onError(e)
  }
}

/** Right-click menu on a terminal, styled like the app's other menus. */
function TermMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const { t } = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep it on screen.
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    const onDown = (e: MouseEvent) => !el.contains(e.target as Node) && closeRef.current()
    const onBlur = () => closeRef.current()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [x, y])

  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    // Keys stay in the menu: Escape here shouldn't also stop the chat.
    e.stopPropagation()
    if (e.key === 'Escape') (e.preventDefault(), onClose())
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Tab') onClose()
  }

  return (
    <div className="menu term-menu" role="menu" aria-label={t('chat.terminal.menu')} ref={ref} style={{ left: pos.left, top: pos.top }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  )
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
  const { t: tr } = useT()
  const cwd = app.workspace
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<Record<string, number>>({})
  const mine = tabs.filter((t) => t.cwd === cwd)
  const current = cwd ? (mine.find((t) => t.key === active[cwd]) ?? mine.at(-1)) : undefined

  /** Starts a terminal in the folder; with `ifNone`, only when the folder has none yet. */
  const add = (ifNone = false) => {
    if (!cwd) return
    const t = { key: ++tabKey, cwd }
    // Pure updaters (StrictMode runs effects and updaters twice).
    setTabs((ts) => (ifNone && ts.some((x) => x.cwd === cwd) ? ts : [...ts, t]))
    if (!ifNone) setActive((a) => ({ ...a, [cwd]: t.key }))
  }
  const close = (key: number) => setTabs((ts) => ts.filter((t) => t.key !== key))
  /** A fresh shell in the same tab: the new key remounts the view, which kills the old PTY. */
  const restart = (key: number) => {
    const next = ++tabKey
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, key: next } : t)))
    setActive((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === key ? next : v])))
  }

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
      <div className="ptabs" role="group" aria-label={tr('chat.terminal.tabs')}>
        <span className="ptabs-title">{tr('chat.terminal.title')}</span>
        {mine.map((t, i) => (
          <span key={t.key} className={`ttab ${current?.key === t.key ? 'active' : ''}`}>
            <button aria-pressed={current?.key === t.key} onClick={() => setActive((a) => ({ ...a, [t.cwd]: t.key }))} title={t.cwd}>
              {basename(t.cwd)}
              {mine.length > 1 ? ` ${i + 1}` : ''}
            </button>
            <button className="ttab-close" aria-label={tr('chat.terminal.close')} title={tr('chat.terminal.close')} onClick={() => close(t.key)}>
              ×
            </button>
          </span>
        ))}
        <button className="ttab-add" aria-label={tr('chat.terminal.new')} title={tr('chat.terminal.new')} onClick={() => add()} disabled={!cwd}>
          +
        </button>
      </div>
      <div className="term-body">
        {!cwd && <p className="muted small pad">{tr('chat.terminal.noFolder')}</p>}
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            cwd={t.cwd}
            active={visible && t.key === current?.key}
            platform={app.platform}
            font={app.settings.appearance.codeFontFamily}
            onExit={() => close(t.key)}
            onRestart={() => restart(t.key)}
            onClose={() => close(t.key)}
            onError={onError}
          />
        ))}
      </div>
    </div>
  )
}
