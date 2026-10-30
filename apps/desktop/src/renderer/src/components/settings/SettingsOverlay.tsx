import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AppState, UpdateStatus } from '../../../../shared/ipc'
import { api } from '../../lib/api'
import { formatCombo, isMac, matchesShortcut, shortcutFor } from '../../lib/shortcuts'
import type { PageProps, Save } from './common'
import { Icon } from './icons'
import { DEFAULT_PAGE, isGroup, pageEntry, pageShown, resolvePage, searchSettings, visibleTree, type SearchHit } from './tree'

interface Props {
  app: AppState
  /** The open page's id (see tree.tsx). */
  page: string
  onPage: (id: string) => void
  onState: (s: AppState) => void
  onClose: () => void
  update: UpdateStatus
  /** Opens the bot dialog over Settings. */
  onEditBot: (id?: string) => void
}

interface TreeItem {
  id: string
  label: string
  icon: Parameters<typeof Icon>[0]['name']
  level: 1 | 2
  group: boolean
  parent?: string
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary'

/** Settings as an overlay over the dimmed app: a two-level sidebar, search, and one page at a time. */
export function SettingsOverlay({ app, page, onPage, onState, onClose, update, onEditBot }: Props) {
  const { page: def, group } = pageEntry(page)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(group ? [group.id] : []))
  const [focusId, setFocusId] = useState(page)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const items = useRef(new Map<string, HTMLLIElement>())
  const mac = isMac(app.platform)
  // Pages for features that are turned off (Bots) leave the sidebar and search.
  const tree = useMemo(() => visibleTree(app.settings), [app.settings])

  // Text and number fields save on blur, which an unmounting input never gets: blur first.
  const close = () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    onClose()
  }
  const fail = (e: unknown) => setNotice({ ok: false, text: clean(e) })
  const save: Save = (fn) => void api.settings.set(fn(structuredClone(app.settings))).then(onState, fail)
  /** Opens a page, or a group's first page. */
  const open = (id: string) => {
    const g = tree.find((n) => n.id === id)
    const entry = pageEntry(g && isGroup(g) ? g.children[0].id : resolvePage(id, app.settings))
    if (entry.group) setExpanded((x) => new Set(x).add(entry.group!.id))
    setFocusId(entry.page.id)
    setNotice(null)
    onPage(entry.page.id)
  }

  // The app behind is inert while this is open; focus goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    if (root) root.inert = true
    items.current.get(page)?.focus()
    return () => {
      if (root) root.inert = false
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // Opened elsewhere (a deep link while open): show its group.
  useEffect(() => {
    if (group) setExpanded((x) => (x.has(group.id) ? x : new Set(x).add(group.id)))
    setFocusId(page)
  }, [page])

  // The open page was turned off (an import or reset): show the default page.
  useEffect(() => {
    if (!pageShown(page, app.settings)) onPage(DEFAULT_PAGE)
  }, [page, app.settings])

  // A new page starts at the top.
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0
  }, [page])

  // A search jump scrolls to its row, focuses its control and highlights it briefly.
  useEffect(() => {
    const box = content.current
    if (!box || !flash) return
    const row = box.querySelector<HTMLElement>(`[data-row="${CSS.escape(flash)}"]`)
    if (!row) return setFlash(null)
    row.scrollIntoView({ block: 'center' })
    row.classList.add('flash')
    row.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
    const t = setTimeout(() => (row.classList.remove('flash'), setFlash(null)), 1600)
    return () => clearTimeout(t)
  }, [flash])

  const visible: TreeItem[] = useMemo(
    () =>
      tree.flatMap((n): TreeItem[] => {
        if (!isGroup(n)) return [{ id: n.id, label: n.label, icon: n.icon, level: 1, group: false }]
        const head: TreeItem = { id: n.id, label: n.label, icon: n.icon, level: 1, group: true }
        return expanded.has(n.id) ? [head, ...n.children.map((c): TreeItem => ({ id: c.id, label: c.label, icon: c.icon, level: 2, group: false, parent: n.id }))] : [head]
      }),
    [expanded, tree],
  )

  // The roving tab stop: a page inside a folded group hands it to the group.
  const tabStop = visible.some((v) => v.id === focusId) ? focusId : (pageEntry(focusId).group?.id ?? visible[0]?.id)

  const tabStopRef = useRef(tabStop)
  tabStopRef.current = tabStop

  const focusItem = (id: string) => {
    setFocusId(id)
    items.current.get(id)?.focus()
  }

  const toggleGroup = (id: string) => {
    const opening = !expanded.has(id)
    setExpanded((x) => {
      const next = new Set(x)
      if (opening) next.add(id)
      else next.delete(id)
      return next
    })
    // Opening a group shows its first page, unless one of its pages is already open; focus stays on the group.
    if (opening && group?.id !== id) open(id)
    setFocusId(id)
  }

  const onTreeKey = (e: ReactKeyboardEvent) => {
    // The item that has focus, which can differ from the tab stop right after a group opened a page.
    const focused = (e.target as Element).closest<HTMLElement>('[role=treeitem]')?.dataset.id ?? tabStop
    const i = visible.findIndex((v) => v.id === focused)
    const cur = visible[i]
    if (!cur) return
    const move = (to: number) => (e.preventDefault(), focusItem(visible[Math.max(0, Math.min(visible.length - 1, to))].id))
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(visible.length - 1)
    else if (e.key === 'ArrowRight' && cur.group) {
      e.preventDefault()
      if (!expanded.has(cur.id)) setExpanded((x) => new Set(x).add(cur.id))
      else if (visible[i + 1]?.parent === cur.id) focusItem(visible[i + 1].id)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (cur.group && expanded.has(cur.id)) setExpanded((x) => (x.delete(cur.id), new Set(x)))
      else if (cur.parent) focusItem(cur.parent)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (cur.group) toggleGroup(cur.id)
      else open(cur.id)
    }
  }

  const hits = useMemo(() => searchSettings(query, 12, app.settings), [query, app.settings])
  const jump = (hit: SearchHit) => {
    setQuery('')
    setActive(0)
    open(hit.pageId)
    setFlash(hit.row || null)
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
      if (e.key === 'Tab') (e.preventDefault(), items.current.get(tabStopRef.current)?.focus())
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

  const Page = def.page
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
                  <li key={`${h.pageId}:${h.row}`} id={`so-hit-${i}`} role="option" aria-selected={i === active} className={i === active ? 'sel' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), jump(h))}>
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
          <nav className="so-side" aria-label="Settings sections">
            <ul className="so-tree" role="tree" aria-label="Settings sections" onKeyDown={onTreeKey}>
              {tree.map((n) => {
                const groupOpen = isGroup(n) && expanded.has(n.id)
                const current = !isGroup(n) && n.id === page
                const holds = isGroup(n) && group?.id === n.id
                return (
                  <li
                    key={n.id}
                    ref={(el) => void (el ? items.current.set(n.id, el) : items.current.delete(n.id))}
                    role="treeitem"
                    data-id={n.id}
                    aria-level={1}
                    aria-expanded={isGroup(n) ? groupOpen : undefined}
                    aria-selected={isGroup(n) ? undefined : current}
                    tabIndex={tabStop === n.id ? 0 : -1}
                    className="so-item"
                    onFocus={(e) => e.target === e.currentTarget && setFocusId(n.id)}
                    onClick={(e) => (e.stopPropagation(), isGroup(n) ? toggleGroup(n.id) : open(n.id))}
                  >
                    <div className={`so-row ${current ? 'current' : ''} ${groupOpen ? 'open' : ''} ${holds ? 'holds' : ''}`}>
                      <Icon name={n.icon} />
                      <span className="so-label">{n.label}</span>
                      {isGroup(n) && <Icon name={groupOpen ? 'chevronDown' : 'chevronRight'} size={14} className="so-chevron" />}
                    </div>
                    {isGroup(n) && groupOpen && (
                      <ul role="group">
                        {n.children.map((c) => (
                          <li
                            key={c.id}
                            ref={(el) => void (el ? items.current.set(c.id, el) : items.current.delete(c.id))}
                            role="treeitem"
                            data-id={c.id}
                            aria-level={2}
                            aria-selected={c.id === page}
                            tabIndex={tabStop === c.id ? 0 : -1}
                            className="so-item"
                            onFocus={(e) => (e.stopPropagation(), setFocusId(c.id))}
                            onClick={(e) => (e.stopPropagation(), open(c.id))}
                          >
                            <div className={`so-row sub ${c.id === page ? 'current' : ''}`}>
                              <Icon name={c.icon} size={14} />
                              <span className="so-label">{c.label}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
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
                  {group && (
                    <li>
                      <button className="link" onClick={() => open(group.id)}>
                        {group.label}
                      </button>
                    </li>
                  )}
                  <li aria-current="page">
                    <h2 id="so-page-title">{def.label}</h2>
                  </li>
                </ol>
              </nav>
              <p className="muted so-desc">{def.description}</p>
              {notice && (
                <div className={`so-notice ${notice.ok ? 'ok' : 'error'}`} role={notice.ok ? 'status' : 'alert'}>
                  <span>{notice.text}</span>
                  <button className="notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
                    ×
                  </button>
                </div>
              )}
              <Page key={def.id} {...props} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
