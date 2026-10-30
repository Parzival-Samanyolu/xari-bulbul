import { useEffect, useState } from 'react'
import { TRANSCRIPTION_SUGGESTIONS } from '@harness/core/voice'
import type { VoiceDownload } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { NumberField, Row, Section, Select, Slider, TextField, Toggle } from '../../fields'
import { ProviderLogo } from '../../ProviderLogo'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Browser

export function BrowserPage({ app, save, go }: PageProps) {
  const b = app.settings.tools.browser
  return (
    <Section>
      <Row label="Let the agent use a browser" hint={app.browser ? <>Uses <code>{app.browser}</code></> : 'No browser found. Install Chrome, Edge, Brave or Chromium, or set its path below.'}>
        <Toggle label="Let the agent use a browser" value={b.enabled} onChange={(v) => save((s) => ((s.tools.browser.enabled = v), s))} />
      </Row>
      <Row label="Hide the browser window" hint="Turn off to watch the agent click and type.">
        <Toggle label="Hide the browser window" value={b.headless} onChange={(v) => save((s) => ((s.tools.browser.headless = v), s))} />
      </Row>
      <Row label="Browser path" hint="Leave empty to find one automatically." labelFor="browser-path">
        <TextField id="browser-path" mono value={b.path} placeholder="Found automatically" onChange={(v) => save((s) => ((s.tools.browser.path = v.trim()), s))} />
      </Row>
      <Row label="Site logins" hint={b.keepLogins ? 'Kept between chats.' : 'Each browser starts signed out and its profile is deleted afterwards.'}>
        <button className="link small" onClick={() => go('passwords')}>
          Change in Passwords &amp; Logins
        </button>
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Passwords & Logins

const SEARCH_NAMES: Record<string, string> = { brave: 'Brave Search', tavily: 'Tavily' }

export function PasswordsPage({ app, save, onState, onError }: PageProps) {
  const providers = app.settings.providers.filter((p) => app.keys[p.id])
  const search = Object.keys(SEARCH_NAMES).filter((id) => app.keys[id])
  const tokens = app.settings.mcp.servers.filter((s) => app.mcp.tokens[s.id])
  const none = !providers.length && !search.length && !tokens.length
  const b = app.settings.tools.browser
  const remove = (what: string, run: () => Promise<unknown>) => confirm(`Remove the saved ${what}?`) && run().catch(onError)
  return (
    <>
      <Section
        title="Saved keys"
        description={
          app.keyStorage === 'os' ? (
            'Stored in your system keychain and never shown again. Environment variables such as OPENROUTER_API_KEY override them.'
          ) : (
            <span className="warn">No system keychain was found, so keys are only obfuscated in the data folder.</span>
          )
        }
      >
        {none && <p className="muted small">No keys saved yet.</p>}
        {providers.map((p) => (
          <Row key={p.id} label={<span className="inline"><ProviderLogo id={p.id} name={p.name} size={14} /> {p.name}</span>} hint="API key" search={`${p.name} key`}>
            <div className="inline">
              <span className="mono muted" aria-label="Hidden key">••••••••</span>
              <button className="link danger small" onClick={() => remove(`${p.name} key`, () => api.keys.set(p.id, null).then(onState))}>
                Remove
              </button>
            </div>
          </Row>
        ))}
        {search.map((id) => (
          <Row key={id} label={SEARCH_NAMES[id]} hint="Web search key">
            <div className="inline">
              <span className="mono muted" aria-label="Hidden key">••••••••</span>
              <button className="link danger small" onClick={() => remove(`${SEARCH_NAMES[id]} key`, () => api.keys.set(id, null).then(onState))}>
                Remove
              </button>
            </div>
          </Row>
        ))}
        {tokens.map((srv) => (
          <Row key={srv.id} label={srv.name} hint="MCP server token">
            <div className="inline">
              <span className="mono muted" aria-label="Hidden token">••••••••</span>
              <button className="link danger small" onClick={() => remove(`token for ${srv.name}`, () => api.mcp.setToken(srv.id, null).then(onState))}>
                Remove
              </button>
            </div>
          </Row>
        ))}
      </Section>
      <Section title="Browser logins">
        <Row label="Keep site logins" hint="The agent's browser keeps one profile in the data folder, so sites you sign in to there stay signed in. Your own browser's profile is never used.">
          <Toggle label="Keep site logins" value={b.keepLogins} onChange={(v) => save((s) => ((s.tools.browser.keepLogins = v), s))} />
        </Row>
        <Row label="Saved logins" hint={app.browserLogins ? 'Cookies and site data from the kept profile.' : 'Nothing saved.'}>
          <button className="btn ghost danger" disabled={!app.browserLogins} onClick={() => confirm('Sign out of every site in the agent’s browser and delete its profile?') && api.browser.clearLogins().then(onState, onError)}>
            Delete saved logins
          </button>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Memory & Context

export function MemoryPage({ app, save, onState, onError, go }: PageProps) {
  const m = app.settings.memory
  const info = app.memory
  const models = app.settings.models
  const reviewer = models.memoryReview ?? models.title
  const scopes = [
    { scope: 'project' as const, title: 'This project', facts: info.project, file: info.projectFile, empty: app.workspace ? 'Nothing saved for this folder yet.' : 'Open a folder to see its memories.' },
    { scope: 'global' as const, title: 'All projects', facts: info.global, file: info.globalFile, empty: 'Nothing saved yet.' },
  ]
  return (
    <>
      <Section>
        <Row label="Let the agent remember" hint="Off: saved memories are neither used nor updated.">
          <Toggle label="Let the agent remember" value={m.enabled} onChange={(v) => save((s) => ((s.memory.enabled = v), s))} />
        </Row>
        <Row
          label="Save facts after each reply"
          hint={
            reviewer ? (
              'The memory model reads the turn and saves lasting facts. You can undo each save.'
            ) : (
              <>
                Needs a memory or chat naming model.{' '}
                <button className="link small" onClick={() => go('model.aux')}>
                  Choose one
                </button>
              </>
            )
          }
        >
          <Toggle label="Save facts after each reply" value={m.autoReview} onChange={(v) => save((s) => ((s.memory.autoReview = v), s))} />
        </Row>
        <Row label="Size limit" hint="Characters per list. When a list is full the agent must remove or merge entries.">
          <NumberField label="Memory size limit" value={m.maxChars} min={500} max={50000} step={500} suffix="chars" onChange={(v) => v && save((s) => ((s.memory.maxChars = v), s))} />
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
                  <button className="btn ghost" aria-label={`Delete memory: ${f}`} onClick={() => api.memory.remove(scope, f).then(onState, onError)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="inline">
            <button className="btn" disabled={!file || facts.length === 0} onClick={() => file && api.app.openPath(file)}>
              Open file
            </button>
            <button className="btn ghost danger" disabled={facts.length === 0} onClick={() => confirm(`Delete every memory in "${title}"?`) && api.memory.clear(scope).then(onState, onError)}>
              Clear
            </button>
          </div>
        </Section>
      ))}
    </>
  )
}

export function ContextPage({ app, save, go }: PageProps) {
  const a = app.settings.agent
  return (
    <Section>
      <Row label="Auto-compact" hint="Summarize older messages when the context window fills up.">
        <Toggle label="Auto-compact" value={a.compactionEnabled} onChange={(v) => save((s) => ((s.agent.compactionEnabled = v), s))} />
      </Row>
      <Row label="Compact at" hint="How full the context window gets before older messages are summarized.">
        <Slider label="Compact at" value={a.compactionThreshold} min={0.3} max={0.95} step={0.05} format={(v) => `${Math.round(v * 100)}% full`} onChange={(v) => save((s) => ((s.agent.compactionThreshold = v), s))} />
      </Row>
      <Row label="Summarization model" hint="The model that writes the summaries.">
        <button className="link small" onClick={() => go('model.aux')}>
          Change in Auxiliary models
        </button>
      </Row>
      <Row label="Context window" hint="The default model's window, or the fallback size for models that don't report one.">
        <button className="link small" onClick={() => go('model.main')}>
          Change in Main model
        </button>
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Voice

export function VoiceConversationPage({ app, save, go }: PageProps) {
  const v = app.settings.voice
  return (
    <Section>
      <Row label="Voice input" hint={app.voice.engine ? 'The mic button in the message box records you and types what you said.' : <>No speech engine is set up, so the mic button is hidden. <button className="link small" onClick={() => go('voice.stt')}>Set one up</button></>}>
        <Toggle label="Voice input" value={v.enabled} onChange={(x) => save((s) => ((s.voice.enabled = x), s))} />
      </Row>
      <Row label="Longest recording" hint="Recording stops and is transcribed after this long.">
        <NumberField label="Longest recording" value={v.maxRecordingSec} min={10} max={600} step={10} suffix="seconds" onChange={(x) => save((s) => ((s.voice.maxRecordingSec = x ?? 120), s))} />
      </Row>
      <Row label="Send after transcribing" hint="Off: the text goes into the message box so you can check it first.">
        <Toggle label="Send after transcribing" value={v.autoSend} onChange={(x) => save((s) => ((s.voice.autoSend = x), s))} />
      </Row>
    </Section>
  )
}

const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`

const ENGINE_OPTIONS = [
  { value: 'auto' as const, label: 'Auto: local model if downloaded, else provider' },
  { value: 'local' as const, label: 'Local model only' },
  { value: 'provider' as const, label: 'Provider only' },
]

const LANGUAGES = [
  ['', 'Detect automatically'], ['en', 'English'], ['tr', 'Turkish'], ['az', 'Azerbaijani'], ['ru', 'Russian'], ['de', 'German'],
  ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'],
  ['ar', 'Arabic'], ['fa', 'Persian'], ['hi', 'Hindi'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
].map(([value, label]) => ({ value, label }))

/** The optional offline engine: whisper.cpp plus a ggml model in the data folder. */
function LocalSpeech({ app, save, onState, onError }: PageProps) {
  const v = app.voice
  const local = v.local
  const [live, setLive] = useState<VoiceDownload | null>(null)
  useEffect(() => api.onEvent((e) => e.type === 'voice_download' && setLive(e.download)), [])
  const download = v.download ? (live ?? v.download) : null
  const chosen = local.models.find((m) => m.id === app.settings.voice.localModel)!
  const needBinary = !local.binary && local.canDownloadBinary
  const missing = [needBinary && `whisper.cpp (${mb(local.binarySize ?? 0)})`, !chosen.installed && `the ${chosen.id} model (${mb(chosen.size)})`].filter(Boolean)
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
        <Select label="Local speech model" value={app.settings.voice.localModel} options={local.models.map((m) => ({ value: m.id, label: `${m.label} (${mb(m.size)})` }))} onChange={(id) => save((s) => ((s.voice.localModel = id), s))} />
        {download ? (
          <button className="btn" onClick={() => api.voice.cancelDownload().then(onState, onError)}>
            Cancel download
          </button>
        ) : (
          missing.length > 0 && (
            <button className="btn primary" onClick={start}>
              Download
            </button>
          )
        )}
      </div>
      {download && (
        <div className="voice-progress">
          <progress value={download.received} max={download.total || undefined} aria-label={download.step === 'binary' ? 'Downloading whisper.cpp' : `Downloading the ${download.model} model`} />
          <span className="small muted" aria-hidden>
            {download.step === 'binary' ? 'whisper.cpp' : `${download.model} model`}: {mb(download.received)}
            {download.total ? ` of ${mb(download.total)}` : ''}
          </span>
        </div>
      )}
      {!download && missing.length > 0 && <p className="small muted">Downloads {missing.join(' and ')}. Checksums are verified before anything is used.</p>}
      <p className="small muted">
        {local.binary ? (
          <>
            whisper.cpp: <code>{local.binary.path}</code> {local.binary.source === 'path' ? '(found on your system)' : '(downloaded)'}
          </>
        ) : local.canDownloadBinary ? (
          'whisper.cpp is not installed yet.'
        ) : (
          <>
            whisper.cpp publishes no ready-made build for {isMac ? 'macOS' : 'this system'}. {isMac ? 'Install it with Homebrew' : 'Install whisper-cli with your package manager or build it'}
            {isMac && (
              <>
                : <code>brew install whisper-cpp</code>
              </>
            )}
            . Then{' '}
            <button className="link" onClick={() => api.getState().then(onState, onError)}>
              check again
            </button>
            .
          </>
        )}
      </p>
      {(installed.length > 0 || local.binary?.source === 'download') && (
        <ul className="voice-installed" aria-label="Downloaded speech files">
          {installed.map((m) => (
            <li key={m.id}>
              <span>
                {m.id} model <span className="muted small">{mb(m.size)}</span>
                {local.model === m.id && <span className="badge ok">in use</span>}
              </span>
              <button className="link danger small" disabled={!!download} aria-label={`Delete the ${m.id} model`} onClick={() => remove(m.id)}>
                Delete
              </button>
            </li>
          ))}
          {local.binary?.source === 'download' && (
            <li>
              <span>whisper.cpp</span>
              <button className="link danger small" disabled={!!download} aria-label="Delete the downloaded whisper.cpp" onClick={() => remove('binary')}>
                Delete
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
        label="Engine"
        hint={
          app.voice.engine === 'local'
            ? 'Now using the local speech model.'
            : app.voice.engine === 'provider'
              ? `Now using ${t?.modelId} on ${provider?.name ?? t?.providerId}.`
              : !app.settings.voice.enabled
                ? 'Voice input is off.'
                : 'Nothing is set up yet, so the mic button is hidden.'
        }
      >
        <Select label="Voice engine" value={app.settings.voice.engine} options={ENGINE_OPTIONS} onChange={(e) => save((s) => ((s.voice.engine = e), s))} />
      </Row>
      <Row label="Language" hint="The language you speak. Detecting works, but naming it is faster and more accurate for short recordings.">
        <Select label="Spoken language" value={LANGUAGES.some((l) => l.value === app.settings.voice.language) ? app.settings.voice.language : ''} options={LANGUAGES} onChange={(v) => save((s) => ((s.voice.language = v), s))} />
      </Row>
      <Row label="Local speech model" hint="whisper.cpp runs on this computer, without a key or network. Base suits most dictation; Small is more accurate but slower." wide>
        <LocalSpeech {...props} />
      </Row>
      <Row label="Transcription model" hint="Sends recordings to a provider with an OpenAI-style transcription endpoint." wide>
        <div className="voice-model">
          <div className="inline">
            <Select label="Transcription provider" value={t?.providerId ?? ''} options={[{ value: '', label: 'Off' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]} onChange={setProvider} />
            {t && <TextField label="Transcription model id" mono value={t.modelId} placeholder="whisper-1" onChange={(v) => save((s) => ((s.models.transcription = { providerId: t.providerId, modelId: v.trim() }), s))} />}
          </div>
          {suggestions.length > 0 && (
            <div className="inline small">
              <span className="muted">Suggested:</span>
              {suggestions.map((x) => (
                <button key={x.label} className="btn small" aria-pressed={t?.providerId === x.providerId && t.modelId === x.modelId} onClick={() => save((s) => ((s.models.transcription = { providerId: x.providerId, modelId: x.modelId }), s))}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
          {t && provider && !app.ready[t.providerId] && (
            <p className="small warn">
              {provider.enabled ? `${provider.name} needs an API key.` : `${provider.name} is turned off.`}{' '}
              <button className="link" onClick={() => go('providers.keys')}>
                Open API keys
              </button>
            </p>
          )}
        </div>
      </Row>
    </Section>
  )
}
