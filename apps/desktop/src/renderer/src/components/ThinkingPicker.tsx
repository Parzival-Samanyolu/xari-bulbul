import { useEffect, useRef, useState } from 'react'
import { EFFORT_LABELS, EFFORT_LEVELS, batchMode, fastMode, refKey, type ReasoningEffort } from '@harness/core/catalog'
import type { AppState, ModelRef, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'

interface Props {
  app: AppState
  model: ModelRef
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}

/** Thinking level and fast mode for the model on screen, saved as that model's override. */
export function ThinkingPicker({ app, model, onState, onError }: Props) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const key = refKey(model)
  const o = app.settings.models.overrides[key] ?? {}
  const effort = o.reasoningEffort ?? app.settings.models.reasoningEffort ?? null
  const provider = app.settings.providers.find((p) => p.id === model.providerId)
  const none = { supported: false, hint: '' }
  const fast = provider ? fastMode(provider, model.modelId) : none
  const batch = provider ? batchMode(provider) : none
  const planBatch = batch.supported && app.mode === 'plan' && app.settings.agent.batchInPlanMode
  // What the next request uses: Plan mode's batch setting wins over the model's own speed.
  const speed = planBatch ? 'batch' : o.speed === 'fast' && fast.supported ? 'fast' : o.speed === 'batch' && batch.supported ? 'batch' : 'standard'
  const speeds = [
    { id: 'standard' as const, label: 'Standard', hint: 'Normal speed and price', show: true },
    { id: 'fast' as const, label: 'Fast', hint: fast.hint, show: fast.supported },
    { id: 'batch' as const, label: 'Batch', hint: batch.hint, show: batch.supported },
  ].filter((x) => x.show)

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    pop.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const saveBatchInPlan = (on: boolean) => {
    const s = structuredClone(app.settings)
    s.agent.batchInPlanMode = on
    api.settings.set(s).then(onState, onError)
  }

  const save = (fn: (o: NonNullable<Settings['models']['overrides'][string]>) => void) => {
    const s = structuredClone(app.settings)
    const next = { ...(s.models.overrides[key] ?? {}) }
    fn(next)
    // Drop unset fields, and the whole override once nothing is left.
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k]
    if (Object.keys(next).length) s.models.overrides[key] = next
    else delete s.models.overrides[key]
    api.settings.set(s).then(onState, onError)
  }

  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close())
    else if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus())
    else if (e.key === 'Tab') close(false)
  }

  const levels: (ReasoningEffort | null)[] = [null, ...EFFORT_LEVELS]
  const label = effort ? EFFORT_LABELS[effort] : 'Default'

  return (
    <div className="thinking">
      <button
        ref={trigger}
        className={`chip ${speed !== 'standard' ? 'fast' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Thinking level and speed for this model"
        onClick={() => setOpen((v) => !v)}
      >
        Thinking: {label}
        {speed !== 'standard' && <span className="fast-tag">· {speed === 'fast' ? 'Fast' : 'Batch'}</span>}
      </button>
      {open && (
        <div className="thinking-pop" ref={pop} role="dialog" aria-label="Thinking and speed" onKeyDown={onKey}>
          <div className="menu-label">Thinking</div>
          <div role="radiogroup" aria-label="Thinking level">
            {levels.map((l) => {
              const on = (o.reasoningEffort ?? null) === l
              return (
                <button
                  key={l ?? 'default'}
                  role="radio"
                  aria-checked={on}
                  className={on ? 'on' : ''}
                  onClick={() => save((x) => (x.reasoningEffort = l ?? undefined))}
                >
                  <span className="check" aria-hidden>{on ? '✓' : ''}</span>
                  {l ? EFFORT_LABELS[l] : 'Default'}
                  {!l && <span className="muted small">{app.settings.models.reasoningEffort ? EFFORT_LABELS[app.settings.models.reasoningEffort] : 'provider default'}</span>}
                </button>
              )
            })}
          </div>
          {speeds.length > 1 && (
            <>
              <div className="menu-label">Speed</div>
              <div role="radiogroup" aria-label="Speed">
                {speeds.map((x) => {
                  const on = (o.speed ?? 'standard') === x.id
                  return (
                    <button key={x.id} role="radio" aria-checked={on} className={`speed-row ${on ? 'on' : ''}`} onClick={() => save((y) => (y.speed = x.id === 'standard' ? undefined : x.id))}>
                      <span className="check" aria-hidden>{on ? '✓' : ''}</span>
                      <span className="speed-text">
                        {x.label}
                        <span className="muted small">{x.hint}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
          {batch.supported && (
            <button role="switch" aria-checked={app.settings.agent.batchInPlanMode} className="speed-row" onClick={() => saveBatchInPlan(!app.settings.agent.batchInPlanMode)}>
              <span className={`toggle ${app.settings.agent.batchInPlanMode ? 'on' : ''}`} aria-hidden>
                <span />
              </span>
              <span className="speed-text">
                Batch while planning
                <span className="muted small">Plan mode uses batch, for any model on this provider</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
