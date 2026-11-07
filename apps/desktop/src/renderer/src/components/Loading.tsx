import { useEffect, useState } from 'react'
import mark from '../assets/mark.png'
import { useT } from '../lib/i18n'

/** How long startup may take before the loading screen shows, so a quick start never flashes it. */
const DELAY_MS = 150

/** Full-window screen from window show until the first state arrives, or the startup error with Retry. */
export function Loading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useT()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  if (error)
    return (
      <div className="loading" role="alert">
        <img className="loading-mark" src={mark} alt="" width={40} height={40} />
        <p className="loading-error-title">{t('chat.loading.failed')}</p>
        <p className="loading-error muted">{error}</p>
        <button className="btn primary" onClick={onRetry} autoFocus>
          {t('common.retry')}
        </button>
      </div>
    )
  return (
    <div className={`loading ${shown ? 'shown' : ''}`} role="status" aria-live="polite">
      {shown && (
        <>
          <img className="loading-mark" src={mark} alt="" width={40} height={40} />
          <span className="loading-label">{t('chat.loading.waking')}</span>

        </>
      )}
    </div>
  )
}
