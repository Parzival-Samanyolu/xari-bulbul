import type { ModelRef } from '../../../../../shared/ipc'
import { useT } from '../../../lib/i18n'
import { ProviderLogo } from '../../ProviderLogo'

/** A list of models with a Remove link each. */
export function ListOfModels({ refs, onRemove }: { refs: ModelRef[]; onRemove: (r: ModelRef) => void }) {
  const { t } = useT()
  if (!refs.length) return <p className="muted small">{t('settings.parts.noneYet')}</p>
  return (
    <div className="list-field">
      {refs.map((f) => (
        <div key={`${f.providerId}:${f.modelId}`} className="list-item">
          <code>{f.modelId}</code>
          <span className="muted small">
            <ProviderLogo id={f.providerId} size={12} /> {f.providerId}
          </span>
          <button className="link danger small" aria-label={t('settings.parts.removeModel', { model: f.modelId })} onClick={() => onRemove(f)}>
            {t('common.remove')}
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
  const { t } = useT()
  if (!refs.length) return <p className="muted small">{t('settings.parts.noneYet')}</p>
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
            {!ready[f.providerId] && ` · ${t('settings.parts.notConnected')}`}
          </span>
          <span className="spacer" />
          <button className="link small" disabled={i === 0} aria-label={t('settings.parts.moveUpLabel', { model: f.modelId })} onClick={() => move(i, -1)}>
            {t('settings.parts.up')}
          </button>
          <button className="link small" disabled={i === refs.length - 1} aria-label={t('settings.parts.moveDownLabel', { model: f.modelId })} onClick={() => move(i, 1)}>
            {t('settings.parts.down')}
          </button>
          <button className="link danger small" aria-label={t('settings.parts.removeModel', { model: f.modelId })} onClick={() => onChange(refs.filter((_, j) => j !== i))}>
            {t('common.remove')}
          </button>
        </li>
      ))}
    </ol>
  )
}
