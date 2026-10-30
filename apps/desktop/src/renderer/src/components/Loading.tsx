import { useEffect, useState } from 'react'
import mark from '../assets/mark.png'

/** How long startup may take before the loading screen shows, so a quick start never flashes it. */
const DELAY_MS = 150

/** Full-window screen from window show until the first state arrives, or the startup error with Retry. */
export function Loading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(true), DELAY_MS)
    return () => clearTimeout(t)
  }, [])

  if (error)
    return (
      <div className="loading" role="alert">
        <img className="loading-mark" src={mark} alt="" width={40} height={40} />
        <p className="loading-error-title">Xarı Bülbül couldn't start.</p>
        <p className="loading-error muted">{error}</p>
        <button className="btn primary" onClick={onRetry} autoFocus>
          Retry
        </button>
      </div>
    )
  return (
    <div className={`loading ${shown ? 'shown' : ''}`} role="status" aria-live="polite">
      {shown && (
        <>
          <img className="loading-mark" src={mark} alt="" width={40} height={40} />
          <span className="loading-label">Waking up</span>
        </>
      )}
    </div>
  )
}
