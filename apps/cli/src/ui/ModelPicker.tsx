import { Box, Text, useInput } from 'ink'
import { useEffect, useMemo, useState } from 'react'
import { displayName, MODEL_SORTS, pickerSections, priceLabel, refKey, refOf, type ModelInfo, type ModelRef, type ModelSort } from '@harness/core'
import { useTheme } from '../theme/palette.js'
import { tokens as fmtTokens } from './format.js'
import { Popup, selectable, type PopupRow } from './Popup.js'

export interface ModelPickerProps {
  providers: { id: string; name: string; ready: boolean }[]
  load: (providerId: string, refresh: boolean) => Promise<ModelInfo[]>
  current?: ModelRef
  favorites: ModelRef[]
  recent: ModelRef[]
  picker: { freeOnly: boolean; toolsOnly: boolean; sort: ModelSort }
  width: number
  onChoose: (ref: ModelRef) => void
  onClose: () => void
  onToggleFavorite: (ref: ModelRef) => void
  onPickerChange: (patch: Partial<{ freeOnly: boolean; toolsOnly: boolean; sort: ModelSort }>) => void
}

function ctx(n?: number) {
  return n ? `${fmtTokens(n)} ctx` : ''
}

/**
 * Opens on free models (favorites, current and recents first), sortable, with one key for the
 * full catalog. Type to filter.
 */
export function ModelPicker(p: ModelPickerProps) {
  const t = useTheme()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})
  const [status, setStatus] = useState<Record<string, string>>({})
  const [picker, setPicker] = useState(p.picker)
  const [favs, setFavs] = useState(p.favorites)

  const load = (id: string, refresh = false) => {
    setStatus((s) => ({ ...s, [id]: 'loading…' }))
    p.load(id, refresh).then(
      (ms) => {
        setModels((all) => ({ ...all, [id]: ms }))
        setStatus((s) => ({ ...s, [id]: '' }))
      },
      (e) => setStatus((s) => ({ ...s, [id]: String((e as Error).message ?? e) })),
    )
  }

  useEffect(() => {
    for (const pr of p.providers) if (pr.ready) load(pr.id)
  }, [])

  const sections = useMemo(
    () =>
      pickerSections({
        models,
        providers: p.providers,
        current: p.current,
        favorites: favs,
        recent: p.recent,
        query,
        filters: picker,
        sort: picker.sort,
      }),
    [models, query, picker, favs],
  )

  const favSet = new Set(favs.map(refKey))
  const rows: PopupRow[] = []
  for (const s of sections) {
    const pr = p.providers.find((x) => x.id === s.providerId)
    let detail = ''
    if (s.kind === 'provider') {
      if (pr && !pr.ready) detail = `needs a key: /login ${pr.id}`
      else if (status[s.providerId!]) detail = status[s.providerId!]
      else detail = `${s.models.length} of ${s.total ?? 0}${picker.freeOnly ? ' · free only' : ''}`
      if (!s.models.length && query && !detail.startsWith('needs')) continue
    }
    rows.push({ key: `${s.kind}:${s.providerId ?? s.title}`, label: s.title, detail, header: true })
    for (const m of s.models) {
      rows.push({
        key: `${s.kind}|${refKey(refOf(m))}`,
        label: `${favSet.has(refKey(refOf(m))) ? '★ ' : ''}${displayName(m)}`,
        detail: [m.id, ctx(m.contextLength), m.supportsTools ? '' : 'no tools'].filter(Boolean).join(' · '),
        note: priceLabel(m),
      })
    }
  }
  const items = selectable(rows)
  const selIdx = Math.min(sel, Math.max(0, items.length - 1))
  const selected = items[selIdx]
  const selectedRef = (): ModelRef | null => {
    if (!selected) return null
    const k = selected.key.slice(selected.key.indexOf('|') + 1)
    const i = k.indexOf(':')
    return { providerId: k.slice(0, i), modelId: k.slice(i + 1) }
  }

  useInput((input, key) => {
    if (key.escape) return p.onClose()
    if (key.upArrow) return setSel(Math.max(0, selIdx - 1))
    if (key.downArrow) return setSel(Math.min(items.length - 1, selIdx + 1))
    if (key.pageDown) return setSel(Math.min(items.length - 1, selIdx + 8))
    if (key.pageUp) return setSel(Math.max(0, selIdx - 8))
    if (key.return) {
      const r = selectedRef()
      if (r) p.onChoose(r)
      return
    }
    if (key.tab) {
      const sort = MODEL_SORTS[(MODEL_SORTS.indexOf(picker.sort) + 1) % MODEL_SORTS.length]
      setPicker({ ...picker, sort })
      p.onPickerChange({ sort })
      return
    }
    if (key.ctrl && input === 'a') {
      const freeOnly = !picker.freeOnly
      setPicker({ ...picker, freeOnly })
      p.onPickerChange({ freeOnly })
      setSel(0)
      return
    }
    if (key.ctrl && input === 't') {
      const toolsOnly = !picker.toolsOnly
      setPicker({ ...picker, toolsOnly })
      p.onPickerChange({ toolsOnly })
      return
    }
    if (key.ctrl && input === 'f') {
      const r = selectedRef()
      if (!r) return
      p.onToggleFavorite(r)
      setFavs((f) => (f.some((x) => refKey(x) === refKey(r)) ? f.filter((x) => refKey(x) !== refKey(r)) : [...f, r]))
      return
    }
    if (key.ctrl && input === 'r') {
      for (const pr of p.providers) if (pr.ready) load(pr.id, true)
      return
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setSel(0)
      return
    }
    if (input && !key.ctrl && !key.meta && input >= ' ') {
      setQuery((q) => q + input)
      setSel(0)
    }
  })

  return (
    <Box flexDirection="column">
      <Popup
        title="Switch model"
        rows={rows}
        selected={selIdx}
        width={p.width}
        maxRows={12}
        empty={query ? `No models match "${query}".` : 'No providers ready. Add a key with /login.'}
      />
      <Box paddingX={1} flexDirection="column">
        <Text>
          <Text color={t.accent}>filter </Text>
          <Text>{query}</Text>
          <Text inverse> </Text>
        </Text>
        <Text color={t.muted}>
          ⏎ choose · tab sort: {picker.sort} · ^A {picker.freeOnly ? 'show all models' : 'free only'} · ^F favorite · ^T {picker.toolsOnly ? 'any model' : 'tools only'} · esc close
        </Text>
      </Box>
    </Box>
  )
}
