import { useState } from 'react'
import { MCP_PRESETS, presetServer } from '@harness/core/mcp-presets'
import { EFFORT_LABELS, EFFORT_LEVELS, RECOMMENDED, TIER_LABELS, refKey, type RecommendedTier } from '@harness/core/catalog'
import type { AppState, McpServerStatus, ModelRef, ProviderTestResult, Settings, UpdateStatus } from '../../../shared/ipc'
import { api } from '../lib/api'
import { cost, modelLabel, tokens } from '../lib/format'
import { MODES } from './Composer'
import { ListField, NumberField, Row, Section, Select, Slider, TextField, Toggle } from './fields'
import { ModelPicker } from './ModelPicker'
import { ProviderLogo } from './ProviderLogo'

interface Props {
  app: AppState
  tab: string
  onTab: (t: string) => void
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onClose: () => void
  update: UpdateStatus
}

const TABS = [
  { id: 'providers', label: 'Providers & Keys' },
  { id: 'models', label: 'Models' },
  { id: 'agent', label: 'Agent' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'tools', label: 'Tools & Extensions' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'memory', label: 'Memory' },
  { id: 'usage', label: 'Usage & Budgets' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data & Updates' },
]

type Save = (fn: (s: Settings) => Settings) => void

export function SettingsView({ app, tab, onTab, onState, onError, onClose, update }: Props) {
  const save: Save = (fn) => api.settings.set(fn(structuredClone(app.settings))).then(onState, onError)
  const common = { app, save, onState, onError, onTab }
  return (
    <div className="settings">
      <nav className="s-tabs">
        <div className="s-tabs-title">Settings</div>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          ← Back to chat
        </button>
      </nav>
      <div className="s-body">
        {tab === 'providers' && <ProvidersTab {...common} />}
        {tab === 'models' && <ModelsTab {...common} />}
        {tab === 'agent' && <AgentTab {...common} />}
        {tab === 'permissions' && <PermissionsTab {...common} />}
        {tab === 'hooks' && <HooksTab {...common} />}
        {tab === 'tools' && <ToolsTab {...common} />}
        {tab === 'mcp' && <McpTab {...common} />}
        {tab === 'memory' && <MemoryTab {...common} />}
        {tab === 'usage' && <UsageTab {...common} />}
        {tab === 'appearance' && <AppearanceTab {...common} />}
        {tab === 'data' && <DataTab {...common} update={update} />}
      </div>
    </div>
  )
}

interface TabProps {
  app: AppState
  save: Save
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onTab?: (t: string) => void
}

const KEY_LINKS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/keys',
  'ollama-cloud': 'https://ollama.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  cerebras: 'https://cloud.cerebras.ai',
  nvidia: 'https://build.nvidia.com/settings/api-keys',
  zai: 'https://z.ai/manage-apikey/apikey-list',
  deepseek: 'https://platform.deepseek.com/api_keys',
}

// ---------------------------------------------------------------- Providers

function ProvidersTab({ app, save, onState, onError }: TabProps) {
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, ProviderTestResult | 'running'>>({})
  const [custom, setCustom] = useState({ id: '', name: '', baseUrl: '', requiresKey: true })
  const builtin = new Set(app.builtinProviders)
  const existing = new Set(app.settings.providers.map((p) => p.id))

  const test = (id: string) => {
    setTests((t) => ({ ...t, [id]: 'running' }))
    api.providers.test(id).then((r) => setTests((t) => ({ ...t, [id]: r })), onError)
  }
  const addProvider = (p: { id: string; name: string; baseUrl: string; requiresKey: boolean }) =>
    api.settings
      .set({ ...app.settings, providers: [...app.settings.providers, { ...p, enabled: true, headers: {}, requestUsageCost: false, api: 'openai' as const }] })
      .then((s) => {
        onState(s)
        // Keyless servers can be checked right away; keyed ones after the key is saved.
        if (!p.requiresKey) test(p.id)
      }, onError)

  return (
    <>
      <Section
        title="Providers & API keys"
        description={
          <>
            Keys are stored in your OS keychain (
            {app.keyStorage === 'os' ? 'secure storage active' : <span className="warn">no keyring found, so keys are only obfuscated</span>}) and never shown again.
            Environment variables like <code>OPENROUTER_API_KEY</code> also work.
          </>
        }
      >
        {app.settings.providers.map((p, i) => {
          const t = tests[p.id]
          const ready = app.ready[p.id]
          const folded = app.settings.app.collapsedProviders.includes(p.id)
          const fold = () =>
            save((s) => ((s.app.collapsedProviders = folded ? s.app.collapsedProviders.filter((x) => x !== p.id) : [...s.app.collapsedProviders, p.id]), s))
          return (
            <div key={p.id} className={`provider-card ${folded ? 'folded' : ''}`}>
              <div className="provider-head">
                <Toggle label={`Enable ${p.name}`} value={p.enabled} onChange={(v) => save((s) => ((s.providers[i].enabled = v), s))} />
                <button className="provider-fold" aria-expanded={!folded} title={folded ? `Show ${p.name} settings` : `Hide ${p.name} settings`} onClick={fold}>
                  <span className="fold-caret" aria-hidden>
                    {folded ? '▸' : '▾'}
                  </span>
                  <ProviderLogo id={p.id} name={p.name} size={16} />
                  <b>{p.name}</b>
                </button>
                <span className={`badge ${ready ? 'ok' : ''}`}>{!p.enabled ? 'off' : ready ? (p.requiresKey ? 'key set' : 'no key needed') : 'needs key'}</span>
                {KEY_LINKS[p.id] && (
                  <button className="link small" onClick={() => api.app.openExternal(KEY_LINKS[p.id])}>
                    get a key ↗
                  </button>
                )}
                <div className="spacer" />
                {!builtin.has(p.id) && (
                  <button className="link danger small" onClick={() => confirm(`Remove ${p.name}?`) && save((s) => ((s.providers = s.providers.filter((x) => x.id !== p.id)), s))}>
                    Remove provider
                  </button>
                )}
              </div>
              {!folded && p.requiresKey && (
                <Row label="API key" labelFor={`key-${p.id}`}>
                  <div className="key-row">
                    <input
                      id={`key-${p.id}`}
                      type="password"
                      className="mono"
                      autoComplete="off"
                      placeholder={app.keys[p.id] ? '•••••••• (saved)' : 'Paste API key'}
                      value={keys[p.id] ?? ''}
                      onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && keys[p.id]?.trim() && (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click()}
                    />
                    <button
                      className="btn primary"
                      disabled={!keys[p.id]?.trim()}
                      onClick={() =>
                        api.keys.set(p.id, keys[p.id]).then((s) => {
                          onState(s)
                          setKeys((k) => ({ ...k, [p.id]: '' }))
                          test(p.id)
                        }, onError)
                      }
                    >
                      Save
                    </button>
                    {app.keys[p.id] && (
                      <button className="btn ghost" onClick={() => api.keys.set(p.id, null).then(onState, onError)}>
                        Remove key
                      </button>
                    )}
                  </div>
                </Row>
              )}
              {!folded && (
                <>
                  <div className="provider-foot">
                    <button className="btn" disabled={!ready || t === 'running'} onClick={() => test(p.id)}>
                      {t === 'running' ? 'Testing…' : 'Test connection'}
                    </button>
                    {t && t !== 'running' && (
                      <span className={`small ${t.ok ? 'okc' : 'warn'}`} role="status">
                        {t.message}
                      </span>
                    )}
                  </div>
                  <details className="advanced">
                    <summary>Advanced</summary>
                    <Row label="Base URL" hint="OpenAI-compatible endpoint" labelFor={`url-${p.id}`}>
                      <TextField label="Base URL" id={`url-${p.id}`} mono value={p.baseUrl} onChange={(v) => save((s) => ((s.providers[i].baseUrl = v), s))} />
                    </Row>
                    <Row label="Needs an API key" hint="Turn off for local servers like Ollama or LM Studio">
                      <Toggle label="Needs an API key" value={p.requiresKey} onChange={(v) => save((s) => ((s.providers[i].requiresKey = v), s))} />
                    </Row>
                    <Row label="Report exact cost" hint="Asks the provider to include the cost of each request (supported by OpenRouter)">
                      <Toggle label="Report exact cost" value={p.requestUsageCost} onChange={(v) => save((s) => ((s.providers[i].requestUsageCost = v), s))} />
                    </Row>
                  </details>
                </>
              )}
            </div>
          )
        })}
      </Section>
      <Section title="Add a provider" description="Anything that speaks the OpenAI chat API works. Local servers need no key.">
        <div className="presets">
          {app.providerPresets.map((p) => (
            <button key={p.id} className="btn" disabled={existing.has(p.id)} onClick={() => addProvider(p)} title={p.baseUrl}>
              + <ProviderLogo id={p.id} name={p.name} /> {p.name}
              <span className="muted small">{p.requiresKey ? 'key' : 'no key'}</span>
            </button>
          ))}
        </div>
        <div className="custom-provider">
          <label>
            <span className="small muted">Id</span>
            <input placeholder="my-server" value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
          </label>
          <label>
            <span className="small muted">Name</span>
            <input placeholder="My server" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          </label>
          <label className="grow">
            <span className="small muted">Base URL</span>
            <input className="mono" placeholder="http://localhost:8000/v1" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={custom.requiresKey} onChange={(e) => setCustom({ ...custom, requiresKey: e.target.checked })} /> needs a key
          </label>
          <button
            className="btn"
            disabled={!custom.id || !custom.name || !/^https?:\/\//.test(custom.baseUrl) || existing.has(custom.id)}
            onClick={() => {
              addProvider(custom)
              setCustom({ id: '', name: '', baseUrl: '', requiresKey: true })
            }}
          >
            Add
          </button>
        </div>
        {custom.id && existing.has(custom.id) && <div className="small warn">A provider with id "{custom.id}" already exists.</div>}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Models

const TRI_STATE = [
  { value: '', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

const PROMPT_STYLES = [
  { value: 'auto', label: 'Auto (short for free models)' },
  { value: 'full', label: 'Full' },
  { value: 'lean', label: 'Short' },
]

function RecommendedModels({ app, save, onState, onError, onTab }: TabProps) {
  const favorites = new Set(app.settings.models.favorites.map(refKey))
  const current = refKey(app.settings.models.default)
  const use = (ref: ModelRef) => {
    save((s) => ((s.models.default = ref), s))
    if (app.session) api.agent.setModel(ref).then(onState, onError)
  }
  const favorite = (ref: ModelRef) => save((s) => (s.models.favorites.some((f) => refKey(f) === refKey(ref)) || s.models.favorites.push(ref), s))
  return (
    <Section title="Recommended models" description="Models that work well for coding here. Use sets the default for new chats and switches the open chat.">
      {(Object.keys(TIER_LABELS) as RecommendedTier[]).map((tier) => (
        <div key={tier} className="rec-tier">
          <h4 className="rec-tier-title">{TIER_LABELS[tier]}</h4>
          {RECOMMENDED.filter((r) => r.tier === tier).map((r) => {
            const k = refKey(r.ref)
            const provider = app.settings.providers.find((p) => p.id === r.ref.providerId)
            const ready = !!app.ready[r.ref.providerId]
            return (
              <div key={k} className="rec-row">
                <div className="rec-text">
                  <div className="rec-name">
                    {r.name}{' '}
                    <span className="muted small">
                      · <ProviderLogo id={r.ref.providerId} name={provider?.name} size={12} /> {provider?.name ?? r.ref.providerId}
                    </span>
                  </div>
                  <div className="muted small">{r.note}</div>
                </div>
                {ready ? (
                  <span className="badge ok">ready</span>
                ) : (
                  <button className="badge rec-key" onClick={() => onTab?.('providers')} title={`Add a ${provider?.name ?? r.ref.providerId} key`}>
                    needs key
                  </button>
                )}
                <button className="btn" disabled={favorites.has(k)} onClick={() => favorite(r.ref)}>
                  {favorites.has(k) ? 'In favorites' : 'Add to favorites'}
                </button>
                <button className="btn primary" disabled={current === k} onClick={() => use(r.ref)}>
                  {current === k ? 'In use' : 'Use'}
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </Section>
  )
}

const EFFORTS = [{ value: '', label: 'Provider default' }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))]
const SPEEDS = [
  { value: '', label: 'Standard' },
  { value: 'fast', label: 'Fast' },
  { value: 'batch', label: 'Batch' },
]

function ModelsTab({ app, save, onState, onError, onTab }: TabProps) {
  const [picking, setPicking] = useState<null | 'default' | 'compaction' | 'title' | 'memoryReview' | 'subagent' | 'override' | 'favorite'>(null)
  const m = app.settings.models
  const ref = (r: ModelRef | null) => (r ? `${modelLabel(r.modelId)} · ${r.providerId}` : 'Same as active model')
  const onPick = (r: ModelRef) => {
    const k = `${r.providerId}:${r.modelId}`
    if (picking === 'default') save((s) => ((s.models.default = r), s))
    if (picking === 'compaction') save((s) => ((s.models.compaction = r), s))
    if (picking === 'title') save((s) => ((s.models.title = r), s))
    if (picking === 'memoryReview') save((s) => ((s.models.memoryReview = r), s))
    if (picking === 'subagent') save((s) => ((s.agent.subagents.model = r), s))
    if (picking === 'favorite') save((s) => (s.models.favorites.some((f) => `${f.providerId}:${f.modelId}` === k) || s.models.favorites.push(r), s))
    if (picking === 'override') save((s) => ((s.models.overrides[k] ??= {}), s))
  }
  return (
    <>
      <RecommendedModels app={app} save={save} onState={onState} onError={onError} onTab={onTab} />
      <Section title="Model selection">
        <Row label="Default model" hint={`Used for new chats. Switch any time with ${app.platform === 'darwin' ? '⌘K' : 'Ctrl+K'}.`}>
          <button className="btn" onClick={() => setPicking('default')}>
            {ref(m.default)}
          </button>
        </Row>
        <Row label="Summarization model" hint="Used when compacting long conversations. A cheap fast model works well.">
          <div className="inline">
            <button className="btn" onClick={() => setPicking('compaction')}>
              {ref(m.compaction)}
            </button>
            {m.compaction && (
              <button className="link small" onClick={() => save((s) => ((s.models.compaction = null), s))}>
                reset
              </button>
            )}
          </div>
        </Row>
        <Row label="Chat naming model" hint="Names new chats from the first message. Without one, the first line becomes the title.">
          <div className="inline">
            <button className="btn" onClick={() => setPicking('title')}>
              {m.title ? `${modelLabel(m.title.modelId)} · ${m.title.providerId}` : 'Off'}
            </button>
            {m.title && (
              <button className="link small" onClick={() => save((s) => ((s.models.title = null), s))}>
                turn off
              </button>
            )}
          </div>
        </Row>
        <Row label="Memory model" hint="After each reply, saves lasting facts such as your preferences and project commands to memory. Without one, the chat naming model does this; with neither, it's off.">
          <div className="inline">
            <button className="btn" onClick={() => setPicking('memoryReview')}>
              {m.memoryReview ? `${modelLabel(m.memoryReview.modelId)} · ${m.memoryReview.providerId}` : m.title ? 'Same as chat naming model' : 'Off'}
            </button>
            {m.memoryReview && (
              <button className="link small" onClick={() => save((s) => ((s.models.memoryReview = null), s))}>
                reset
              </button>
            )}
          </div>
        </Row>
        <Row label="Subagent model" hint="Used by subagents. A fast free model suits searching and research.">
          <div className="inline">
            <button className="btn" onClick={() => setPicking('subagent')}>
              {ref(app.settings.agent.subagents.model)}
            </button>
            {app.settings.agent.subagents.model && (
              <button className="link small" onClick={() => save((s) => ((s.agent.subagents.model = null), s))}>
                reset
              </button>
            )}
          </div>
        </Row>
        <Row label="Favorites" hint="Pinned at the top of the model switcher." wide>
          <div className="list-field">
            {m.favorites.map((f) => (
              <div key={`${f.providerId}:${f.modelId}`} className="list-item">
                <code>{f.modelId}</code>
                <span className="muted small">
                  <ProviderLogo id={f.providerId} size={12} /> {f.providerId}
                </span>
                <button className="link danger" onClick={() => save((s) => ((s.models.favorites = s.models.favorites.filter((x) => !(x.providerId === f.providerId && x.modelId === f.modelId))), s))}>
                  remove
                </button>
              </div>
            ))}
            <button className="btn" onClick={() => setPicking('favorite')}>
              + Add favorite
            </button>
          </div>
        </Row>
      </Section>
      <Section title="Generation defaults" description="Leave empty to use each provider's default.">
        <Row label="Temperature">
          <NumberField label="Temperature" nullable value={m.temperature} min={0} max={2} step={0.1} placeholder="default" onChange={(v) => save((s) => ((s.models.temperature = v), s))} />
        </Row>
        <Row label="Max output tokens">
          <NumberField label="Max output tokens" nullable value={m.maxTokens} min={1} placeholder="default" onChange={(v) => save((s) => ((s.models.maxTokens = v), s))} />
        </Row>
        <Row label="Reasoning effort" hint="For thinking models that support it">
          <Select label="Reasoning effort" value={(m.reasoningEffort ?? '') as string} options={EFFORTS} onChange={(v) => save((s) => ((s.models.reasoningEffort = (v || null) as never), s))} />
        </Row>
        <Row label="Fallback context size" hint="When a provider doesn't report one (e.g. Ollama)">
          <NumberField label="Fallback context size" value={m.defaultContextLength} min={1000} suffix="tokens" onChange={(v) => save((s) => ((s.models.defaultContextLength = v ?? 128000), s))} />
        </Row>
      </Section>
      <Section title="Per-model overrides" description="Settings that only apply to one model.">
        {Object.entries(m.overrides).map(([k, o]) => (
          <div key={k} className="override">
            <div className="provider-head">
              <code>{k}</code>
              <div className="spacer" />
              <button className="link danger small" onClick={() => save((s) => (delete s.models.overrides[k], s))}>
                remove
              </button>
            </div>
            <div className="override-grid">
              <label>
                Temperature
                <NumberField nullable value={o.temperature ?? null} min={0} max={2} step={0.1} placeholder="—" onChange={(v) => save((s) => ((s.models.overrides[k].temperature = v ?? undefined), s))} />
              </label>
              <label>
                Max tokens
                <NumberField nullable value={o.maxTokens ?? null} min={1} placeholder="—" onChange={(v) => save((s) => ((s.models.overrides[k].maxTokens = v ?? undefined), s))} />
              </label>
              <label>
                Context size
                <NumberField nullable value={o.contextLength ?? null} min={1000} placeholder="—" onChange={(v) => save((s) => ((s.models.overrides[k].contextLength = v ?? undefined), s))} />
              </label>
              <label>
                Reasoning
                <Select value={(o.reasoningEffort ?? '') as string} options={EFFORTS} onChange={(v) => save((s) => ((s.models.overrides[k].reasoningEffort = (v || undefined) as never), s))} />
              </label>
              <label title="Fast: the provider's fast option (Anthropic fast mode, OpenAI priority, OpenRouter fastest host), costs more. Batch: Anthropic and OpenAI batch APIs, about half price but each step can take minutes.">
                Speed
                <Select value={o.speed === 'standard' ? '' : (o.speed ?? '')} options={SPEEDS} onChange={(v) => save((s) => ((s.models.overrides[k].speed = (v || undefined) as never), s))} />
              </label>
              <label title="Send the model's reasoning back during a tool loop. Auto = on, except OpenAI's own API.">
                Replay reasoning
                <Select value={o.replayReasoning == null ? '' : o.replayReasoning ? 'on' : 'off'} options={TRI_STATE} onChange={(v) => save((s) => ((s.models.overrides[k].replayReasoning = v ? v === 'on' : undefined), s))} />
              </label>
              <label>
                Prompt
                <Select
                  value={o.promptStyle ?? ''}
                  options={[{ value: '', label: 'Agent setting' }, ...PROMPT_STYLES.slice(1)]}
                  onChange={(v) => save((s) => ((s.models.overrides[k].promptStyle = (v || undefined) as never), s))}
                />
              </label>
            </div>
          </div>
        ))}
        <button className="btn" onClick={() => setPicking('override')}>
          + Add override
        </button>
      </Section>
      {picking && <ModelPicker app={app} onClose={() => setPicking(null)} onState={onState} onError={onError} onPick={onPick} title="Choose a model…" />}
    </>
  )
}

// ---------------------------------------------------------------- Agent

function AgentTab({ app, save }: TabProps) {
  const a = app.settings.agent
  return (
    <>
      <Section title="Behavior">
        <Row label="Max steps per message" hint="Model requests per message before pausing (safety net against loops)">
          <NumberField label="Max steps per message" value={a.maxStepsPerTurn} min={1} max={1000} onChange={(v) => save((s) => ((s.agent.maxStepsPerTurn = v ?? 200), s))} />
        </Row>
        <Row label="Batch while planning" hint="Plan mode sends requests through the Anthropic or OpenAI batch API: about half price, but each step can take minutes">
          <Toggle label="Batch while planning" value={a.batchInPlanMode} onChange={(v) => save((s) => ((s.agent.batchInPlanMode = v), s))} />
        </Row>
        <Row label="System prompt" hint="Short drops the detailed guidance; small models follow it better. Auto uses it for free models.">
          <Select label="System prompt" value={a.promptStyle} options={PROMPT_STYLES as { value: typeof a.promptStyle; label: string }[]} onChange={(v) => save((s) => ((s.agent.promptStyle = v), s))} />
        </Row>
        <Row label="Custom instructions" hint="Added to every conversation, in every project" wide>
          <TextField label="Custom instructions" multiline rows={5} value={a.customInstructions} placeholder="e.g. Always use pnpm. Prefer small commits. Write tests with vitest." onChange={(v) => save((s) => ((s.agent.customInstructions = v), s))} />
        </Row>
        <Row label="Project instruction files" hint="Read from the project root and added to the prompt" wide>
          <ListField label="Project instruction files" value={a.projectInstructionFiles} placeholder="AGENTS.md" onChange={(v) => save((s) => ((s.agent.projectInstructionFiles = v), s))} />
        </Row>
        <Row label="System prompt override" hint="Advanced: replaces the built-in system prompt. Leave empty for the default." wide>
          <TextField label="System prompt override" multiline mono rows={6} value={a.systemPromptOverride} placeholder="(built-in prompt)" onChange={(v) => save((s) => ((s.agent.systemPromptOverride = v), s))} />
        </Row>
      </Section>
      <Section
        title="Subagents"
        description="The agent can hand a self-contained job (a wide search, a piece of research, an independent change) to a subagent with a fresh context. Only the subagent's report comes back, so the chat's context stays small. Subagents follow the same permissions, and their cost counts toward the chat. Pick their model under Models."
      >
        <Row label="Allow subagents" hint="Gives the agent the task tool">
          <Toggle label="Allow subagents" value={a.subagents.enabled} onChange={(v) => save((s) => ((s.agent.subagents.enabled = v), s))} />
        </Row>
        {a.subagents.enabled && (
          <>
            <Row label="Subagents can edit" hint="Off = subagents only read and search. Edits and commands still ask for approval in Ask mode.">
              <Toggle label="Subagents can edit" value={a.subagents.allowWrite} onChange={(v) => save((s) => ((s.agent.subagents.allowWrite = v), s))} />
            </Row>
            <Row label="Run at once" hint="Subagents started together run in parallel, up to this many">
              <NumberField label="Subagents at once" value={a.subagents.maxParallel} min={1} max={8} onChange={(v) => save((s) => ((s.agent.subagents.maxParallel = v ?? 3), s))} />
            </Row>
            <Row label="Max steps per subagent">
              <NumberField label="Max steps per subagent" value={a.subagents.maxSteps} min={1} max={500} onChange={(v) => save((s) => ((s.agent.subagents.maxSteps = v ?? 50), s))} />
            </Row>
          </>
        )}
      </Section>
      <Section title="Context">
        <Row label="Auto-compact" hint="Summarize older messages when the context window fills up">
          <Toggle label="Auto-compact" value={a.compactionEnabled} onChange={(v) => save((s) => ((s.agent.compactionEnabled = v), s))} />
        </Row>
        <Row label="Compact at">
          <Slider label="Compact at" value={a.compactionThreshold} min={0.3} max={0.95} step={0.05} format={(v) => `${Math.round(v * 100)}% full`} onChange={(v) => save((s) => ((s.agent.compactionThreshold = v), s))} />
        </Row>
        <Row label="Max tool output" hint="Longer output is truncated (head + tail kept)">
          <NumberField label="Max tool output" value={a.toolOutputMaxChars} min={1000} step={1000} suffix="chars" onChange={(v) => save((s) => ((s.agent.toolOutputMaxChars = v ?? 30000), s))} />
        </Row>
      </Section>
      <Section title="Shell & network">
        <Row label="Command timeout">
          <NumberField label="Command timeout" value={a.bashTimeoutSec} min={1} max={3600} suffix="seconds" onChange={(v) => save((s) => ((s.agent.bashTimeoutSec = v ?? 120), s))} />
        </Row>
        <Row label="Shell" hint={app.platform === 'win32' ? 'Empty = Git Bash if installed, else PowerShell. Or enter pwsh, powershell or a path' : 'Empty = /bin/bash'}>
          <TextField label="Shell" mono value={a.shell} placeholder="(default)" onChange={(v) => save((s) => ((s.agent.shell = v), s))} />
        </Row>
        <Row label="Request retries" hint="On rate limits (429) and server errors">
          <NumberField label="Request retries" value={a.requestRetries} min={0} max={10} onChange={(v) => save((s) => ((s.agent.requestRetries = v ?? 3), s))} />
        </Row>
        <Row label="Stall timeout (seconds)" hint="Stop waiting when a hosted provider sends nothing for this long. 0 waits forever.">
          <NumberField label="Stall timeout" value={a.stallTimeoutSec} min={0} max={3600} onChange={(v) => save((s) => ((s.agent.stallTimeoutSec = v ?? 90), s))} />
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Hooks

type HookKind = 'preTool' | 'postTool'

function HooksTab({ app, save }: TabProps) {
  const h = app.settings.hooks
  const list = (kind: HookKind, title: string, description: string) => (
    <Section title={title} description={description}>
      {h[kind].map((rule, i) => (
        <div key={i} className="override">
          <div className="provider-head">
            <Toggle label="Enabled" value={rule.enabled} onChange={(v) => save((s) => ((s.hooks[kind][i].enabled = v), s))} />
            <span className="muted small">{rule.enabled ? 'On' : 'Off'}</span>
            <div className="spacer" />
            <button className="link danger small" onClick={() => save((s) => (s.hooks[kind].splice(i, 1), s))}>
              remove
            </button>
          </div>
          <div className="hook-grid">
            <label>
              Match
              <TextField label="Match" mono value={rule.match} placeholder="bash(git commit*)" onChange={(v) => save((s) => ((s.hooks[kind][i].match = v), s))} />
            </label>
            <label>
              Command
              <TextField label="Command" mono value={rule.command} placeholder="./scripts/check.sh" onChange={(v) => save((s) => ((s.hooks[kind][i].command = v), s))} />
            </label>
            <label>
              Time limit
              <NumberField label="Time limit" value={rule.timeoutSec} min={1} max={600} suffix="s" onChange={(v) => save((s) => ((s.hooks[kind][i].timeoutSec = v ?? 30), s))} />
            </label>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => save((s) => (s.hooks[kind].push({ match: '*', command: '', timeoutSec: 30, enabled: true }), s))}>
        + Add hook
      </button>
    </Section>
  )
  return (
    <>
      <Section
        title="How hooks work"
        description={
          <>
            A hook is a shell command that runs around the agent's tool calls, in the project folder. <b>Match</b> uses the permission rule format (<code>bash(npm *)</code>, <code>edit_file(src/**)</code>), or <code>*</code> for every call. The command gets the call as JSON on stdin and <code>HARNESS_TOOL</code>, <code>HARNESS_SUBJECT</code> and <code>HARNESS_CWD</code> in its environment. Hooks run with your permissions and without asking.
          </>
        }
      />
      {list('preTool', 'Before a tool runs', 'Exit code 2 blocks the call, and what the command printed to stderr is shown to the agent as the reason.')}
      {list('postTool', 'After a tool runs', "What the command prints is added to the tool's result. Exit code 2 adds its stderr as feedback for the agent.")}
    </>
  )
}

// ---------------------------------------------------------------- Permissions

function PermissionsTab({ app, save }: TabProps) {
  const p = app.settings.permissions
  return (
    <>
      <Section title="Default mode" description="The mode new windows start in. Switch any time in the composer or with Shift+Tab.">
        <div className="modes large" role="radiogroup" aria-label="Default permission mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={p.mode === m.id}
              className={`mode mode-${m.id} ${p.mode === m.id ? 'on' : ''}`}
              onClick={() => save((s) => ((s.permissions.mode = m.id), s))}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted small mode-hint">{MODES.find((m) => m.id === p.mode)?.hint}.</p>
      </Section>
      <Section
        title="Rules"
        description={
          <>
            Format: <code>tool</code> or <code>tool(pattern)</code>. For commands <code>*</code> matches anything (<code>bash(npm test*)</code>); for paths <code>*</code> is one folder level and <code>**</code> is any depth (
            <code>edit_file(src/**)</code>). Deny rules win over everything, including Full auto.
          </>
        }
      >
        <Row label="Always allow" wide>
          <ListField label="Always allow" value={p.allow} placeholder="bash(npm test*)" onChange={(v) => save((s) => ((s.permissions.allow = v), s))} />
        </Row>
        <Row label="Always deny" wide>
          <ListField label="Always deny" value={p.deny} placeholder="bash(git push*)" onChange={(v) => save((s) => ((s.permissions.deny = v), s))} />
        </Row>
      </Section>
      <Section title="Safety">
        <Row label="Allow edits outside the project folder" hint="When off, writing outside the workspace always asks, even in Full auto">
          <Toggle label="Allow edits outside the project folder" value={p.allowOutsideWorkspace} onChange={(v) => save((s) => ((s.permissions.allowOutsideWorkspace = v), s))} />
        </Row>
        <Row label="Confirm destructive commands" hint="Asks before rm, git reset --hard, force pushes and similar, even in Full auto. Allow rules you add above still apply.">
          <Toggle label="Confirm destructive commands" value={p.confirmDestructive} onChange={(v) => save((s) => ((s.permissions.confirmDestructive = v), s))} />
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Tools

function ToolsTab({ app, save, onState, onError }: TabProps) {
  const t = app.settings.tools
  const ext = app.extensions
  const disabled = new Set(t.disabled)
  return (
    <>
      <Section title="Tools" description="Turn off tools you don't want the model to use.">
        <div className="tool-list">
          {ext.tools.map((tool) => (
            <div key={tool.name} className="tool-item">
              <Toggle label={`Enable ${tool.name}`} value={!disabled.has(tool.name)} onChange={(on) => save((s) => ((s.tools.disabled = on ? s.tools.disabled.filter((x) => x !== tool.name) : [...s.tools.disabled, tool.name]), s))} />
              <code>{tool.name}</code>
              <span className={`badge ${tool.readOnly && tool.kind !== 'network' ? 'ok' : ''}`}>{tool.kind === 'network' ? 'network' : tool.readOnly ? 'read-only' : tool.kind === 'exec' ? 'runs commands' : tool.kind === 'edit' ? 'edits files' : tool.kind}</span>
              {tool.source !== 'builtin' && <span className="badge">{tool.source}</span>}
              <span className="muted small tool-desc" title={tool.description}>
                {tool.description}
              </span>
            </div>
          ))}
        </div>
        <Row label="Check files after edits" hint="Runs the project's eslint or ruff, or a syntax check, on each edited file and shows the agent any problems.">
          <Toggle label="Check files after edits" value={t.checkAfterEdit} onChange={(v) => save((s) => ((s.tools.checkAfterEdit = v), s))} />
        </Row>
        {t.checkAfterEdit && (
          <Row label="Check time limit" hint="A slower check is stopped, and the agent is told to run it itself.">
            <NumberField label="Check time limit" value={t.checkTimeoutSec} min={5} max={300} suffix="seconds" onChange={(v) => save((s) => ((s.tools.checkTimeoutSec = v ?? 30), s))} />
          </Row>
        )}
      </Section>
      <WebSearchSection app={app} save={save} onState={onState} onError={onError} />
      <Section
        title="Extensions"
        description={
          <>
            Add your own tools (<code>tools/*.mjs</code>) and slash commands (<code>commands/*.md</code>) in <code>{ext.userDir}</code> or <code>.harness/</code> inside a project.
          </>
        }
      >
        <Row label="Load my extensions" hint={ext.userDir}>
          <Toggle label="Load my extensions" value={t.loadUserExtensions} onChange={(v) => save((s) => ((s.tools.loadUserExtensions = v), s))} />
        </Row>
        <Row label="Load project tool code" hint="Runs .harness/tools/*.mjs from the open project. Only enable for projects you trust. (Project commands always load.)">
          <Toggle label="Load project tool code" value={t.loadProjectExtensions} onChange={(v) => save((s) => ((s.tools.loadProjectExtensions = v), s))} />
        </Row>
        <div className="inline">
          <button className="btn" onClick={() => api.extensions.openDir('user')}>
            Open my extensions folder
          </button>
          <button className="btn" disabled={!ext.projectDir} onClick={() => api.extensions.openDir('project')}>
            Open project .harness folder
          </button>
          <button className="btn" onClick={() => api.extensions.reload().then(onState, onError)}>
            Reload
          </button>
        </div>
        {ext.errors.map((e) => (
          <div key={e.file} className="notice notice-error small">
            {e.file}: {e.error}
          </div>
        ))}
        <details className="howto">
          <summary>Example tool and command</summary>
          <pre>{`// ~/.harness/tools/run_tests.mjs
export default {
  name: 'run_tests',
  description: 'Run the project test suite and return a summary',
  parameters: { type: 'object', properties: { filter: { type: 'string' } } },
  kind: 'exec',          // asks permission like bash
  async execute({ filter }, ctx) {
    const { execSync } = await import('node:child_process')
    return execSync(\`npm test -- \${filter ?? ''}\`, { cwd: ctx.cwd, encoding: 'utf8' })
  },
}

<!-- ~/.harness/commands/review.md -->
---
description: Review changes for bugs
---
Review the uncommitted changes (git diff) for bugs and risky code. Focus on: $ARGUMENTS`}</pre>
        </details>
      </Section>
      <Section title="Slash commands">
        <div className="tool-list">
          {ext.commands.map((c) => (
            <div key={c.name} className="tool-item">
              <code>/{c.name}</code>
              <span className="badge">{c.source}</span>
              <span className="muted small tool-desc" title={c.description}>
                {c.description}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Skills"
        description={
          <>
            Instructions the agent loads before a matching task, one folder with a <code>SKILL.md</code> each. Read from <code>skills/</code> in your extensions folder, in the project's <code>.harness/</code> and in <code>~/.claude/skills</code>. The agent saves new ones to your folder after hard, repeatable tasks.
          </>
        }
      >
        {app.skills.length === 0 ? (
          <p className="muted small">No skills yet.</p>
        ) : (
          <div className="tool-list">
            {app.skills.map((s) => (
              <div key={s.dir} className="tool-item">
                <code>{s.name}</code>
                <span className="badge">{s.source === 'claude' ? 'Claude Code' : s.source}</span>
                <span className="muted small tool-desc" title={s.description}>
                  {s.description}
                </span>
                <button className="btn ghost" aria-label={`Open folder of skill ${s.name}`} onClick={() => api.app.openPath(s.dir)}>
                  Open folder
                </button>
                {s.source !== 'claude' && (
                  <button className="btn ghost danger" aria-label={`Delete skill ${s.name}`} onClick={() => confirm(`Delete the skill "${s.name}" and its folder?`) && api.skills.remove(s.dir).then(onState, onError)}>
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- MCP

type McpServer = Settings['mcp']['servers'][number]

/** `npx -y "@scope/server" --flag` → ['npx', '-y', '@scope/server', '--flag'] */
const SEARCH_BACKENDS = [
  { value: 'auto', label: 'Automatic (your free keys first, then keyless)' },
  { value: 'duckduckgo', label: 'Keyless only (DuckDuckGo)' },
  { value: 'brave', label: 'Brave Search API only (free key: 2,000/month)' },
  { value: 'tavily', label: 'Tavily only (free key: 1,000/month)' },
  { value: 'searxng', label: 'SearXNG (your instance)' },
] as const

const SEARCH_KEY_LINKS: Record<string, string> = { brave: 'https://brave.com/search/api/', tavily: 'https://app.tavily.com/' }

function WebSearchSection({ app, save, onState, onError }: TabProps) {
  const ws = app.settings.tools.webSearch
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [url, setUrl] = useState(ws.searxngUrl)
  // In automatic mode both free-tier keys can be added; otherwise only the chosen API's.
  const keyIds = ws.backend === 'auto' ? (['brave', 'tavily'] as const) : ws.backend === 'brave' || ws.backend === 'tavily' ? [ws.backend] : []
  return (
    <Section title="Web search" description="The web_search tool. It works without any key. Free keys from Brave Search or Tavily make it more reliable: in automatic mode they are used first, and the keyless engines take over if they fail or run out.">
      <Row label="Search with">
        <Select label="Search with" value={ws.backend} options={[...SEARCH_BACKENDS]} onChange={(v) => save((s) => ((s.tools.webSearch.backend = v), s))} />
      </Row>
      {keyIds.map((id) => (
        <Row
          key={id}
          label={id === 'brave' ? 'Brave Search key' : 'Tavily key'}
          hint={
            <>
              {ws.backend === 'auto' ? 'Optional. ' : ''}Free tier: {id === 'brave' ? '2,000' : '1,000'} searches a month. Stored in your OS keychain.{' '}
              <button className="link small" onClick={() => api.app.openExternal(SEARCH_KEY_LINKS[id])}>
                Get a key
              </button>
              . {id.toUpperCase()}_API_KEY also works.
            </>
          }
          labelFor={`search-key-${id}`}
        >
          <div className="key-row">
            <input
              id={`search-key-${id}`}
              type="password"
              className="mono"
              autoComplete="off"
              placeholder={app.keys[id] ? '•••••••• (saved)' : 'Paste API key'}
              value={keys[id] ?? ''}
              onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
            />
            <button className="btn primary" disabled={!keys[id]?.trim()} onClick={() => api.keys.set(id, keys[id]).then((st) => (onState(st), setKeys((k) => ({ ...k, [id]: '' }))), onError)}>
              Save
            </button>
            {app.keys[id] && (
              <button className="btn ghost" onClick={() => api.keys.set(id, null).then(onState, onError)}>
                Remove key
              </button>
            )}
          </div>
        </Row>
      ))}
      {ws.backend === 'searxng' && (
        <Row label="SearXNG URL" hint="The instance must allow JSON output (search.formats includes json)." labelFor="searxng-url">
          <input
            id="searxng-url"
            className="mono"
            placeholder="https://searx.example.org"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => url !== ws.searxngUrl && save((s) => ((s.tools.webSearch.searxngUrl = url.trim()), s))}
          />
        </Row>
      )}
    </Section>
  )
}

function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)
const pairs = (rec: Record<string, string>, sep: string) => Object.entries(rec).map(([k, v]) => `${k}${sep}${v}`)
function unpairs(list: string[], sep: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of list) {
    const i = item.indexOf(sep)
    if (i > 0) out[item.slice(0, i).trim()] = item.slice(i + sep.length).trim()
  }
  return out
}

const STATE_TEXT: Record<McpServerStatus['state'], string> = { connecting: 'connecting…', ready: 'connected', error: 'failed', off: 'off' }

function McpTab({ app, save, onState, onError }: TabProps) {
  const servers = app.settings.mcp.servers
  const status = new Map(app.mcp.servers.map((s) => [s.id, s]))
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http', target: '' })
  const tools = app.extensions.tools.filter((t) => t.source === 'mcp')

  const update = (i: number, fn: (s: McpServer) => McpServer) => save((st) => ((st.mcp.servers[i] = fn(st.mcp.servers[i])), st))
  const idFor = (name: string) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server'
    let id = base
    for (let n = 2; servers.some((s) => s.id === id); n++) id = `${base}-${n}`
    return id
  }
  const nameTaken = servers.some((s) => s.name.toLowerCase() === draft.name.trim().toLowerCase())
  const parts = splitCommand(draft.target)
  const valid = draft.name.trim() && !nameTaken && (draft.transport === 'stdio' ? parts.length > 0 : /^https?:\/\/\S+$/.test(draft.target.trim()))
  const add = () => {
    const base = { id: idFor(draft.name), name: draft.name.trim(), enabled: true }
    const server: McpServer =
      draft.transport === 'stdio'
        ? { ...base, transport: 'stdio', command: parts[0], args: parts.slice(1), env: {} }
        : { ...base, transport: 'http', url: draft.target.trim(), headers: {} }
    save((st) => ((st.mcp.servers = [...st.mcp.servers, server]), st))
    setDraft({ name: '', transport: draft.transport, target: '' })
  }
  const presets = MCP_PRESETS.filter((p) => !servers.some((s) => s.transport === 'http' && p.server.transport === 'http' && s.url === p.server.url))

  return (
    <>
      <Section
        title="MCP servers"
        description="Connect tools from Model Context Protocol servers. Their tools work in every chat and follow your permission rules; name them in rules as mcp__<server>__<tool>. Tools a server marks read-only run without asking."
      >
        {servers.length === 0 && <p className="muted small">No servers yet. Add one below.</p>}
        {servers.map((srv, i) => {
          const st = status.get(srv.id)
          const state = st?.state ?? (srv.enabled ? 'connecting' : 'off')
          return (
            <div key={srv.id} className="provider-card">
              <div className="provider-head">
                <Toggle label={`Enable ${srv.name}`} value={srv.enabled} onChange={(v) => update(i, (s) => ({ ...s, enabled: v }))} />
                <b>{srv.name}</b>
                <span className={`badge ${state === 'ready' ? 'ok' : ''}`} role="status">
                  {STATE_TEXT[state]}
                  {state === 'ready' ? ` · ${st?.toolCount ?? 0} ${st?.toolCount === 1 ? 'tool' : 'tools'}` : ''}
                </span>
                <span className="muted small mono mcp-target" title={srv.transport === 'stdio' ? [srv.command, ...srv.args].join(' ') : srv.url}>
                  {srv.transport === 'stdio' ? [srv.command, ...srv.args].map(quote).join(' ') : srv.url}
                </span>
                <div className="spacer" />
                <button className="btn ghost" disabled={!srv.enabled} onClick={() => api.mcp.restart(srv.id).then(onState, onError)}>
                  Restart
                </button>
                <button className="link danger small" onClick={() => confirm(`Remove ${srv.name}?`) && save((st) => ((st.mcp.servers = st.mcp.servers.filter((x) => x.id !== srv.id)), st))}>
                  Remove
                </button>
              </div>
              {state === 'error' && st?.error && <div className="notice notice-error small">{st.error}</div>}
              {srv.transport === 'http' && (
                <Row
                  label="Bearer token"
                  hint={
                    MCP_PRESETS.find((p) => p.server.transport === 'http' && p.server.url === srv.url)?.token?.hint ??
                    'Optional. Sent as Authorization: Bearer …, stored in the keychain like API keys'
                  }
                  labelFor={`mcp-token-${srv.id}`}
                >
                  <div className="key-row">
                    <input
                      id={`mcp-token-${srv.id}`}
                      type="password"
                      className="mono"
                      autoComplete="off"
                      placeholder={app.mcp.tokens[srv.id] ? '•••••••• (saved)' : 'Paste token'}
                      value={tokens[srv.id] ?? ''}
                      onChange={(e) => setTokens((t) => ({ ...t, [srv.id]: e.target.value }))}
                    />
                    <button
                      className="btn primary"
                      disabled={!tokens[srv.id]?.trim()}
                      onClick={() => api.mcp.setToken(srv.id, tokens[srv.id]).then((s) => (onState(s), setTokens((t) => ({ ...t, [srv.id]: '' }))), onError)}
                    >
                      Save
                    </button>
                    {app.mcp.tokens[srv.id] && (
                      <button className="btn ghost" onClick={() => api.mcp.setToken(srv.id, null).then(onState, onError)}>
                        Remove token
                      </button>
                    )}
                  </div>
                </Row>
              )}
              <details className="advanced">
                <summary>Edit</summary>
                {srv.transport === 'stdio' ? (
                  <>
                    <Row label="Command" hint="The program and its arguments" labelFor={`mcp-cmd-${srv.id}`}>
                      <TextField
                        label="Command"
                        id={`mcp-cmd-${srv.id}`}
                        mono
                        value={[srv.command, ...srv.args].map(quote).join(' ')}
                        onChange={(v) => {
                          const p = splitCommand(v)
                          if (p.length) update(i, (s) => ({ ...s, command: p[0], args: p.slice(1) }) as McpServer)
                        }}
                      />
                    </Row>
                    <Row label="Environment" hint="KEY=value, added to the server's environment">
                      <ListField label="Environment" placeholder="API_TOKEN=…" value={pairs(srv.env, '=')} onChange={(v) => update(i, (s) => ({ ...s, env: unpairs(v, '=') }) as McpServer)} />
                    </Row>
                  </>
                ) : (
                  <>
                    <Row label="URL" hint="Streamable HTTP endpoint" labelFor={`mcp-url-${srv.id}`}>
                      <TextField label="URL" id={`mcp-url-${srv.id}`} mono value={srv.url} onChange={(v) => /^https?:\/\//.test(v) && update(i, (s) => ({ ...s, url: v.trim() }) as McpServer)} />
                    </Row>
                    <Row label="Headers" hint="Name: value, sent with every request (not for secrets; use the token field)">
                      <ListField label="Headers" placeholder="X-Workspace: main" value={pairs(srv.headers, ': ')} onChange={(v) => update(i, (s) => ({ ...s, headers: unpairs(v, ':') }) as McpServer)} />
                    </Row>
                  </>
                )}
              </details>
            </div>
          )
        })}
      </Section>
      <Section title="Add a server" description="Local servers run as a command on this computer; remote ones are reached by URL.">
        {presets.map((p) => (
          <div key={p.id} className="mcp-preset">
            <div>
              <b>{p.label}</b>
              <div className="muted small">
                {p.description}
                {p.token && (
                  <>
                    {' '}
                    <button className="link small" onClick={() => api.app.openExternal(p.token!.url)}>
                      Get a token
                    </button>
                  </>
                )}
              </div>
            </div>
            <button className="btn" onClick={() => save((st) => ((st.mcp.servers = [...st.mcp.servers, presetServer(p, st.mcp.servers)]), st))}>
              Add {p.label}
            </button>
          </div>
        ))}
        <div className="custom-provider">
          <label>
            <span className="small muted">Name</span>
            <input placeholder="github" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span className="small muted">Type</span>
            <Select
              label="Server type"
              value={draft.transport}
              options={[
                { value: 'stdio', label: 'Command' },
                { value: 'http', label: 'URL' },
              ]}
              onChange={(v) => setDraft({ ...draft, transport: v })}
            />
          </label>
          <label className="grow">
            <span className="small muted">{draft.transport === 'stdio' ? 'Command' : 'URL'}</span>
            <input
              className="mono"
              placeholder={draft.transport === 'stdio' ? 'npx -y @modelcontextprotocol/server-filesystem ~/Documents' : 'https://example.com/mcp'}
              value={draft.target}
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && valid && add()}
            />
          </label>
          <button className="btn" disabled={!valid} onClick={add}>
            Add
          </button>
        </div>
        {nameTaken && <div className="small warn">A server named "{draft.name.trim()}" already exists.</div>}
      </Section>
      {tools.length > 0 && (
        <Section title="Available MCP tools">
          <div className="tool-list">
            {tools.map((t) => (
              <div key={t.name} className="tool-item">
                <code>{t.name}</code>
                <span className={`badge ${t.readOnly ? 'ok' : ''}`}>{t.readOnly ? 'read-only' : 'asks'}</span>
                <span className="muted small tool-desc" title={t.description}>
                  {t.description.replace(/^\[MCP: [^\]]*\]\s*/, '')}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

// ---------------------------------------------------------------- Memory

function MemoryTab({ app, save, onState, onError }: TabProps) {
  const m = app.settings.memory
  const info = app.memory
  const scopes = [
    { scope: 'project' as const, title: 'This project', facts: info.project, file: info.projectFile, empty: app.workspace ? 'Nothing saved for this folder yet.' : 'Open a folder to see its memories.' },
    { scope: 'global' as const, title: 'All projects', facts: info.global, file: info.globalFile, empty: 'Nothing saved yet.' },
  ]
  return (
    <>
      <Section title="Memory" description="Facts the agent saves with the remember tool, such as your preferences or how to test a project. They're added to every chat. Stored in the app's data folder, never in your project.">
        <Row label="Let the agent remember" hint="When off, saved memories are neither used nor updated">
          <Toggle label="Let the agent remember" value={m.enabled} onChange={(v) => save((s) => ((s.memory.enabled = v), s))} />
        </Row>
        <Row label="Size limit" hint="Characters per list; the agent must remove or merge entries when it's full">
          <NumberField label="Memory size limit" value={m.maxChars} min={500} max={50000} step={500} onChange={(v) => v && save((s) => ((s.memory.maxChars = v), s))} />
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

// ---------------------------------------------------------------- Usage

function UsageTab({ app, save, onState, onError }: TabProps) {
  const u = app.settings.usage
  const sum = app.usage
  const byModel = Object.entries(sum.byModel).sort((a, b) => b[1].cost - a[1].cost || b[1].requests - a[1].requests)
  return (
    <>
      <Section title="Usage" description="Every model request is counted locally. Cost comes from the provider when reported, otherwise from the model's list price. “+” means some requests had unknown cost (e.g. subscription plans).">
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Requests</th>
              <th scope="col">Prompt</th>
              <th scope="col">Completion</th>
              <th scope="col">Cached</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['This chat', sum.session],
                ['Today', sum.today],
                ['All time', sum.allTime],
              ] as const
            ).map(([label, t]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{t.requests}</td>
                <td>{tokens(t.promptTokens)}</td>
                <td>{tokens(t.completionTokens)}</td>
                <td>{tokens(t.cachedTokens)}</td>
                <td>{cost(t.cost, t.costPartial)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {byModel.length > 0 && (
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">By model</th>
                <th scope="col">Requests</th>
                <th scope="col">Prompt</th>
                <th scope="col">Completion</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map(([k, t]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{t.requests}</td>
                  <td>{tokens(t.promptTokens)}</td>
                  <td>{tokens(t.completionTokens)}</td>
                  <td>{cost(t.cost, t.costPartial)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="inline">
          <button className="btn" onClick={() => api.usage.exportCsv().catch(onError)}>
            Export CSV
          </button>
          <button className="btn ghost danger" onClick={() => confirm('Delete all usage history?') && api.usage.clear().then(onState, onError)}>
            Clear history
          </button>
        </div>
      </Section>
      <Section title="Display">
        <Row label="Show cost">
          <Toggle label="Show cost" value={u.showCost} onChange={(v) => save((s) => ((s.usage.showCost = v), s))} />
        </Row>
        <Row label="Show last request usage in status bar">
          <Toggle label="Show last request usage in status bar" value={u.showPerMessageUsage} onChange={(v) => save((s) => ((s.usage.showPerMessageUsage = v), s))} />
        </Row>
      </Section>
      <Section title="Budgets" description="Guard rails against runaway spending. Empty = no limit.">
        <Row label="Per-chat budget">
          <NumberField label="Per-chat budget" nullable value={u.sessionBudgetUsd} min={0} step={0.5} placeholder="no limit" suffix="USD" onChange={(v) => save((s) => ((s.usage.sessionBudgetUsd = v), s))} />
        </Row>
        <Row label="Daily budget">
          <NumberField label="Daily budget" nullable value={u.dailyBudgetUsd} min={0} step={1} placeholder="no limit" suffix="USD" onChange={(v) => save((s) => ((s.usage.dailyBudgetUsd = v), s))} />
        </Row>
        <Row label="When reached">
          <Select label="When reached" value={u.budgetAction} options={[{ value: 'warn', label: 'Warn and continue' }, { value: 'stop', label: 'Stop the agent' }]} onChange={(v) => save((s) => ((s.usage.budgetAction = v), s))} />
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Appearance

function AppearanceTab({ app, save }: TabProps) {
  const a = app.settings.appearance
  return (
    <Section title="Appearance">
      <Row label="Theme">
        <Select label="Theme" value={a.theme} options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'oled', label: 'OLED black' }, { value: 'sepia', label: 'Sepia' }, { value: 'contrast', label: 'High contrast' }]} onChange={(v) => save((s) => ((s.appearance.theme = v), s))} />
      </Row>
      <Row label="Font size">
        <Slider label="Font size" value={a.fontSize} min={11} max={20} step={1} format={(v) => `${v}px`} onChange={(v) => save((s) => ((s.appearance.fontSize = v), s))} />
      </Row>
      <Row label="Code font">
        <TextField label="Code font" mono value={a.codeFontFamily} onChange={(v) => save((s) => ((s.appearance.codeFontFamily = v), s))} />
      </Row>
      <Row label="Density">
        <Select label="Density" value={a.density} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} onChange={(v) => save((s) => ((s.appearance.density = v), s))} />
      </Row>
      <Row label="Expand tool calls by default" hint="Diffs are always expanded">
        <Toggle label="Expand tool calls by default" value={a.expandToolCalls} onChange={(v) => save((s) => ((s.appearance.expandToolCalls = v), s))} />
      </Row>
      <Row label="Show model reasoning" hint="For thinking models that stream their reasoning">
        <Toggle label="Show model reasoning" value={a.showReasoning} onChange={(v) => save((s) => ((s.appearance.showReasoning = v), s))} />
      </Row>
      <Row label="Enter sends message" hint={`Off: Enter adds a newline, ${app.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter'} sends`}>
        <Toggle label="Enter sends message" value={a.sendWithEnter} onChange={(v) => save((s) => ((s.appearance.sendWithEnter = v), s))} />
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Data

function DataTab({ app, save, onState, onError, update }: TabProps & { update: UpdateStatus }) {
  return (
    <>
      <Section title="Storage">
        <Row label="Data folder" hint={app.paths.data}>
          <button className="btn" onClick={() => api.app.openPath(app.paths.data)}>
            Open
          </button>
        </Row>
        <Row label="Chats" hint={`${app.sessions.length} in this folder`}>
          <button className="btn ghost danger" onClick={() => confirm('Delete ALL chats in every folder? This cannot be undone.') && api.sessions.removeAll().then(onState, onError)}>
            Delete all chats
          </button>
        </Row>
      </Section>
      <Section title="Settings file" description="Share a setup with your team: export, commit it somewhere, and import on other machines. API keys are never included.">
        <div className="inline">
          <button className="btn" onClick={() => api.settings.export().catch(onError)}>
            Export settings…
          </button>
          <button className="btn" onClick={() => api.settings.import().then((s) => s && onState(s), onError)}>
            Import settings…
          </button>
          <button className="btn ghost danger" onClick={() => confirm('Reset all settings to defaults? API keys are kept.') && api.settings.reset().then(onState, onError)}>
            Reset to defaults
          </button>
        </div>
      </Section>
      <Section title="Background chats">
        <Row label="Notify me" hint="A system notification when a chat you're not looking at finishes or needs approval">
          <Toggle label="Notify me about background chats" value={app.settings.app.notifications} onChange={(v) => save((s) => ((s.app.notifications = v), s))} />
        </Row>
      </Section>
      <Section title="Updates">
        <Row label="Check for updates automatically" hint="Downloads new versions from GitHub Releases">
          <Toggle label="Check for updates automatically" value={app.settings.app.autoUpdate} onChange={(v) => save((s) => ((s.app.autoUpdate = v), s))} />
        </Row>
        <Row label={`Version ${app.version}`} hint={updateText(update)}>
          {update.state === 'manual' && (
            <button className="btn" onClick={() => api.app.openExternal(update.url)}>
              Download {update.version}
            </button>
          )}
          <button className="btn" onClick={() => api.app.checkForUpdates()}>
            Check now
          </button>
        </Row>
      </Section>
    </>
  )
}

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'checking':
      return 'Checking…'
    case 'none':
      return 'You are up to date.'
    case 'available':
      return `Version ${u.version} available, downloading…`
    case 'downloading':
      return `Downloading… ${u.percent ?? 0}%`
    case 'ready':
      return `Version ${u.version} ready — restart to install.`
    case 'manual':
      return `Version ${u.version} is available. This build can't install updates itself, so download it from GitHub.`
    case 'error':
      return u.message
    default:
      return ''
  }
}
