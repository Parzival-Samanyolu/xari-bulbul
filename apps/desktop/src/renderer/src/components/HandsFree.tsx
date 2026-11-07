import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../../shared/ipc'
import { api } from '../lib/api'
import { Listener, MicNotOpenError } from '../lib/listen'
import { speaker, speakerFor } from '../lib/speech'
import { recordingToWav } from '../lib/wav'
import { useT } from '../lib/i18n'
import type { MessageKey } from '../../../shared/i18n/catalog'

type Phase = 'off' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking'

const PHASE_TEXT: Record<Exclude<Phase, 'off'>, MessageKey> = {
  listening: 'chat.handsfree.listening',
  hearing: 'chat.handsfree.listening',
  transcribing: 'chat.handsfree.gotIt',
  thinking: 'chat.handsfree.thinking',
  speaking: 'chat.handsfree.speaking',
}

/** Said on its own, ends hands-free mode instead of being sent (English, Azerbaijani, Turkish, Russian). */
const STOP_WORDS =
  /^(stop|stop listening|goodbye|bye|that's all|end hands[- ]?free|exit|dayan|dayandır|bəsdir|sağ ol|dur|durdur|yeter|hoşça kal|стоп|хватит|достаточно|пока|до свидания)[.!]?$/i

interface Props {
  app: AppState
  /** Sends a message in the chat on screen. */
  send: (text: string) => void
  onError: (e: unknown) => void
}

/**
 * Hands-free: talk, and the reply is read back in the bot's voice, then it listens again. One
 * click starts it; the button, Esc, or saying "stop" ends it. It doesn't listen while it speaks.
 */
export function HandsFree({ app, send, onError }: Props) {
  const { t } = useT()
  const [phase, setPhase] = useState<Phase>('off')
  const [level, setLevel] = useState(0)
  const run = useRef<{ ac: AbortController } | null>(null)
  const appRef = useRef(app)
  appRef.current = app
  const sendRef = useRef(send)
  sendRef.current = send

  const engine = app.voice.engine
  const tts = app.settings.voice.tts.provider
  const sessionId = app.session?.meta.id

  const stop = () => {
    run.current?.ac.abort()
    run.current = null
    speaker.handsFree = false
    speaker.stop()
    setPhase('off')
    setLevel(0)
  }

  // Leaving the chat, or the voice engine going away, ends it.
  useEffect(() => stop, [sessionId])
  useEffect(() => {
    if (!engine && run.current) stop()
  }, [engine])
  useEffect(() => {
    if (phase === 'off') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop()
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])

  if (!engine) return null

  /** Sends `text` and resolves with the reply once the turn ends (null when it didn't finish). */
  const ask = (text: string, signal: AbortSignal): Promise<{ id: string; text: string } | null> =>
    new Promise((resolve) => {
      const sid = appRef.current.session?.meta.id
      let last: { id: string; text: string } | null = null
      let started = false
      const off = api.onEvent((e) => {
        if (e.type !== 'agent' || e.sessionId !== sid) return
        const ev = e.event
        if (ev.type === 'turn_start') started = true
        else if (ev.type === 'message' && ev.message.role === 'assistant' && ev.message.content.trim()) last = { id: `${sid}:${ev.index}`, text: ev.message.content }
        else if (ev.type === 'turn_end' && started) {
          off()
          resolve(ev.reason === 'done' ? last : null)
        }
      })
      signal.addEventListener('abort', () => (off(), resolve(null)), { once: true })
      sendRef.current(text)
    })

  const start = async () => {
    const ac = new AbortController()
    run.current = { ac }
    speaker.handsFree = true
    const listener = new Listener()
    ac.signal.addEventListener('abort', () => listener.close(), { once: true })
    try {
      if (!(await api.voice.prepare())) throw new Error(t('chat.voice.notAllowed'))
      await listener.open()
      while (!ac.signal.aborted) {
        setPhase('listening')
        const blob = await listener.listen({
          signal: ac.signal,
          maxMs: appRef.current.settings.voice.maxRecordingSec * 1000,
          onLevel: setLevel,
          onSpeech: () => setPhase('hearing'),
        })
        setLevel(0)
        if (!blob || ac.signal.aborted) continue
        setPhase('transcribing')
        const local = appRef.current.voice.engine === 'local'
        const bytes = local ? await recordingToWav(blob) : new Uint8Array(await blob.arrayBuffer())
        const text = (await api.voice.transcribe(bytes, local ? 'audio/wav' : blob.type || 'audio/webm'))?.trim()
        if (ac.signal.aborted) break
        // Whisper hears breathing as "[BLANK_AUDIO]" or "(silence)"; skip those.
        if (!text || /^[[(].*[\])]$/.test(text)) continue
        if (STOP_WORDS.test(text)) break
        setPhase('thinking')
        const reply = await ask(text, ac.signal)
        if (ac.signal.aborted || !reply) continue
        if (appRef.current.settings.voice.tts.provider === 'off') continue
        setPhase('speaking')
        await speaker.speak(reply.id, reply.text, { as: speakerFor(appRef.current) })
      }
    } catch (e) {
      const name = (e as DOMException)?.name
      if (!ac.signal.aborted) onError(name === 'NotAllowedError' ? new Error(t('chat.voice.notAllowed')) : name === 'NotFoundError' ? new Error(t('chat.voice.noMic')) : e instanceof MicNotOpenError ? new Error(t('chat.voice.micNotOpen')) : e)
    } finally {
      listener.close()
      if (run.current?.ac === ac) stop()
    }
  }

  const on = phase !== 'off'
  const label = on ? t('chat.handsfree.stop') : t('chat.handsfree.start')
  return (
    <>
      <button
        className={`icon-btn attach handsfree ${on ? 'on' : ''} ${phase}`}
        aria-pressed={on}
        aria-label={label}
        title={on ? t('chat.handsfree.stopTitle') : tts === 'off' ? t('chat.handsfree.silentTitle') : t('chat.handsfree.startTitle')}
        onClick={() => (on ? stop() : void start())}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <rect x="2" y="9" width="3" height="4.5" rx="1.2" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" />
          <rect x="11" y="9" width="3" height="4.5" rx="1.2" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" />
        </svg>
        {on && <span className="handsfree-level" style={{ transform: `scaleY(${0.15 + level * 0.85})` }} aria-hidden />}
      </button>
      <span className="mic-status small" role="status">
        {phase !== 'off' && t(PHASE_TEXT[phase])}
      </span>
    </>
  )
}
