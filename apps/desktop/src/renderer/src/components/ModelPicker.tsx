import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ModelInfo, ModelRef, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { perMillion, tokens } from '../lib/format'

interface Props {
  app: AppState
  onClose: () => void
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  /** When set, the picker returns a choice instead of switching the session model. */
  onPick?: (ref: ModelRef) => void
  title?: string
}

type Sort = Settings['models']['picker']['sort']
type Section = 'current' | 'fav' | 'recent' | 'all'
type Row = { header: string; providerId?: string; shown?: number; total?: number } | { model: ModelInfo; section: Section }

const key = (r: ModelRef) => `${r.providerId}:${r.modelId}`
const refOf = (m: ModelInfo): ModelRef => ({ providerId: m.providerId, modelId: m.id })

const SORTS: { value: Sort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name' },
  { value: 'context', label: 'Context' },
  { value: 'price', label: 'Price' },
]

function sortModels(ms: ModelInfo[], sort: Sort): ModelInfo[] {
  const out = [...ms]
  if (sort === 'newest') out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
  else if (sort === 'context') out.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
  else if (sort === 'price') out.sort((a, b) => (a.pricing?.prompt ?? Infinity) - (b.pricing?.prompt ?? Infinity))
  else out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** "Qwen: Qwen3.8 27B (free)" → "Qwen3.8 27B"; the free badge and provider group say the rest. */
function displayName(m: ModelInfo): string {
  let n = m.name.replace(/\s*\(free\)\s*$/i, '')
  const colon = n.indexOf(': ')
  if (colon > 0 && colon < 24) n = n.slice(colon + 2)
  return n
}

function price(m: ModelInfo): string {
  if (m.free) return 'free'
  if (!m.pricing) return '—'
  return `${perMillion(m.pricing.prompt)} / ${perMillion(m.pricing.completion)}`
}

export function ModelPicker({ app, onClose, onState, onError, onPick, title }: Props) {
  const [q, setQ] = useState('')
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const { favorites, recent, picker } = app.settings.models
  const providers = app.settings.providers.filter((p) => p.enabled)
  const current = onPick ? undefined : app.session?.meta.model
  const favSet = new Set(favorites.map(key))

  const savePicker = (patch: Partial<typeof picker>) =>
    api.settings.set({ ...app.settings, models: { ...app.settings.models, picker: { ...picker, ...patch } } }).then(onState, onError)

  const load = (id: string, refresh = false) => {
    setLoading((l) => ({ ...l, [id]: true }))
    api.models
      .list(id, refresh)
      .then((m) => {
        setModels((all) => ({ ...all, [id]: m }))
        setErrors((e) => ({ ...e, [id]: '' }))
      })
      .catch((e) => setErrors((all) => ({ ...all, [id]: String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })))
      .finally(() => setLoading((l) => ({ ...l, [id]: false })))
  }

  useEffect(() => {
    input.current?.focus()
    for (const p of providers) load(p.id)
  }, [])

  const find = (r: ModelRef): ModelInfo =>
    models[r.providerId]?.find((m) => m.id === r.modelId) ?? { id: r.modelId, name: r.modelId, providerId: r.providerId, free: false, supportsTools: true }

  const rows = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const match = (m: ModelInfo) => terms.every((t) => `${m.id} ${m.name} ${m.providerId} ${m.free ? 'free' : ''}`.toLowerCase().includes(t))
    // Providers that report no pricing at all (e.g. Ollama) aren't hidden by "free only".
    const passes = (m: ModelInfo, priced: boolean) => (!picker.toolsOnly || m.supportsTools) && (!picker.freeOnly || m.free || !priced)
    const out: Row[] = []
    const pinned = new Set<string>()
    const pin = (header: string, section: Section, ms: ModelInfo[]) => {
      const fresh = ms.filter((m) => !pinned.has(key(refOf(m))) && match(m))
      if (!fresh.length) return
      out.push({ header })
      for (const m of fresh) {
        pinned.add(key(refOf(m)))
        out.push({ model: m, section })
      }
    }
    // Current, favorites and recents are always shown, whatever the filters say.
    if (current) pin('Current', 'current', [find(current)])
    pin('Favorites', 'fav', favorites.map(find))
    if (!terms.length) pin('Recent', 'recent', recent.slice(0, 5).map(find))
    for (const p of providers) {
      const all = models[p.id] ?? []
      const priced = all.some((m) => m.pricing)
      const shown = sortModels(all.filter((m) => passes(m, priced) && match(m) && !pinned.has(key(refOf(m)))), picker.sort)
      // Hide empty groups unless they have something to say (loading, error, missing key).
      if (!shown.length && (terms.length || (app.ready[p.id] && !loading[p.id] && !errors[p.id] && all.length))) continue
      out.push({ header: p.name, providerId: p.id, shown: shown.length, total: all.length })
      shown.forEach((m) => out.push({ model: m, section: 'all' }))
    }
    return out
  }, [q, models, favorites, recent, picker, current?.providerId, current?.modelId, loading, errors])

  const selectable = rows.filter((r): r is Extract<Row, { model: ModelInfo }> => 'model' in r)
  const noMatches = q.trim() !== '' && selectable.length === 0
  const optionId = (i: number) => `model-opt-${i}`

  const choose = (m: ModelInfo) => {
    const ref = refOf(m)
    if (onPick) onPick(ref)
    else api.agent.setModel(ref).then(onState, onError)
    onClose()
  }
  const toggleFav = (m: ModelInfo) => {
    const ref = refOf(m)
    const next = favSet.has(key(ref)) ? favorites.filter((f) => key(f) !== key(ref)) : [...favorites, ref]
    api.settings.set({ ...app.settings, models: { ...app.settings.models, favorites: next } }).then(onState, onError)
  }

  useEffect(() => {
    document.getElementById(optionId(sel))?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, selectable.length - 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)))
    else if (e.key === 'Enter' && e.target === input.current && selectable[sel]) choose(selectable[sel].model)
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selectable[sel]) (e.preventDefault(), toggleFav(selectable[sel].model))
    else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>('input, select, button:not([disabled])') ?? [])]
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) (e.preventDefault(), f.at(-1)?.focus())
      else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0]?.focus())
    }
  }

  let idx = -1
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="picker"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Switch model'}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="picker-head">
          <input
            ref={input}
            value={q}
            role="combobox"
            aria-expanded="true"
            aria-controls="model-list"
            aria-activedescendant={selectable.length ? optionId(sel) : undefined}
            aria-label="Search models"
            placeholder={title ?? 'Search models…'}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
          />
        </div>
        <div className="picker-filters">
          <button className={`fchip ${picker.freeOnly ? 'on' : ''}`} aria-pressed={picker.freeOnly} onClick={() => savePicker({ freeOnly: !picker.freeOnly })}>
            Free only
          </button>
          <button
            className={`fchip ${picker.toolsOnly ? 'on' : ''}`}
            aria-pressed={picker.toolsOnly}
            onClick={() => savePicker({ toolsOnly: !picker.toolsOnly })}
            title="Only models that can call tools, which the agent needs to edit files and run commands"
          >
            Can use tools
          </button>
          <div className="spacer" />
          <label className="muted small" htmlFor="model-sort">
            Sort
          </label>
          <select id="model-sort" value={picker.sort} onChange={(e) => savePicker({ sort: e.target.value as Sort })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="picker-cols muted small" aria-hidden>
          <span>Model</span>
          <span>Context</span>
          <span>$ per M tokens</span>
        </div>
        <div className="picker-list" ref={list} id="model-list" role="listbox" aria-label="Models">
          {rows.map((r, i) => {
            if ('header' in r) {
              const id = r.providerId
              return (
                <div key={`h${i}`} className="picker-group" role="presentation">
                  <span>{r.header}</span>
                  {id && (
                    <>
                      {r.total ? <span className="muted small">{r.shown === r.total ? r.total : `${r.shown} of ${r.total}`}</span> : null}
                      {!app.ready[id] && <span className="warn small">needs an API key</span>}
                      {loading[id] && <span className="muted small">loading…</span>}
                      {errors[id] && <span className="warn small">{errors[id]}</span>}
                      <button className="link small" onClick={() => load(id, true)}>
                        Refresh
                      </button>
                    </>
                  )}
                </div>
              )
            }
            const m = r.model
            idx++
            const my = idx
            const isFav = favSet.has(key(refOf(m)))
            const isCur = current && current.providerId === m.providerId && current.modelId === m.id
            return (
              <div
                key={`${r.section}:${m.providerId}:${m.id}`}
                id={optionId(my)}
                role="option"
                aria-selected={my === sel}
                className={`picker-row ${my === sel ? 'sel' : ''} ${isCur ? 'cur' : ''}`}
                onMouseEnter={() => setSel(my)}
                onClick={() => choose(m)}
              >
                <button
                  className={`star ${isFav ? 'on' : ''}`}
                  aria-pressed={isFav}
                  aria-label={`${isFav ? 'Remove' : 'Add'} ${displayName(m)} ${isFav ? 'from' : 'to'} favorites`}
                  tabIndex={-1}
                  onClick={(e) => (e.stopPropagation(), toggleFav(m))}
                >
                  ★
                </button>
                <span className="picker-name" title={m.id}>
                  {displayName(m)}
                  <span className="muted picker-id"> {m.id}</span>
                  {r.section !== 'all' && <span className="badge">{m.providerId}</span>}
                </span>
                <span className="muted">{m.contextLength ? tokens(m.contextLength) : '—'}</span>
                <span className={m.free ? 'okc' : 'muted'}>{price(m)}</span>
              </div>
            )
          })}
          {noMatches && (
            <div className="picker-empty">
              <p>No models match "{q.trim()}".</p>
              <div className="inline">
                <button className="btn" onClick={() => (setQ(''), input.current?.focus())}>
                  Clear search
                </button>
                {(picker.freeOnly || picker.toolsOnly) && (
                  <button className="btn" onClick={() => savePicker({ freeOnly: false, toolsOnly: false })}>
                    Show all models
                  </button>
                )}
              </div>
            </div>
          )}
          {!noMatches && picker.freeOnly && !q && (
            <div className="picker-hint muted small">
              Showing free models.{' '}
              <button className="link small" onClick={() => savePicker({ freeOnly: false })}>
                Show paid models too
              </button>
            </div>
          )}
        </div>
        <div className="picker-foot muted small">
          <span>
            <kbd>↑↓</kbd> move · <kbd>↵</kbd> select · <kbd>{app.platform === 'darwin' ? '⌘D' : 'Ctrl+D'}</kbd> favorite · <kbd>Esc</kbd> close
          </span>
          {picker.freeOnly && <span>Free models are rate-limited by the provider.</span>}
        </div>
      </div>
    </div>
  )
}
