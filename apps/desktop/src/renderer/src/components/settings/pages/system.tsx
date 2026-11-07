import { useEffect, useState } from 'react'
import { TRANSCRIPTION_SUGGESTIONS } from '@harness/core/voice'
import type { VoiceDownload } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useFormat, useT } from '../../../lib/i18n'
import { NumberField, Row, Section, Select, Slider, TextField, Toggle } from '../../fields'
import { ProviderLogo } from '../../ProviderLogo'
import type { PageProps } from '../common'
import { rich } from './parts'

type T = ReturnType<typeof useT>['t']

// ---------------------------------------------------------------- Browser

export function BrowserPage({ app, save, go }: PageProps) {
  const { t } = useT()
  const b = app.settings.tools.browser
  return (
    <Section>
      <Row label={t('settings.system.useBrowser')} search="Let the agent use a browser" hint={app.browser ? rich(t('settings.system.usesBrowser'), { browser: <code>{app.browser}</code> }) : t('settings.system.noBrowser')}>
        <Toggle label={t('settings.system.useBrowser')} value={b.enabled} onChange={(v) => save((s) => ((s.tools.browser.enabled = v), s))} />
      </Row>
      <Row label={t('settings.system.hideBrowser')} search="Hide the browser window" hint={t('settings.system.hideBrowserHint')}>
        <Toggle label={t('settings.system.hideBrowser')} value={b.headless} onChange={(v) => save((s) => ((s.tools.browser.headless = v), s))} />
      </Row>
      <Row label={t('settings.system.browserPath')} search="Browser path" hint={t('settings.system.browserPathHint')} labelFor="browser-path">
        <TextField id="browser-path" mono value={b.path} placeholder={t('settings.system.foundAutomatically')} onChange={(v) => save((s) => ((s.tools.browser.path = v.trim()), s))} />
      </Row>
      <Row label={t('settings.system.siteLogins')} search="Site logins" hint={b.keepLogins ? t('settings.system.siteLoginsKept') : t('settings.system.siteLoginsNotKept')}>
        <button className="link small" onClick={() => go('passwords')}>
          {t('settings.system.changeInPasswords')}
        </button>
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Passwords & Logins

const SEARCH_NAMES: Record<string, string> = { brave: 'Brave Search', tavily: 'Tavily' }

export function PasswordsPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const providers = app.settings.providers.filter((p) => app.keys[p.id])
  const search = Object.keys(SEARCH_NAMES).filter((id) => app.keys[id])
  const tokens = app.settings.mcp.servers.filter((s) => app.mcp.tokens[s.id])
  const none = !providers.length && !search.length && !tokens.length
  const b = app.settings.tools.browser
  const remove = (question: string, run: () => Promise<unknown>) => confirm(question) && run().catch(onError)
  return (
    <>
      <Section
        title={t('settings.system.savedKeys')}
        description={app.keyStorage === 'os' ? t('settings.system.savedKeysHint', { example: 'OPENROUTER_API_KEY' }) : <span className="warn">{t('settings.system.noKeychain')}</span>}
      >
        {none && <p className="muted small">{t('settings.system.noKeys')}</p>}
        {providers.map((p) => (
          <Row key={p.id} label={<span className="inline"><ProviderLogo id={p.id} name={p.name} size={14} /> {p.name}</span>} hint={t('settings.system.apiKey')} search={`${p.name} key`}>
            <div className="inline">
              <span className="mono muted" aria-label={t('settings.parts.hiddenKey')}>••••••••</span>
              <button className="link danger small" onClick={() => remove(t('settings.system.removeKeyConfirm', { name: p.name }), () => api.keys.set(p.id, null).then(onState))}>
                {t('common.remove')}
              </button>
            </div>
          </Row>
        ))}
        {search.map((id) => (
          <Row key={id} label={SEARCH_NAMES[id]} hint={t('settings.system.webSearchKey')}>
            <div className="inline">
              <span className="mono muted" aria-label={t('settings.parts.hiddenKey')}>••••••••</span>
              <button className="link danger small" onClick={() => remove(t('settings.system.removeKeyConfirm', { name: SEARCH_NAMES[id] }), () => api.keys.set(id, null).then(onState))}>
                {t('common.remove')}
              </button>
            </div>
          </Row>
        ))}
        {tokens.map((srv) => (
          <Row key={srv.id} label={srv.name} hint={t('settings.system.mcpToken')}>
            <div className="inline">
              <span className="mono muted" aria-label={t('settings.system.hiddenToken')}>••••••••</span>
              <button className="link danger small" onClick={() => remove(t('settings.system.removeTokenConfirm', { name: srv.name }), () => api.mcp.setToken(srv.id, null).then(onState))}>
                {t('common.remove')}
              </button>
            </div>
          </Row>
        ))}
      </Section>
      <Section title={t('settings.system.browserLogins')}>
        <Row label={t('settings.system.keepLogins')} search="Keep site logins" hint={t('settings.system.keepLoginsHint')}>
          <Toggle label={t('settings.system.keepLogins')} value={b.keepLogins} onChange={(v) => save((s) => ((s.tools.browser.keepLogins = v), s))} />
        </Row>
        <Row label={t('settings.system.savedLogins')} search="Saved logins" hint={app.browserLogins ? t('settings.system.savedLoginsHint') : t('settings.system.nothingSaved')}>
          <button className="btn ghost danger" disabled={!app.browserLogins} onClick={() => confirm(t('settings.system.deleteLoginsConfirm')) && api.browser.clearLogins().then(onState, onError)}>
            {t('settings.system.deleteLogins')}
          </button>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Memory & Context

export function MemoryPage({ app, save, onState, onError, go }: PageProps) {
  const { t } = useT()
  const m = app.settings.memory
  const info = app.memory
  const models = app.settings.models
  const reviewer = models.memoryReview ?? models.title
  const scopes = [
    { scope: 'project' as const, title: t('settings.system.thisProject'), facts: info.project, file: info.projectFile, empty: app.workspace ? t('settings.system.nothingForFolder') : t('settings.system.openFolderForMemories') },
    { scope: 'global' as const, title: t('settings.system.allProjects'), facts: info.global, file: info.globalFile, empty: t('settings.system.nothingSavedYet') },
  ]
  return (
    <>
      <Section>
        <Row label={t('settings.system.remember')} search="Let the agent remember" hint={t('settings.system.rememberHint')}>
          <Toggle label={t('settings.system.remember')} value={m.enabled} onChange={(v) => save((s) => ((s.memory.enabled = v), s))} />
        </Row>
        <Row
          label={t('settings.system.autoReview')}
          search="Save facts after each reply"
          hint={
            reviewer ? (
              t('settings.system.autoReviewHint')
            ) : (
              <>
                {t('settings.system.autoReviewNeedsModel')}{' '}
                <button className="link small" onClick={() => go('model.aux')}>
                  {t('settings.system.chooseOne')}
                </button>
              </>
            )
          }
        >
          <Toggle label={t('settings.system.autoReview')} value={m.autoReview} onChange={(v) => save((s) => ((s.memory.autoReview = v), s))} />
        </Row>
        <Row label={t('settings.system.sizeLimit')} search="Size limit" hint={t('settings.system.sizeLimitHint')}>
          <NumberField label={t('settings.system.sizeLimitLabel')} value={m.maxChars} min={500} max={50000} step={500} suffix={t('settings.parts.chars')} onChange={(v) => v && save((s) => ((s.memory.maxChars = v), s))} />
        </Row>
      </Section>
      {scopes.map(({ scope, title, facts, file, empty }) => (
        <Section key={scope} title={title}>
          {facts.length === 0 ? (
            <p className="muted small">{empty}</p>
          ) : (
            <div className="tool-list">
              {facts.map((f) => (
                <div key={f} className="tool-item memory-item">
                  <span className="tool-desc">{f}</span>
                  <button className="btn ghost" aria-label={t('settings.system.deleteMemoryLabel', { fact: f })} onClick={() => api.memory.remove(scope, f).then(onState, onError)}>
                    {t('common.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="inline">
            <button className="btn" disabled={!file || facts.length === 0} onClick={() => file && api.app.openPath(file)}>
              {t('settings.system.openFile')}
            </button>
            <button className="btn ghost danger" disabled={facts.length === 0} onClick={() => confirm(t('settings.system.clearMemoryConfirm', { title })) && api.memory.clear(scope).then(onState, onError)}>
              {t('settings.system.clear')}
            </button>
          </div>
        </Section>
      ))}
    </>
  )
}

export function ContextPage({ app, save, go }: PageProps) {
  const { t } = useT()
  const fmt = useFormat()
  const a = app.settings.agent
  return (
    <Section>
      <Row label={t('settings.system.autoCompact')} search="Auto-compact" hint={t('settings.system.autoCompactHint')}>
        <Toggle label={t('settings.system.autoCompact')} value={a.compactionEnabled} onChange={(v) => save((s) => ((s.agent.compactionEnabled = v), s))} />
      </Row>
      <Row label={t('settings.system.compactAt')} search="Compact at" hint={t('settings.system.compactAtHint')}>
        <Slider
          label={t('settings.system.compactAt')}
          value={a.compactionThreshold}
          min={0.3}
          max={0.95}
          step={0.05}
          format={(v) => t('settings.system.percentFull', { percent: fmt.num(Math.round(v * 100) / 100, { style: 'percent' }) })}
          onChange={(v) => save((s) => ((s.agent.compactionThreshold = v), s))}
        />
      </Row>
      <Row label={t('settings.system.summaryModel')} search="Summarization model" hint={t('settings.system.summaryModelHint')}>
        <button className="link small" onClick={() => go('model.aux')}>
          {t('settings.system.changeInAux')}
        </button>
      </Row>
      <Row label={t('settings.system.contextWindow')} search="Context window" hint={t('settings.system.contextWindowHint')}>
        <button className="link small" onClick={() => go('model.main')}>
          {t('settings.system.changeInMain')}
        </button>
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Voice

export function VoiceConversationPage({ app, save, go }: PageProps) {
  const { t } = useT()
  const v = app.settings.voice
  return (
    <Section>
      <Row
        label={t('settings.system.voiceInput')}
        search="Voice input"
        hint={
          app.voice.engine ? (
            t('settings.system.voiceInputHint')
          ) : (
            <>
              {t('settings.system.noSpeechEngine')}{' '}
              <button className="link small" onClick={() => go('voice.stt')}>
                {t('settings.system.setOneUp')}
              </button>
            </>
          )
        }
      >
        <Toggle label={t('settings.system.voiceInput')} value={v.enabled} onChange={(x) => save((s) => ((s.voice.enabled = x), s))} />
      </Row>
      <Row label={t('settings.system.longestRecording')} search="Longest recording" hint={t('settings.system.longestRecordingHint')}>
        <NumberField label={t('settings.system.longestRecording')} value={v.maxRecordingSec} min={10} max={600} step={10} suffix={t('settings.parts.seconds')} onChange={(x) => save((s) => ((s.voice.maxRecordingSec = x ?? 120), s))} />
      </Row>
      <Row label={t('settings.system.autoSend')} search="Send after transcribing" hint={t('settings.system.autoSendHint')}>
        <Toggle label={t('settings.system.autoSend')} value={v.autoSend} onChange={(x) => save((s) => ((s.voice.autoSend = x), s))} />
      </Row>
    </Section>
  )
}

const engineOptions = (t: T) => [
  { value: 'auto' as const, label: t('settings.system.engineAuto') },
  { value: 'local' as const, label: t('settings.system.engineLocal') },
  { value: 'provider' as const, label: t('settings.system.engineProvider') },
]

/** Languages whisper.cpp and the transcription APIs handle well, by ISO code. */
const SPOKEN = ['en', 'tr', 'az', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'ar', 'fa', 'hi', 'zh', 'ja', 'ko']

/** The spoken-language choices, each named in the UI language. */
function spokenLanguages(t: T, lang: string) {
  const names = new Intl.DisplayNames(lang, { type: 'language' })
  const name = (code: string) => {
    const n = names.of(code) ?? code
    return n.charAt(0).toLocaleUpperCase(lang) + n.slice(1)
  }
  return [{ value: '', label: t('settings.system.detectLanguage') }, ...SPOKEN.map((code) => ({ value: code, label: name(code) }))]
}

/** The optional offline engine: whisper.cpp plus a ggml model in the data folder. */
function LocalSpeech({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const fmt = useFormat()
  const mb = (n: number) => fmt.bytes(n)
  const v = app.voice
  const local = v.local
  const [live, setLive] = useState<VoiceDownload | null>(null)
  useEffect(() => api.onEvent((e) => e.type === 'voice_download' && setLive(e.download)), [])
  const download = v.download ? (live ?? v.download) : null
  const chosen = local.models.find((m) => m.id === app.settings.voice.localModel)!
  const needBinary = !local.binary && local.canDownloadBinary
  const missing = [
    needBinary && t('settings.system.missingBinary', { size: mb(local.binarySize ?? 0) }),
    !chosen.installed && t('settings.system.missingModel', { model: chosen.id, size: mb(chosen.size) }),
  ].filter((x): x is string => !!x)
  const start = () => {
    setLive(null)
    api.voice.download().then(onState, onError)
  }
  const remove = (what: string) => api.voice.remove(what).then(onState, onError)
  const installed = local.models.filter((m) => m.installed)
  const isMac = app.platform === 'darwin'

  return (
    <div className="voice-model">
      <div className="inline">
        <Select label={t('settings.system.localSpeechModel')} value={app.settings.voice.localModel} options={local.models.map((m) => ({ value: m.id, label: `${m.label} (${mb(m.size)})` }))} onChange={(id) => save((s) => ((s.voice.localModel = id), s))} />
        {download ? (
          <button className="btn" onClick={() => api.voice.cancelDownload().then(onState, onError)}>
            {t('settings.system.cancelDownload')}
          </button>
        ) : (
          missing.length > 0 && (
            <button className="btn primary" onClick={start}>
              {t('settings.system.download')}
            </button>
          )
        )}
      </div>
      {download && (
        <div className="voice-progress">
          <progress value={download.received} max={download.total || undefined} aria-label={download.step === 'binary' ? t('settings.system.downloadingBinary') : t('settings.system.downloadingModel', { model: download.model ?? '' })} />
          <span className="small muted" aria-hidden>
            {download.total
              ? t('settings.system.downloadProgressOf', { what: download.step === 'binary' ? 'whisper.cpp' : t('settings.system.modelName', { model: download.model ?? '' }), received: mb(download.received), total: mb(download.total) })
              : t('settings.system.downloadProgress', { what: download.step === 'binary' ? 'whisper.cpp' : t('settings.system.modelName', { model: download.model ?? '' }), received: mb(download.received) })}
          </span>
        </div>
      )}
      {!download && missing.length > 0 && <p className="small muted">{t('settings.system.downloadsWhat', { what: missing.length > 1 ? t('settings.system.binaryAndModel', { binary: missing[0], model: missing[1] }) : missing[0] })}</p>}
      <p className="small muted">
        {local.binary ? (
          rich(t(local.binary.source === 'path' ? 'settings.system.binaryFound' : 'settings.system.binaryDownloaded'), { path: <code>{local.binary.path}</code> })
        ) : local.canDownloadBinary ? (
          t('settings.system.binaryMissing')
        ) : (
          rich(t(isMac ? 'settings.system.noBuildMac' : 'settings.system.noBuildOther'), {
            command: <code>brew install whisper-cpp</code>,
            check: (
              <button className="link" onClick={() => api.getState().then(onState, onError)}>
                {t('settings.system.checkAgainLink')}
              </button>
            ),
          })
        )}
      </p>
      {(installed.length > 0 || local.binary?.source === 'download') && (
        <ul className="voice-installed" aria-label={t('settings.system.downloadedFiles')}>
          {installed.map((m) => (
            <li key={m.id}>
              <span>
                {t('settings.system.modelName', { model: m.id })} <span className="muted small">{mb(m.size)}</span>
                {local.model === m.id && <span className="badge ok">{t('settings.system.inUse')}</span>}
              </span>
              <button className="link danger small" disabled={!!download} aria-label={t('settings.system.deleteModelLabel', { model: m.id })} onClick={() => remove(m.id)}>
                {t('common.delete')}
              </button>
            </li>
          ))}
          {local.binary?.source === 'download' && (
            <li>
              <span>whisper.cpp</span>
              <button className="link danger small" disabled={!!download} aria-label={t('settings.system.deleteBinaryLabel')} onClick={() => remove('binary')}>
                {t('common.delete')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

export function SpeechToTextPage(props: PageProps) {
  const { app, save, go } = props
  const { t: tr, lang } = useT()
  const t = app.settings.models.transcription
  // Anthropic's API has no audio endpoint; every other connected provider speaks the OpenAI one.
  const providers = app.settings.providers.filter((p) => p.api === 'openai' && (app.ready[p.id] || p.id === t?.providerId))
  const provider = t && app.settings.providers.find((p) => p.id === t.providerId)
  const setProvider = (id: string) =>
    save((s) => {
      const suggested = TRANSCRIPTION_SUGGESTIONS.find((x) => x.providerId === id)?.modelId
      s.models.transcription = id ? { providerId: id, modelId: suggested ?? (s.models.transcription?.modelId || '') } : null
      return s
    })
  const suggestions = TRANSCRIPTION_SUGGESTIONS.filter((x) => app.ready[x.providerId])
  return (
    <Section>
      <Row
        label={tr('settings.system.engine')}
        search="Engine"
        hint={
          app.voice.engine === 'local'
            ? tr('settings.system.engineNowLocal')
            : app.voice.engine === 'provider'
              ? tr('settings.system.engineNowProvider', { model: t?.modelId ?? '', provider: provider?.name ?? t?.providerId ?? '' })
              : !app.settings.voice.enabled
                ? tr('settings.system.voiceOff')
                : tr('settings.system.engineNone')
        }
      >
        <Select label={tr('settings.system.voiceEngine')} value={app.settings.voice.engine} options={engineOptions(tr)} onChange={(e) => save((s) => ((s.voice.engine = e), s))} />
      </Row>
      <Row label={tr('settings.system.language')} search="Language" hint={tr('settings.system.languageHint')}>
        <Select label={tr('settings.system.spokenLanguage')} value={SPOKEN.includes(app.settings.voice.language) ? app.settings.voice.language : ''} options={spokenLanguages(tr, lang)} onChange={(v) => save((s) => ((s.voice.language = v), s))} />
      </Row>
      <Row label={tr('settings.system.localSpeechModel')} search="Local speech model" hint={tr('settings.system.localSpeechModelHint')} wide>
        <LocalSpeech {...props} />
      </Row>
      <Row label={tr('settings.system.transcriptionModel')} search="Transcription model" hint={tr('settings.system.transcriptionModelHint')} wide>
        <div className="voice-model">
          <div className="inline">
            <Select label={tr('settings.system.transcriptionProvider')} value={t?.providerId ?? ''} options={[{ value: '', label: tr('common.off') }, ...providers.map((p) => ({ value: p.id, label: p.name }))]} onChange={setProvider} />
            {t && <TextField label={tr('settings.system.transcriptionModelId')} mono value={t.modelId} placeholder="whisper-1" onChange={(v) => save((s) => ((s.models.transcription = { providerId: t.providerId, modelId: v.trim() }), s))} />}
          </div>
          {suggestions.length > 0 && (
            <div className="inline small">
              <span className="muted">{tr('settings.system.suggested')}</span>
              {suggestions.map((x) => (
                <button key={x.label} className="btn small" aria-pressed={t?.providerId === x.providerId && t.modelId === x.modelId} onClick={() => save((s) => ((s.models.transcription = { providerId: x.providerId, modelId: x.modelId }), s))}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
          {t && provider && !app.ready[t.providerId] && (
            <p className="small warn">
              {provider.enabled ? tr('settings.system.providerNeedsKey', { name: provider.name }) : tr('settings.system.providerOff', { name: provider.name })}{' '}
              <button className="link" onClick={() => go('providers.keys')}>
                {tr('settings.system.openApiKeys')}
              </button>
            </p>
          )}
        </div>
      </Row>
    </Section>
  )
}
