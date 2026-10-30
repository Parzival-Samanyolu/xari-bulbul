import type { ModelRef } from '../../../../../shared/ipc'
import { ProviderLogo } from '../../ProviderLogo'

/** A list of models with a Remove link each. */
export function ListOfModels({ refs, onRemove }: { refs: ModelRef[]; onRemove: (r: ModelRef) => void }) {
  if (!refs.length) return <p className="muted small">None yet.</p>
  return (
    <div className="list-field">
      {refs.map((f) => (
        <div key={`${f.providerId}:${f.modelId}`} className="list-item">
          <code>{f.modelId}</code>
          <span className="muted small">
            <ProviderLogo id={f.providerId} size={12} /> {f.providerId}
          </span>
          <button className="link danger small" aria-label={`Remove ${f.modelId}`} onClick={() => onRemove(f)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  )
}

/** Connected (filled) or not (hollow), with the state also in words for screen readers. */
export function StatusDot({ on, label }: { on: boolean; label: string }) {
  return <span className={`status-dot ${on ? 'on' : ''}`} role="img" aria-label={label} title={label} />
}

/** An ordered list of models: numbered, with move up/down and remove. Unconnected providers are flagged. */
export function OrderedModels({ refs, ready, onChange }: { refs: ModelRef[]; ready: Record<string, boolean>; onChange: (refs: ModelRef[]) => void }) {
  if (!refs.length) return <p className="muted small">None yet.</p>
  const move = (i: number, by: number) => {
    const next = [...refs]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    onChange(next)
  }
  return (
    <ol className="list-field ordered">
      {refs.map((f, i) => (
        <li key={`${f.providerId}:${f.modelId}`} className="list-item">
          <span className="muted small order-num">{i + 1}</span>
          <code>{f.modelId}</code>
          <span className="muted small">
            <ProviderLogo id={f.providerId} size={12} /> {f.providerId}
            {!ready[f.providerId] && ' · not connected, skipped'}
          </span>
          <span className="spacer" />
          <button className="link small" disabled={i === 0} aria-label={`Move ${f.modelId} up`} onClick={() => move(i, -1)}>
            Up
          </button>
          <button className="link small" disabled={i === refs.length - 1} aria-label={`Move ${f.modelId} down`} onClick={() => move(i, 1)}>
            Down
          </button>
          <button className="link danger small" aria-label={`Remove ${f.modelId}`} onClick={() => onChange(refs.filter((_, j) => j !== i))}>
            Remove
          </button>
        </li>
      ))}
    </ol>
  )
}
