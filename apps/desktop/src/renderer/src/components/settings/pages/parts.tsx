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
