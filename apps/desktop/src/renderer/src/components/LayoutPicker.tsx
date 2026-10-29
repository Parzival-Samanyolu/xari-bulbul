import { useRef } from 'react'
import type { Settings } from '../../../shared/ipc'

export type Layout = Settings['appearance']['layout']

const LAYOUTS: { id: Layout; name: string; blurb: string }[] = [
  { id: 'basic', name: 'Basic', blurb: 'For chatting with the agent.' },
  { id: 'elite', name: 'Elite', blurb: 'For developers: terminal, files, diffs.' },
]

/** Settings with `layout` chosen: Elite opens the side and bottom panels, Basic closes them. */
export function withLayout(s: Settings, layout: Layout): Settings {
  const open = layout === 'elite'
  return {
    ...s,
    appearance: { ...s.appearance, layout },
    app: { ...s.app, layoutChosen: true, panels: { ...s.app.panels, rightOpen: open, bottomOpen: open } },
  }
}

/** Small drawing of a layout. Dashed parts are panels that start closed. */
function Wireframe({ layout }: { layout: Layout }) {
  const optional = layout === 'basic' ? ' optional' : ''
  return (
    <div className="wf" aria-hidden>
      <span className="wf-side" />
      <span className="wf-chat">
        <i />
        <i />
        <i />
      </span>
      <span className={`wf-right${optional}`} />
      <span className={`wf-bottom${optional}`} />
    </div>
  )
}

/** The two layouts as a radio group: arrow keys move the choice, Tab leaves the group. */
export function LayoutPicker({ value, onChange }: { value: Layout; onChange: (l: Layout) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const j = (i + step + LAYOUTS.length) % LAYOUTS.length
    onChange(LAYOUTS[j].id)
    refs.current[j]?.focus()
  }
  return (
    <div className="layout-tiles" role="radiogroup" aria-label="Layout">
      {LAYOUTS.map((l, i) => {
        const on = l.id === value
        return (
          <button
            key={l.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`layout-tile ${on ? 'on' : ''}`}
            onClick={() => onChange(l.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <Wireframe layout={l.id} />
            <span className="layout-name">{l.name}</span>
            <span className="layout-blurb">{l.blurb}</span>
          </button>
        )
      })}
    </div>
  )
}
