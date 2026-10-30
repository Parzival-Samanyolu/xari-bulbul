import { useEffect, useState, useSyncExternalStore } from 'react'
import { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES, TTS_SAMPLE, type TtsVoice } from '@harness/core/speech'
import { speaker, systemVoices } from '../../../lib/speech'
import { Row, Section, Select, Slider, Toggle } from '../../fields'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Text to speech

const TTS_OPTIONS = [
  { value: 'system' as const, label: 'System voice (this computer)' },
  { value: 'openai' as const, label: 'OpenAI or a compatible provider' },
  { value: 'off' as const, label: 'Off' },
]

const TTS_HINT = {
  system: 'Uses the voices installed on this computer. Works offline.',
  openai: 'Sends the reply text to the provider below, billed to its key.',
  off: 'No read-aloud button on replies.',
} as const

const TEST_ID = 'settings-test'

export function TextToSpeechPage({ app, save, go }: PageProps) {
  const t = app.settings.voice.tts
  const [systemList, setSystemList] = useState<TtsVoice[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const testing = useSyncExternalStore(speaker.subscribe, () => speaker.playing === TEST_ID)

  useEffect(() => {
    if (t.provider !== 'system') return
    let live = true
    systemVoices().then((v) => live && setSystemList(v.map((x) => ({ id: x.voiceURI, label: `${x.name} (${x.lang})`, locale: x.lang }))))
    return () => {
      live = false
    }
  }, [t.provider])
  const voices: TtsVoice[] | null = t.provider === 'openai' ? OPENAI_TTS_VOICES.map((v) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) })) : systemList

  const speechProviders = app.settings.providers.filter((p) => p.api === 'openai' && p.enabled)
  const chosen = speechProviders.find((p) => p.id === t.openai.providerId)
  const list = voices ?? []
  const voiceOptions = [
    { value: '', label: voices === null ? 'Loading voices…' : 'Default' },
    // A saved voice stays selectable while the list loads or after it's no longer offered.
    ...(t.voice && !list.some((v) => v.id === t.voice) ? [{ value: t.voice, label: t.voice }] : []),
    ...list.map((v) => ({ value: v.id, label: v.label })),
  ]
  const test = () => {
    setProblem(null)
    if (testing) speaker.stop()
    else void speaker.speak(TEST_ID, TTS_SAMPLE, { notice: (_level, text) => setProblem(text) })
  }

  return (
    <>
      <Section>
        <Row label="Provider" hint={TTS_HINT[t.provider]}>
          <Select label="Provider" value={t.provider} options={TTS_OPTIONS} onChange={(x) => save((s) => ((s.voice.tts.provider = x), (s.voice.tts.voice = null), s))} />
        </Row>
        {t.provider !== 'off' && (
          <>
            <Row label="Voice" hint={t.provider === 'system' ? 'Default follows your system setting.' : undefined}>
              <Select label="Voice" value={t.voice ?? ''} options={voiceOptions} onChange={(x) => save((s) => ((s.voice.tts.voice = x || null), s))} />
            </Row>
            <Row label="Speed">
              <Slider label="Speed" value={t.rate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(x) => save((s) => ((s.voice.tts.rate = x), s))} />
            </Row>
            <Row label="Read responses aloud" hint="Reads each finished reply in the chat on screen. Typing, sending or Esc stops it.">
              <Toggle label="Read responses aloud" value={t.readAloud} onChange={(x) => save((s) => ((s.voice.tts.readAloud = x), s))} />
            </Row>
          </>
        )}
      </Section>
      {t.provider === 'openai' && (
        <Section title="Provider for speech">
          <Row
            label="Speech provider"
            hint={
              chosen && !app.ready[chosen.id] ? (
                <>
                  {chosen.name} has no key yet.{' '}
                  <button className="link small" onClick={() => go('providers.keys')}>
                    Add a key
                  </button>
                </>
              ) : (
                'Uses its /audio/speech endpoint.'
              )
            }
          >
            <Select
              label="Speech provider"
              value={t.openai.providerId}
              options={[
                ...(chosen ? [] : [{ value: t.openai.providerId, label: `${t.openai.providerId} (not set up)` }]),
                ...speechProviders.map((p) => ({ value: p.id, label: app.ready[p.id] ? p.name : `${p.name} (no key)` })),
              ]}
              onChange={(x) => save((s) => ((s.voice.tts.openai.providerId = x), s))}
            />
          </Row>
          <Row label="Speech model" hint="gpt-4o-mini-tts sounds more natural; tts-1 answers faster.">
            <Select label="Speech model" value={t.openai.model} options={OPENAI_TTS_MODELS.map((m) => ({ value: m, label: m }))} onChange={(x) => save((s) => ((s.voice.tts.openai.model = x), s))} />
          </Row>
        </Section>
      )}
      {t.provider !== 'off' && (
        <Section>
          <Row label="Test" hint={problem ?? `Says: “${TTS_SAMPLE}”`}>
            <button className="btn" onClick={test} aria-pressed={testing}>
              {testing ? 'Stop' : 'Say a sample sentence'}
            </button>
          </Row>
        </Section>
      )}
    </>
  )
}
