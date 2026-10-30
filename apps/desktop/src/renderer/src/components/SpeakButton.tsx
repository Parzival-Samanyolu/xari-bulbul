import { useSyncExternalStore } from 'react'
import { speaker } from '../lib/speech'

/** Play/stop for reading one assistant message aloud. */
export function SpeakButton({ id, text }: { id: string; text: string }) {
  const playing = useSyncExternalStore(speaker.subscribe, () => speaker.playing === id)
  return (
    <button
      type="button"
      className={`speak-btn${playing ? ' on' : ''}`}
      aria-label={playing ? 'Stop reading aloud' : 'Read aloud'}
      title={playing ? 'Stop reading aloud (Esc)' : 'Read aloud'}
      onClick={() => speaker.toggle(id, text)}
    >
      {playing ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2.5 6v4h2.5l3.5 3V3L5 6z" fill="currentColor" stroke="none" />
          <path d="M10.8 5.6a3.4 3.4 0 0 1 0 4.8M12.6 3.8a6 6 0 0 1 0 8.4" />
        </svg>
      )}
    </button>
  )
}
