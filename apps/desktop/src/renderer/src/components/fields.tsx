import { useEffect, useId, useState, type ReactNode } from 'react'

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="s-section">
      <h3>{title}</h3>
      {description && <p className="muted small">{description}</p>}
      <div className="s-rows">{children}</div>
    </section>
  )
}

/**
 * A labelled settings row. `labelFor` links the label to a single input by id; otherwise the
 * control area is a group named by the label, so screen readers announce what it's for.
 */
export function Row({ label, hint, children, wide, labelFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean; labelFor?: string }) {
  const id = useId()
  return (
    <div className={`s-row ${wide ? 'wide' : ''}`}>
      <div className="s-label">
        {labelFor ? <label htmlFor={labelFor}>{label}</label> : <div id={`${id}-l`}>{label}</div>}
        {hint && (
          <div className="muted small" id={`${id}-h`}>
            {hint}
          </div>
        )}
      </div>
      <div className="s-control" {...(labelFor ? {} : { role: 'group', 'aria-labelledby': `${id}-l`, 'aria-describedby': hint ? `${id}-h` : undefined })}>
        {children}
      </div>
    </div>
  )
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={value} aria-label={label} className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}>
      <span />
    </button>
  )
}

export function Select<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** Number input that commits on blur/Enter; empty = null when `nullable`. */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  nullable,
  placeholder,
  suffix,
  label,
}: {
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  nullable?: boolean
  placeholder?: string
  suffix?: string
  label?: string
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => setText(value == null ? '' : String(value)), [value])
  const commit = () => {
    if (text.trim() === '') {
      if (nullable) onChange(null)
      else setText(String(value ?? ''))
      return
    }
    let n = Number(text)
    if (!Number.isFinite(n)) return setText(value == null ? '' : String(value))
    if (min != null) n = Math.max(min, n)
    if (max != null) n = Math.min(max, n)
    setText(String(n))
    if (n !== value) onChange(n)
  }
  return (
    <span className="num">
      <input
        type="number"
        aria-label={label}
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  )
}

/** Text that commits on blur (avoids saving on every keystroke). */
export function TextField({ value, onChange, placeholder, multiline, rows, mono, id, label }: { value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; rows?: number; mono?: boolean; id?: string; label?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => text !== value && onChange(text)
  return multiline ? (
    <textarea id={id} aria-label={label} className={mono ? 'mono' : ''} rows={rows ?? 5} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} />
  ) : (
    <input id={id} aria-label={label} className={mono ? 'mono' : ''} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
  )
}

/** Editable list of strings (rules, file names). */
export function ListField({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label?: string }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v && !value.includes(v)) onChange([...value, v])
    setDraft('')
  }
  return (
    <div className="list-field">
      {value.map((v) => (
        <div key={v} className="list-item">
          <code>{v}</code>
          <button className="link danger small" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
            Remove
          </button>
        </div>
      ))}
      <div className="list-add">
        <input className="mono" aria-label={label ? `Add to ${label}` : undefined} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
    </div>
  )
}

export function Slider({ value, onChange, min, max, step, format, label }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; format?: (v: number) => string; label?: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <span className="slider">
      <input type="range" aria-label={label} aria-valuetext={format ? format(v) : undefined} min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onPointerUp={() => v !== value && onChange(v)} onKeyUp={() => v !== value && onChange(v)} />
      <span className="mono small">{format ? format(v) : v}</span>
    </span>
  )
}
