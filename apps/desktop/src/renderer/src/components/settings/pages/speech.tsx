import { useEffect, useState, useSyncExternalStore } from 'react'
import { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES, type TtsVoice } from '@harness/core/speech'
import type { MessageKey } from '../../../../../shared/i18n/catalog'
import { useT } from '../../../lib/i18n'
import { speaker, systemVoices } from '../../../lib/speech'
import { Row, Section, Select, Slider, Toggle } from '../../fields'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Text to speech

const TTS_HINT: Record<'system' | 'openai' | 'off', MessageKey> = {
  system: 'settings.tts.hintSystem',
  openai: 'settings.tts.hintOpenai',
  off: 'settings.tts.hintOff',
}

const TEST_ID = 'settings-test'

export function TextToSpeechPage({ app, save, go }: PageProps) {
  const { t } = useT()
  const tts = app.settings.voice.tts
  const [systemList, setSystemList] = useState<TtsVoice[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const testing = useSyncExternalStore(speaker.subscribe, () => speaker.playing === TEST_ID)
  const sample = t('settings.tts.sample')

  useEffect(() => {
    if (tts.provider !== 'system') return
    let live = true
    systemVoices().then((v) => live && setSystemList(v.map((x) => ({ id: x.voiceURI, label: `${x.name} (${x.lang})`, locale: x.lang }))))
    return () => {
      live = false
    }
  }, [tts.provider])
  const voices: TtsVoice[] | null = tts.provider === 'openai' ? OPENAI_TTS_VOICES.map((v) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) })) : systemList

  const speechProviders = app.settings.providers.filter((p) => p.api === 'openai' && p.enabled)
  const chosen = speechProviders.find((p) => p.id === tts.openai.providerId)
  const list = voices ?? []
  const providerOptions = [
    { value: 'system' as const, label: t('settings.tts.optSystem') },
    { value: 'openai' as const, label: t('settings.tts.optOpenai') },
    { value: 'off' as const, label: t('common.off') },
  ]
  const voiceOptions = [
    { value: '', label: voices === null ? t('settings.tts.loadingVoices') : t('common.default') },
    // A saved voice stays selectable while the list loads or after it's no longer offered.
    ...(tts.voice && !list.some((v) => v.id === tts.voice) ? [{ value: tts.voice, label: tts.voice }] : []),
    ...list.map((v) => ({ value: v.id, label: v.label })),
  ]
  const test = () => {
    setProblem(null)
    if (testing) speaker.stop()
    else void speaker.speak(TEST_ID, sample, { notice: (_level, text) => setProblem(text) })
  }

  return (
    <>
      <Section>
        <Row label={t('settings.tts.provider')} hint={t(TTS_HINT[tts.provider])}>
          <Select label={t('settings.tts.provider')} value={tts.provider} options={providerOptions} onChange={(x) => save((s) => ((s.voice.tts.provider = x), (s.voice.tts.voice = null), s))} />
        </Row>
        {tts.provider !== 'off' && (
          <>
            <Row label={t('settings.tts.voice')} hint={tts.provider === 'system' ? t('settings.tts.voiceHint') : undefined}>
              <Select label={t('settings.tts.voice')} value={tts.voice ?? ''} options={voiceOptions} onChange={(x) => save((s) => ((s.voice.tts.voice = x || null), s))} />
            </Row>
            <Row label={t('settings.tts.speed')}>
              <Slider label={t('settings.tts.speed')} value={tts.rate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(x) => save((s) => ((s.voice.tts.rate = x), s))} />
            </Row>
            <Row label={t('settings.tts.readAloud')} hint={t('settings.tts.readAloudHint')}>
              <Toggle label={t('settings.tts.readAloud')} value={tts.readAloud} onChange={(x) => save((s) => ((s.voice.tts.readAloud = x), s))} />
            </Row>
          </>
        )}
      </Section>
      {tts.provider === 'openai' && (
        <Section title={t('settings.tts.speechSection')}>
          <Row
            label={t('settings.tts.speechProvider')}
            hint={
              chosen && !app.ready[chosen.id] ? (
                <>
                  {t('settings.tts.noKeyYet', { name: chosen.name })}{' '}
                  <button className="link small" onClick={() => go('providers.keys')}>
                    {t('settings.tts.addKey')}
                  </button>
                </>
              ) : (
                t('settings.tts.endpointHint')
              )
            }
          >
            <Select
              label={t('settings.tts.speechProvider')}
              value={tts.openai.providerId}
              options={[
                ...(chosen ? [] : [{ value: tts.openai.providerId, label: t('settings.tts.notSetUp', { name: tts.openai.providerId }) }]),
                ...speechProviders.map((p) => ({ value: p.id, label: app.ready[p.id] ? p.name : t('settings.tts.noKey', { name: p.name }) })),
              ]}
              onChange={(x) => save((s) => ((s.voice.tts.openai.providerId = x), s))}
            />
          </Row>
          <Row label={t('settings.tts.speechModel')} hint={t('settings.tts.speechModelHint')}>
            <Select label={t('settings.tts.speechModel')} value={tts.openai.model} options={OPENAI_TTS_MODELS.map((m) => ({ value: m, label: m }))} onChange={(x) => save((s) => ((s.voice.tts.openai.model = x), s))} />
          </Row>
        </Section>
      )}
      {tts.provider !== 'off' && (
        <Section>
          <Row label={t('settings.tts.test')} hint={problem ?? t('settings.tts.says', { text: sample })}>
            <button className="btn" onClick={test} aria-pressed={testing}>
              {testing ? t('common.stop') : t('settings.tts.saySample')}
            </button>
          </Row>
        </Section>
      )}
    </>
  )
}
