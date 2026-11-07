import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { OPENAI_TTS_VOICES, TTS_SAMPLE } from '@harness/core/speech'
import type { AppState, Settings } from '../../../shared/ipc'
import { speaker, systemVoices, type BotVoice } from '../lib/speech'

type Bot = Settings['bots'][number]

const EMPTY: BotVoice = { system: null, openai: null, rate: null, pitch: 1, style: '' }
const PREVIEW_ID = 'bot-voice-preview'
const RATES = [0.8, 0.9, 1, 1.1, 1.2, 1.35]

/** The bot editor's Voice section: which stock voice reads its replies, how fast, and in what style. */
export function BotVoiceFields({ app, bot, onChange }: { app: AppState; bot: Bot; onChange: (voice: BotVoice | undefined) => void }) {
  const ids = useId()
  const tts = app.settings.voice.tts
  const v = { ...EMPTY, ...bot.voice }
  const [system, setSystem] = useState<{ id: string; label: string }[]>([])
  const [problem, setProblem] = useState('')
  const playing = useSyncExternalStore(speaker.subscribe, () => speaker.playing === PREVIEW_ID)
  useEffect(() => {
    let live = true
    systemVoices().then((list) => live && setSystem(list.map((x) => ({ id: x.voiceURI, label: `${x.name} (${x.lang})` }))))
    return () => {
      live = false
      if (speaker.playing === PREVIEW_ID) speaker.stop()
    }
  }, [])

  const set = (patch: Partial<BotVoice>) => {
    const next = { ...v, ...patch }
    const blank = !next.system && !next.openai && next.rate == null && next.pitch === 1 && !next.style.trim()
    onChange(blank ? undefined : next)
  }

  if (tts.provider === 'off') return <p className="muted small">Text to speech is off. Turn it on in Settings › Voice to give {bot.name || 'this bot'} a voice.</p>

  const openai = tts.provider === 'openai'
  const styled = openai && tts.openai.model === 'gpt-4o-mini-tts'
  const voices = openai ? OPENAI_TTS_VOICES.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })) : system
  const current = openai ? v.openai : v.system
  const preview = () => {
    setProblem('')
    if (playing) return speaker.stop()
    const line = bot.greeting?.trim() || TTS_SAMPLE
    void speaker.speak(PREVIEW_ID, line, { as: { voice: v, preview: true }, notice: (_l, text) => setProblem(text) })
  }

  return (
    <>
      <div className="bd-row">
        <label htmlFor={`${ids}-voice`}>Voice</label>
        <span className="inline">
          <select id={`${ids}-voice`} value={current ?? ''} onChange={(e) => set(openai ? { openai: e.target.value || null } : { system: e.target.value || null })}>
            <option value="">Same as Settings › Voice</option>
            {voices.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={preview} aria-pressed={playing}>
            {playing ? 'Stop' : 'Try it'}
          </button>
        </span>
      </div>
      <div className="bd-row">
        <label htmlFor={`${ids}-rate`}>Speed</label>
        <select id={`${ids}-rate`} value={v.rate == null ? '' : String(v.rate)} onChange={(e) => set({ rate: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Same as Settings › Voice</option>
          {RATES.map((r) => (
            <option key={r} value={String(r)}>
              {r}×
            </option>
          ))}
        </select>
      </div>
      {!openai && (
        <div className="bd-row">
          <label htmlFor={`${ids}-pitch`}>Pitch</label>
          <span className="inline">
            <input id={`${ids}-pitch`} type="range" min={0.5} max={1.5} step={0.05} value={v.pitch} onChange={(e) => set({ pitch: Number(e.target.value) })} />
            <span className="muted small">{v.pitch === 1 ? 'Normal' : v.pitch > 1 ? 'Higher' : 'Lower'}</span>
          </span>
        </div>
      )}
      {styled && (
        <div className="bd-field">
          <label htmlFor={`${ids}-style`}>How it speaks</label>
          <textarea
            id={`${ids}-style`}
            rows={2}
            maxLength={600}
            value={v.style}
            placeholder="Soft and warm, a little shy, giggles easily, casual and quick"
            aria-describedby={`${ids}-style-hint`}
            onChange={(e) => set({ style: e.target.value })}
          />
          <span className="muted small" id={`${ids}-style-hint`}>
            Tone, pace and mood for {tts.openai.model}. A stock voice in this style, not an imitation of a real person.
          </span>
        </div>
      )}
      {problem && (
        <p className="small warn" role="alert">
          {problem}
        </p>
      )}
    </>
  )
}
