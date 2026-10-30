import { useEffect, useRef, useState } from 'react'
import type { AppState, PermissionMode, ProviderTestResult, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import mark from '../assets/mark.png'
import { Toggle } from './fields'
import { LayoutPicker, withLayout } from './LayoutPicker'
import { EXPERIENCE_LABELS, PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES, ROLE_LABELS, ShareInfoText, USE_LABELS, languageOptions } from './profile'
import { ProviderLogo } from './ProviderLogo'
import { KEY_LINKS, ModelChoice, SecretInput, refText } from './settings/common'
import { THEMES } from './settings/pages/general'

// First run: a welcome screen, then four short steps. Every answer is saved as it's given, so
// quitting halfway keeps what was chosen. Setup ends with `app.onboarded`, set on Done.

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}

const STEPS = [
  { id: 'about', label: 'About you' },
  { id: 'provider', label: 'Model' },
  { id: 'how', label: 'How it works' },
  { id: 'done', label: 'Done' },
] as const

type StepId = (typeof STEPS)[number]['id']



/** The modes first-run setup offers, explained plainly. Auto-edit stays in the message box and Settings. */
const MODE_CHOICES: { id: PermissionMode; label: string; text: string }[] = [
  { id: 'ask', label: 'Ask', text: 'Asks you before it edits a file or runs a command. Best to start with.' },
  { id: 'auto', label: 'Auto', text: 'Works without asking. It still asks before deleting files, force pushes and other destructive commands.' },
  { id: 'plan', label: 'Plan', text: 'Only reads your project and writes a plan. Nothing is changed until you switch modes.' },
]

/** Where models come from: free and local options first. Other providers are in the list below them. */
const PROVIDER_CHOICES: { id: string; badge: string; text: string }[] = [
  { id: 'openrouter', badge: 'Free models', text: 'Hundreds of models, many of them free. Needs a free key.' },
  { id: 'ollama-cloud', badge: 'Free tier', text: 'Open models in the cloud. Needs a free key.' },
  { id: 'ollama-local', badge: 'Local', text: 'Runs models on this computer with Ollama. No key.' },
  { id: 'lmstudio', badge: 'Local', text: 'Runs models on this computer with LM Studio. No key.' },
]
const FREE_TIER = new Set(['google', 'groq', 'cerebras'])

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Onboarding({ app, onState, onError }: Props) {
  const [started, setStarted] = useState(false)
  const [step, setStep] = useState(0)
  /** The step "Skip setup" was pressed on, if it was. */
  const [skippedAt, setSkippedAt] = useState<StepId | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const latest = useRef(app.settings)
  latest.current = app.settings

  /** Saves one answer on top of the newest settings. */
  const save = (fn: (s: Settings) => void) => {
    const next = structuredClone(latest.current)
    fn(next)
    latest.current = next
    return api.settings.set(next).then(onState, onError)
  }

  useEffect(() => {
    if (started) heading.current?.focus()
  }, [step, started])

  const id = STEPS[step].id
  const go = (i: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, i)))
  const skipAll = () => {
    setSkippedAt(id)
    go(STEPS.length - 1)
  }
  const finish = () => {
    void api.app.track(skippedAt ? { type: 'onboarding', outcome: 'skipped', step: skippedAt } : { type: 'onboarding', outcome: 'finished', step: 'done' }).catch(() => {})
    save((s) => (s.app.onboarded = true))
  }

  if (!started)
    return (
      <div className="onboard onboard-welcome">
        <div className="onboard-drag" />
        <div className="onboard-hello">
          <img className="welcome-mark" src={mark} alt="" width={96} height={76} />
          <h1>Xarı Bülbül</h1>
          <p className="muted">An AI coding agent that works in your project, with any model you like.</p>
          <button className="btn primary onboard-start" autoFocus onClick={() => setStarted(true)}>
            Start
          </button>
        </div>
      </div>
    )

  return (
    <div className="onboard">
      <div className="onboard-drag" />
      <div className="onboard-frame">
        <header className="onboard-head">
          <ol className="onboard-progress" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className={i < step ? 'done' : i === step ? 'on' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="onboard-bar" aria-hidden />
                <span className="onboard-step-label">
                  <span className="sr-only">{`Step ${i + 1} of ${STEPS.length}: `}</span>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
          {id !== 'done' && (
            <button className="link small" onClick={skipAll}>
              Skip setup
            </button>
          )}
        </header>

        <main className="onboard-body" aria-labelledby="onboard-h">
          {id === 'about' && <AboutStep app={app} save={save} heading={heading} />}
          {id === 'provider' && <ProviderStep app={app} save={save} heading={heading} onState={onState} onError={onError} />}
          {id === 'how' && <HowStep app={app} save={save} heading={heading} />}
          {id === 'done' && <DoneStep app={app} save={save} heading={heading} />}
        </main>

        <footer className="onboard-foot">
          {step > 0 ? (
            <button className="btn ghost" onClick={() => go(step - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          {id === 'done' ? (
            <button className="btn primary" onClick={finish}>
              Start using Xarı Bülbül
            </button>
          ) : (
            <button className="btn primary" onClick={() => go(step + 1)}>
              Next
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

interface StepProps {
  app: AppState
  save: (fn: (s: Settings) => void) => Promise<void>
  heading: React.RefObject<HTMLHeadingElement | null>
}

function StepTitle({ heading, title, text }: { heading: StepProps['heading']; title: string; text: string }) {
  return (
    <>
      <h2 id="onboard-h" ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <p className="muted">{text}</p>
    </>
  )
}

/** A row of native radio buttons drawn as chips: arrow keys move, Tab leaves. */
function ChoiceChips<T extends string>({ legend, name, options, value, onChange }: { legend: string; name: string; options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void }) {
  return (
    <fieldset className="onboard-field">
      <legend>{legend}</legend>
      <div className="choice-chips">
        {options.map((o) => (
          <label key={o.value} className={`choice-chip ${value === o.value ? 'on' : ''}`}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

// ---------------------------------------------------------------- About you

function AboutStep({ app, save, heading }: StepProps) {
  const p = app.settings.profile
  const [name, setName] = useState(p.name)
  const commitName = () => name.trim() !== p.name && save((s) => (s.profile.name = name.trim()))
  return (
    <>
      <StepTitle heading={heading} title="About you" text="So the agent can pitch its answers to you. Every question is optional." />
      <div className="onboard-field">
        <label htmlFor="ob-name">What should the agent call you?</label>
        <input id="ob-name" value={name} maxLength={80} autoComplete="given-name" placeholder="Your name" onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && commitName()} />
      </div>
      <ChoiceChips legend="What do you do?" name="ob-role" value={p.role} options={PROFILE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} onChange={(v) => save((s) => (s.profile.role = v))} />
      <ChoiceChips legend="How much coding experience do you have?" name="ob-exp" value={p.experience} options={PROFILE_EXPERIENCE.map((r) => ({ value: r, label: EXPERIENCE_LABELS[r] }))} onChange={(v) => save((s) => (s.profile.experience = v))} />
      <fieldset className="onboard-field">
        <legend>What will you mostly use it for?</legend>
        <div className="choice-chips">
          {PROFILE_USES.map((u) => {
            const on = p.uses.includes(u)
            return (
              <label key={u} className={`choice-chip ${on ? 'on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => save((s) => (s.profile.uses = on ? s.profile.uses.filter((x) => x !== u) : PROFILE_USES.filter((x) => x === u || s.profile.uses.includes(x))))} />
                {USE_LABELS[u]}
              </label>
            )
          })}
        </div>
      </fieldset>
    </>
  )
}

// ---------------------------------------------------------------- Provider + model

function ProviderStep({ app, save, heading, onState, onError }: StepProps & Pick<Props, 'onState' | 'onError'>) {
  const presets = app.providerPresets
  const others = app.settings.providers.filter((p) => !PROVIDER_CHOICES.some((c) => c.id === p.id))
  const firstReady = [...PROVIDER_CHOICES.map((c) => c.id), ...others.map((p) => p.id)].find((id) => app.ready[id])
  const [chosen, setChosen] = useState(firstReady ?? 'openrouter')
  const [test, setTest] = useState<ProviderTestResult | 'running' | null>(null)
  const config = app.settings.providers.find((p) => p.id === chosen)
  const preset = presets.find((p) => p.id === chosen)
  const name = config?.name ?? preset?.name ?? chosen
  const anyReady = Object.values(app.ready).some(Boolean)
  const def = app.settings.models.default

  /** After a provider connects, point the default model at it unless the default already works. */
  const pickDefault = async (id: string) => {
    if (def.providerId === id || app.ready[def.providerId]) return
    try {
      const models = await api.models.list(id)
      const m = models.find((x) => x.free && x.supportsTools) ?? models.find((x) => x.supportsTools) ?? models[0]
      if (m) await save((s) => (s.models.default = { providerId: id, modelId: m.id }))
    } catch {
      /* the user can choose below */
    }
  }

  const runTest = (id: string) => {
    setTest('running')
    api.providers.test(id).then(
      (r) => {
        setTest(r)
        if (r.ok) void pickDefault(id)
      },
      (e) => setTest({ ok: false, message: clean(e) }),
    )
  }

  const choose = (id: string) => {
    setChosen(id)
    setTest(null)
    // A local server is added (turned on) when chosen, so it can be tested.
    const p = presets.find((x) => x.id === id)
    if (p && !app.settings.providers.some((x) => x.id === id))
      void save((s) => (s.providers = [...s.providers, { ...p, enabled: true, headers: {}, requestUsageCost: false, api: 'openai' as const }]))
  }

  const otherValue = PROVIDER_CHOICES.some((c) => c.id === chosen) ? '' : chosen
  return (
    <>
      <StepTitle heading={heading} title="Connect a model" text="Pick where your models come from. Free and local options are first. You can add more later in Settings › Providers." />
      <fieldset className="onboard-field">
        <legend className="sr-only">Provider</legend>
        <div className="provider-choices">
          {PROVIDER_CHOICES.map((c) => {
            const label = app.settings.providers.find((p) => p.id === c.id)?.name ?? presets.find((p) => p.id === c.id)?.name ?? c.id
            const on = chosen === c.id
            return (
              <label key={c.id} className={`provider-choice ${on ? 'on' : ''}`}>
                <input type="radio" name="ob-provider" checked={on} onChange={() => choose(c.id)} />
                <ProviderLogo id={c.id} name={label} size={20} />
                <span className="provider-choice-text">
                  <b>
                    {label} <span className={`badge ${c.badge === 'Local' ? '' : 'ok'}`}>{c.badge}</span>
                    {app.ready[c.id] && <span className="badge">connected</span>}
                  </b>
                  <span className="muted small">{c.text}</span>
                </span>
              </label>
            )
          })}
        </div>
        <div className="onboard-other">
          <label htmlFor="ob-other">Another provider</label>
          <select id="ob-other" value={otherValue} onChange={(e) => e.target.value && choose(e.target.value)}>
            <option value="">Choose…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {FREE_TIER.has(p.id) ? ' (free tier)' : ''}
                {app.ready[p.id] ? ' · connected' : ''}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <section className="onboard-connect" aria-label={`Connect ${name}`}>
        {config?.requiresKey ? (
          <>
            <label htmlFor={`ob-key-${chosen}`}>{name} API key</label>
            <SecretInput
              id={`ob-key-${chosen}`}
              label={`${name} API key`}
              saved={!!app.keys[chosen]}
              placeholder={`Paste ${name} key`}
              onSave={(v) =>
                api.keys.set(chosen, v).then((s) => {
                  onState(s)
                  runTest(chosen)
                }, onError)
              }
            />
            <p className="muted small">
              Stored in your system keychain.{' '}
              {KEY_LINKS[chosen] && (
                <button className="link small" onClick={() => api.app.openExternal(KEY_LINKS[chosen])}>
                  Get a {name} key ↗
                </button>
              )}
            </p>
          </>
        ) : (
          <p className="muted small">No key needed. Start {name} on this computer, then test the connection.</p>
        )}
        <div className="inline">
          <button className="btn" disabled={test === 'running' || (config?.requiresKey && !app.keys[chosen]) || !config} onClick={() => runTest(chosen)}>
            {test === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          {app.ready[chosen] && !test && <span className="small okc">Ready to use.</span>}
        </div>
        <p className={`small ${test && test !== 'running' ? (test.ok ? 'okc' : 'warn') : ''}`} role="status">
          {test && test !== 'running' ? test.message : ''}
        </p>
      </section>

      <div className="onboard-field">
        <div className="onboard-label" id="ob-model-l">
          Default model
        </div>
        {anyReady ? (
          <div role="group" aria-labelledby="ob-model-l">
            <ModelChoice app={app} value={app.ready[def.providerId] ? def : null} empty="Choose a model…" required title="Default model for new chats…" onChange={(r) => r && save((s) => (s.models.default = r))} onState={onState} onError={onError} />
            {app.ready[def.providerId] && <p className="muted small">New chats start with {refText(def)}. You can switch models in any chat.</p>}
          </div>
        ) : (
          <p className="muted small">Connect a provider first. You can also skip this and do it later.</p>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- How it works

function HowStep({ app, save, heading }: StepProps) {
  const s = app.settings
  const setMode = (mode: PermissionMode) => {
    void save((x) => (x.permissions.mode = mode))
    void api.agent.setMode(mode).catch(() => {})
  }
  return (
    <>
      <StepTitle heading={heading} title="How it works" text="A few choices about how the app looks and how the agent works. All of them are in Settings later." />
      <div className="onboard-field">
        <div className="onboard-label" id="ob-layout-l">
          Layout
        </div>
        <LayoutPicker value={s.appearance.layout} onChange={(v) => save((x) => Object.assign(x, withLayout(x, v)))} />
      </div>
      <fieldset className="onboard-field">
        <legend>When the agent wants to change something</legend>
        <div className="mode-choices">
          {MODE_CHOICES.map((m) => (
            <label key={m.id} className={`mode-choice ${s.permissions.mode === m.id ? 'on' : ''}`}>
              <input type="radio" name="ob-mode" checked={s.permissions.mode === m.id} onChange={() => setMode(m.id)} />
              <span>
                <b>{m.label}</b>
                <span className="muted small">{m.text}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="muted small">You can switch modes in any chat with Shift+Tab.</p>
      </fieldset>
      <div className="onboard-row">
        <label htmlFor="ob-theme">Theme</label>
        <select id="ob-theme" value={s.appearance.theme} onChange={(e) => save((x) => (x.appearance.theme = e.target.value as Settings['appearance']['theme']))}>
          {THEMES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="onboard-row">
        <span>
          <label htmlFor="ob-lang">Reply language</label>
          <span className="muted small">The language the agent answers in. The app itself stays in English.</span>
        </span>
        <SelectById id="ob-lang" value={s.profile.language} options={languageOptions(s.profile.language)} onChange={(v) => save((x) => (x.profile.language = v))} />
      </div>
      <div className="onboard-row">
        <span>
          <span id="ob-voice-l">Voice input</span>
          <span className="muted small">A mic button in the message box for dictating. Choose how speech becomes text in Settings › Voice.</span>
        </span>
        <Toggle label="Voice input" value={s.voice.enabled} onChange={(v) => save((x) => (x.voice.enabled = v))} />
      </div>
    </>
  )
}

/** `Select` with an id, so a visible <label> names it. */
function SelectById({ id, value, options, onChange }: { id: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------- Done

function DoneStep({ app, save, heading }: StepProps) {
  const s = app.settings
  const p = s.profile
  const def = s.models.default
  const rows: [string, string][] = [
    ['Name', p.name || 'Not set'],
    ['Model', app.ready[def.providerId] ? refText(def) : 'Not connected yet'],
    ['Layout', s.appearance.layout === 'elite' ? 'Elite' : 'Basic'],
    ['Mode', MODE_CHOICES.find((m) => m.id === s.permissions.mode)?.label ?? s.permissions.mode],
    ['Theme', THEMES.find((t) => t.value === s.appearance.theme)?.label ?? s.appearance.theme],
    ['Reply language', p.language || 'Same as my messages'],
    ['Voice input', s.voice.enabled ? 'On' : 'Off'],
  ]
  return (
    <>
      <StepTitle heading={heading} title="You're set" text="Here's what you chose. Change any of it in Settings." />
      <dl className="onboard-summary">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <section className="share-info" aria-labelledby="ob-share-l">
        <div className="share-info-head">
          <span id="ob-share-l">
            <b>Share anonymous usage info</b>
            <span className="muted small">Helps fix crashes and decide what to build next.</span>
          </span>
          <Toggle label="Share anonymous usage info" value={s.privacy.shareUsage} onChange={(v) => save((x) => (x.privacy.shareUsage = v))} />
        </div>
        <ShareInfoText />
        <p className="muted small">Change this any time in Settings › About › Privacy.</p>
      </section>
      {!app.ready[def.providerId] && <p className="small warn">No model is connected yet. Add one later in Settings › Providers, or go Back.</p>}
    </>
  )
}
