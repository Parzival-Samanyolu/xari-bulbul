import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AppState, UpdateStatus } from '../../../../shared/ipc'
import { api } from '../../lib/api'
import { formatCombo, isMac, matchesShortcut, shortcutFor } from '../../lib/shortcuts'
import type { PageProps, Save } from './common'
import { Icon } from './icons'
import { DEFAULT_PAGE, pageEntry, pageShown, resolvePage, searchSettings, visibleTabs, type SearchHit } from './tree'

interface Props {
  app: AppState
  /** The open tab's id, or a section's id to open its tab scrolled to it (see tree.tsx). */
  page: string
  onPage: (id: string) => void
  onState: (s: AppState) => void
  onClose: () => void
  update: UpdateStatus
  /** Opens the bot dialog over Settings. */
  onEditBot: (id?: string) => void
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary'

/** Settings as an overlay over the dimmed app: a flat list of tabs, search, and one tab at a time. */
export function SettingsOverlay({ app, page, onPage, onState, onClose, update, onEditBot }: Props) {
  const { tab: shownTab } = pageEntry(page)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** Where to scroll after a tab renders: a section, and a row in it to highlight. */
  const [target, setTarget] = useState<{ section: string | null; row: string | null; n: number } | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const items = useRef(new Map<string, HTMLButtonElement>())
  /** Set while a page change comes from open(), which sets its own target. */
  const opening = useRef(false)
  const mac = isMac(app.platform)
  // Sections for features that are turned off leave their tab and search.
  const tabs = useMemo(() => visibleTabs(app.settings), [app.settings])
  const tab = tabs.find((t) => t.id === shownTab.id) ?? shownTab

  // Text and number fields save on blur, which an unmounting input never gets: blur first.
  const close = () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    onClose()
  }
  const fail = (e: unknown) => setNotice({ ok: false, text: clean(e) })
  const save: Save = (fn) => void api.settings.set(fn(structuredClone(app.settings))).then(onState, fail)
  /** Opens a tab, or a section's tab scrolled to it (and to `row` in it). */
  const open = (id: string, row?: string) => {
    const to = resolvePage(id, app.settings)
    const { section } = pageEntry(to)
    setNotice(null)
    setTarget({ section: section?.id ?? null, row: row || null, n: Date.now() })
    if (to !== page) {
      opening.current = true
      onPage(to)
    }
  }

  // The app behind is inert while this is open; focus goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    if (root) root.inert = true
    items.current.get(tab.id)?.focus()
    return () => {
      if (root) root.inert = false
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // Opened elsewhere (at launch, or a deep link while open): scroll to its section.
  useEffect(() => {
    if (opening.current) return void (opening.current = false)
    setTarget({ section: pageEntry(page).section?.id ?? null, row: null, n: Date.now() })
  }, [page])

  // The open tab or section was turned off (an import or reset): show the default tab.
  useEffect(() => {
    if (!pageShown(page, app.settings)) onPage(DEFAULT_PAGE)
  }, [page, app.settings])

  // A new tab starts at the top, a section link at its section; a search jump scrolls to its row,
  // focuses its control and highlights it briefly. Rows are looked up inside their section, since
  // two sections of one tab can have rows with the same label.
  useEffect(() => {
    const box = content.current
    if (!box || !target) return
    const scope = target.section ? box.querySelector<HTMLElement>(`[data-section="${CSS.escape(target.section)}"]`) : null
    if (!target.row) {
      if (scope && tab.sections.length > 1) scope.scrollIntoView({ block: 'start' })
      else box.scrollTop = 0
      return
    }
    const row = (scope ?? box).querySelector<HTMLElement>(`[data-row="${CSS.escape(target.row)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.classList.add('flash')
    row.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
    const t = setTimeout(() => row.classList.remove('flash'), 1600)
    return () => (clearTimeout(t), row.classList.remove('flash'))
  }, [target])

  const onTabsKey = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === (e.target as HTMLElement).dataset.id)
    if (i < 0) return
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
    if (to == null) return
    e.preventDefault()
    items.current.get(tabs[Math.max(0, Math.min(tabs.length - 1, to))].id)?.focus()
  }

  const hits = useMemo(() => searchSettings(query, 12, app.settings), [query, app.settings])
  const jump = (hit: SearchHit) => {
    setQuery('')
    setActive(0)
    open(hit.sectionId || hit.tabId, hit.row)
  }

  const onSearchKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
    else if (e.key === 'Enter' && hits[active]) (e.preventDefault(), jump(hits[active]))
  }

  /** Esc, search and close keys. Also called for key presses after focus fell out of the dialog (a closed dialog, a removed button). */
  const commandKey = (e: KeyboardEvent): boolean => {
    if (e.key === 'Escape') {
      if (query) {
        setQuery('')
        search.current?.focus()
      } else close()
    } else if (matchesShortcut(e, app.settings, 'modelPicker', mac)) {
      search.current?.focus()
      search.current?.select()
    } else if (matchesShortcut(e, app.settings, 'settings', mac)) close()
    else return false
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  const commandRef = useRef(commandKey)
  commandRef.current = commandKey
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => {
      const t = e.target as Element | null
      if (t && t !== document.body && t !== document.documentElement) return
      if (commandRef.current(e)) return
      // Any other key brings focus back into the dialog.
      if (e.key === 'Tab') (e.preventDefault(), dialog.current?.querySelector<HTMLElement>('.so-row.current')?.focus())
    }
    document.addEventListener('keydown', onDocKey)
    return () => document.removeEventListener('keydown', onDocKey)
  }, [])

  const onKey = (e: ReactKeyboardEvent) => {
    // Dialogs opened from a page (model switcher, plugin details) handle their own keys.
    const nested = (e.target as Element).closest('.overlay')
    if (nested) return
    if (commandKey(e.nativeEvent)) e.stopPropagation()
    else if (e.key === 'Tab') {
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null && !el.closest('.overlay'))
      if (!f.length) return
      const at = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && at <= 0) (e.preventDefault(), f.at(-1)!.focus())
      else if (!e.shiftKey && at === f.length - 1) (e.preventDefault(), f[0].focus())
    }
  }

  const importFile = () =>
    confirm('Importing replaces your current settings with the file’s. API keys, chats and your open folders stay. Choose a file?') &&
    api.settings.import().then((s) => {
      if (!s) return
      onState(s)
      setNotice({ ok: true, text: 'Settings imported.' })
    }, fail)
  const exportFile = () => api.settings.export().then((ok) => ok && setNotice({ ok: true, text: 'Settings exported. API keys, tokens and your open folders are never included.' }), fail)
  const reset = () => {
    if (!confirm('Reset every setting to its default? API keys, chats and your open folders are kept.')) return
    api.settings.reset().then((s) => (onState(s), setNotice({ ok: true, text: 'Settings reset to defaults.' })), fail)
  }

  const props: PageProps = { app, save, onState, onError: fail, go: open, update, close, editBot: onEditBot }
  const searchKeys = formatCombo(shortcutFor(app.settings, 'modelPicker'), mac)
  const listOpen = query.trim() !== ''

  return createPortal(
    <div className="so-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="so" role="dialog" aria-modal="true" aria-label="Settings" ref={dialog} onKeyDown={onKey}>
        <header className="so-top">
          <div className="so-search">
            <Icon name="search" className="muted" />
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-label="Search settings"
              aria-expanded={listOpen}
              aria-controls="so-results"
              aria-autocomplete="list"
              aria-activedescendant={listOpen && hits[active] ? `so-hit-${active}` : undefined}
              placeholder="Search"
              value={query}
              onChange={(e) => (setQuery(e.target.value), setActive(0))}
              onKeyDown={onSearchKey}
            />
            {!query && <kbd aria-hidden>{searchKeys}</kbd>}
            {listOpen && (
              <ul className="so-results" id="so-results" role="listbox" aria-label="Matching settings">
                {hits.map((h, i) => (
                  <li key={`${h.tabId}:${h.sectionId}:${h.row}`} id={`so-hit-${i}`} role="option" aria-selected={i === active} className={i === active ? 'sel' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), jump(h))}>
                    <span>{h.label}</span>
                    <span className="muted small">{h.where}</span>
                  </li>
                ))}
                {!hits.length && <li className="muted small so-empty">No settings match “{query.trim()}”.</li>}
              </ul>
            )}
          </div>
          <button className="so-close icon-btn" aria-label="Close settings" title="Close (Esc)" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        <div className="so-body">
          <nav className="so-side" aria-label="Settings">
            <ul className="so-tree" onKeyDown={onTabsKey}>
              {tabs.map((t) => (
                <li key={t.id} className="so-item">
                  <button
                    ref={(el) => void (el ? items.current.set(t.id, el) : items.current.delete(t.id))}
                    data-id={t.id}
                    className={`so-row ${t.id === tab.id ? 'current' : ''}`}
                    aria-current={t.id === tab.id ? 'page' : undefined}
                    onClick={() => open(t.id)}
                  >
                    <Icon name={t.icon} />
                    <span className="so-label">{t.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="so-side-foot">
              <button className="icon-btn" aria-label="Import settings from a file" title="Import settings" onClick={importFile}>
                <Icon name="download" />
              </button>
              <button className="icon-btn" aria-label="Export settings to a file" title="Export settings (no API keys)" onClick={exportFile}>
                <Icon name="upload" />
              </button>
              <button className="icon-btn" aria-label="Reset settings to defaults" title="Reset to defaults" onClick={reset}>
                <Icon name="reset" />
              </button>
            </div>
          </nav>
          <div className="so-content" ref={content} role="region" aria-labelledby="so-page-title">
            <div className="so-page">
              <nav aria-label="Breadcrumb">
                <ol className="so-crumbs">
                  <li>Settings</li>
                  <li aria-current="page">
                    <h2 id="so-page-title">{tab.label}</h2>
                  </li>
                </ol>
              </nav>
              <p className="muted so-desc">{tab.description}</p>
              {tab.sections.length > 1 && (
                <nav className="so-toc" aria-label={`Sections in ${tab.label}`}>
                  {tab.sections.map((p) => (
                    <button key={p.id} className="so-toc-link" onClick={() => open(p.id)}>
                      {p.label}
                    </button>
                  ))}
                </nav>
              )}
              {notice && (
                <div className={`so-notice ${notice.ok ? 'ok' : 'error'}`} role={notice.ok ? 'status' : 'alert'}>
                  <span>{notice.text}</span>
                  <button className="notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
                    ×
                  </button>
                </div>
              )}
              {tab.sections.map((p) => {
                const Page = p.page
                if (tab.sections.length === 1)
                  return (
                    <div key={p.id} data-section={p.id}>
                      <Page {...props} />
                    </div>
                  )
                return (
                  <section key={p.id} className="so-part" data-section={p.id} aria-labelledby={`so-part-${p.id}`}>
                    <header className="so-part-head">
                      <h3 id={`so-part-${p.id}`}>{p.label}</h3>
                      {p.description && <p className="muted small">{p.description}</p>}
                    </header>
                    <Page {...props} />
                  </section>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
