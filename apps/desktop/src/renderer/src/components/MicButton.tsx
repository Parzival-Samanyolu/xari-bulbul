import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../../shared/ipc'
import { api } from '../lib/api'
import { recordingToWav } from '../lib/wav'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** Opus in WebM is what Chromium records; the fallbacks are for other engines. */
function recorderType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t
  return ''
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

interface Props {
  app: AppState
  /** Called with the transcribed text, to insert at the cursor. */
  onText: (text: string) => void
  onError: (e: unknown) => void
}

/** Records from the microphone on the first click and transcribes on the second. Hidden when no engine is set up. */
export function MicButton({ app, onText, onError }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean } | null>(null)

  // Release the microphone if the composer goes away mid-recording.
  useEffect(
    () => () => {
      const r = rec.current
      if (!r) return
      r.cancelled = true
      if (r.recorder.state !== 'inactive') r.recorder.stop()
      r.stream.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  useEffect(() => {
    if (phase !== 'recording') return
    setSeconds(0)
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  // The longest recording (Settings › Voice) ends it and transcribes what was said.
  const limit = app.settings.voice.maxRecordingSec
  useEffect(() => {
    if (phase === 'recording' && seconds >= limit && rec.current && rec.current.recorder.state !== 'inactive') rec.current.recorder.stop()
  }, [phase, seconds, limit])

  const engine = app.voice.engine
  // Turned off in Settings mid-recording: drop the recording.
  useEffect(() => {
    if (engine || !rec.current) return
    rec.current.cancelled = true
    rec.current.recorder.stop()
  }, [engine])

  if (!engine) return null

  const finish = async (blob: Blob) => {
    setPhase('transcribing')
    try {
      // whisper.cpp reads 16 kHz WAV; providers take the recording as it is.
      const local = engine === 'local'
      const bytes = local ? await recordingToWav(blob) : new Uint8Array(await blob.arrayBuffer())
      const text = await api.voice.transcribe(bytes, local ? 'audio/wav' : blob.type || 'audio/webm')
      if (text) onText(text)
    } catch (e) {
      onError(e)
    } finally {
      setPhase('idle')
    }
  }

  const start = async () => {
    setPhase('starting')
    try {
      if (!(await api.voice.prepare())) throw new Error('Microphone access was not allowed.')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = recorderType()
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      const r = { recorder, stream, chunks: [] as Blob[], cancelled: false }
      recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data)
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        rec.current = null
        if (r.cancelled) return setPhase('idle')
        void finish(new Blob(r.chunks, { type: recorder.mimeType || type || 'audio/webm' }))
      }
      rec.current = r
      recorder.start()
      // Reset with the phase change, so the length limit never sees the last recording's time.
      setSeconds(0)
      setPhase('recording')
    } catch (e) {
      setPhase('idle')
      const name = (e as DOMException)?.name
      onError(name === 'NotAllowedError' ? new Error('Microphone access was not allowed.') : name === 'NotFoundError' ? new Error('No microphone found.') : e)
    }
  }

  const stop = (cancel = false) => {
    const r = rec.current
    if (!r) return
    r.cancelled = cancel
    r.recorder.stop()
  }

  const recording = phase === 'recording'
  const busy = phase === 'starting' || phase === 'transcribing'
  const label = recording ? 'Stop recording and transcribe' : phase === 'transcribing' ? 'Transcribing…' : 'Dictate a message'
  return (
    <>
      <button
        className={`icon-btn attach mic ${recording ? 'recording' : ''}`}
        aria-pressed={recording}
        aria-busy={busy}
        aria-label={label}
        title={recording ? 'Stop recording (Esc cancels)' : `Dictate a message (${engine === 'provider' ? 'sent to your transcription provider' : 'transcribed on this computer'})`}
        disabled={busy}
        onClick={() => (recording ? stop() : start())}
        onKeyDown={(e) => recording && e.key === 'Escape' && (e.preventDefault(), stop(true))}
      >
        {phase === 'transcribing' ? (
          <span className="spinner" aria-hidden />
        ) : (
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
            <rect x="5.5" y="1.75" width="5" height="8.5" rx="2.5" fill={recording ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" />
            <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {/* The clock is visual only, so screen readers hear "Recording" once rather than every second. */}
      <span className="mic-status small" role="status">
        {recording && <span className="rec-dot" aria-hidden />}
        {recording ? 'Recording' : phase === 'transcribing' ? 'Transcribing…' : ''}
        {recording && <span aria-hidden> {clock(seconds)}</span>}
      </span>
    </>
  )
}
