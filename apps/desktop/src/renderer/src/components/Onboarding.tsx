import { useEffect, useRef, useState } from 'react'
import type { AppState, PermissionMode, ProviderTestResult, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import mark from '../assets/mark.png'
import { Toggle } from './fields'
import { LayoutPicker, withLayout } from './LayoutPicker'
import { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES, ShareInfoText, experienceLabels, languageOptions, purposeLabels, roleLabels } from './profile'
import { ProviderLogo } from './ProviderLogo'
import { KEY_LINKS, ModelChoice, SecretInput, refText } from './settings/common'

// First run: a welcome screen, then four short steps. Every answer is saved as it's given, so
// quitting halfway keeps what was chosen. Setup ends with `app.onboarded`, set on Done.

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}

type T = ReturnType<typeof useT>['t']

const STEP_IDS = ['about', 'provider', 'how', 'done'] as const
type StepId = (typeof STEP_IDS)[number]

const stepLabels = (t: T): Record<StepId, string> => ({
  about: t('bots.onboard.step.about'),
  provider: t('bots.onboard.step.provider'),
  how: t('bots.onboard.step.how'),
  done: t('common.done'),
})

/** The modes first-run setup offers, explained plainly. Auto-edit stays in the message box and Settings. */
const modeChoices = (t: T): { id: PermissionMode; label: string; text: string }[] => [
  { id: 'ask', label: t('bots.onboard.mode.ask'), text: t('bots.onboard.mode.askText') },
  { id: 'auto', label: t('bots.onboard.mode.auto'), text: t('bots.onboard.mode.autoText') },
  { id: 'plan', label: t('bots.onboard.mode.plan'), text: t('bots.onboard.mode.planText') },
]

/** Where models come from: free and local options first. Other providers are in the list below them. */
const PROVIDER_IDS = ['openrouter', 'ollama-cloud', 'ollama-local', 'lmstudio']
const providerChoices = (t: T): { id: string; badge: string; local: boolean; text: string }[] => [
  { id: 'openrouter', badge: t('bots.onboard.badge.freeModels'), local: false, text: t('bots.onboard.provider.openrouter') },
  { id: 'ollama-cloud', badge: t('bots.onboard.badge.freeTier'), local: false, text: t('bots.onboard.provider.ollamaCloud') },
  { id: 'ollama-local', badge: t('bots.onboard.badge.local'), local: true, text: t('bots.onboard.provider.ollamaLocal') },
  { id: 'lmstudio', badge: t('bots.onboard.badge.local'), local: true, text: t('bots.onboard.provider.lmstudio') },
]

type Theme = Settings['appearance']['theme']
const themes = (t: T): { value: Theme; label: string }[] => [
  { value: 'system', label: t('bots.onboard.theme.system') },
  { value: 'dark', label: t('bots.onboard.theme.dark') },
  { value: 'light', label: t('bots.onboard.theme.light') },
  { value: 'oled', label: t('bots.onboard.theme.oled') },
  { value: 'sepia', label: t('bots.onboard.theme.sepia') },
  { value: 'contrast', label: t('bots.onboard.theme.contrast') },
]
const FREE_TIER = new Set(['google', 'groq', 'cerebras'])

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Onboarding({ app, onState, onError }: Props) {
  const { t } = useT()
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

  const id = STEP_IDS[step]
  const labels = stepLabels(t)
  const go = (i: number) => setStep(Math.max(0, Math.min(STEP_IDS.length - 1, i)))
  const skipAll = () => {
    setSkippedAt(id)
    go(STEP_IDS.length - 1)
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
          <p className="muted">{t('bots.welcome.tagline')}</p>
          <button className="btn primary onboard-start" autoFocus onClick={() => setStarted(true)}>
            {t('bots.onboard.start')}
          </button>
        </div>
      </div>
    )

  return (
    <div className="onboard">
      <div className="onboard-drag" />
      <div className="onboard-frame">
        <header className="onboard-head">
          <ol className="onboard-progress" aria-label={t('bots.onboard.steps')}>
            {STEP_IDS.map((s, i) => (
              <li key={s} className={i < step ? 'done' : i === step ? 'on' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="onboard-bar" aria-hidden />
                <span className="onboard-step-label" title={labels[s]}>
                  <span className="sr-only">{`${t('bots.onboard.stepOf', { n: i + 1, total: STEP_IDS.length })} `}</span>
                  {labels[s]}
                </span>
              </li>
            ))}
          </ol>
          {id !== 'done' && (
            <button className="link small" onClick={skipAll}>
              {t('bots.onboard.skip')}
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
              {t('common.back')}
            </button>
          ) : (
            <span />
          )}
          {id === 'done' ? (
            <button className="btn primary" onClick={finish}>
              {t('bots.onboard.finish')}
            </button>
          ) : (
            <button className="btn primary" onClick={() => go(step + 1)}>
              {t('bots.onboard.next')}
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
  const { t } = useT()
  const roles = roleLabels(t)
  const levels = experienceLabels(t)
  const purposes = purposeLabels(t)
  const p = app.settings.profile
  const [name, setName] = useState(p.name)
  const commitName = () => name.trim() !== p.name && save((s) => (s.profile.name = name.trim()))
  return (
    <>
      <StepTitle heading={heading} title={t('bots.onboard.step.about')} text={t('bots.onboard.aboutText')} />
      <div className="onboard-field">
        <label htmlFor="ob-name">{t('bots.onboard.nameLabel')}</label>
        <input id="ob-name" value={name} maxLength={80} autoComplete="given-name" placeholder={t('bots.onboard.namePlaceholder')} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && commitName()} />
      </div>
      <ChoiceChips legend={t('bots.onboard.role')} name="ob-role" value={p.role} options={PROFILE_ROLES.map((r) => ({ value: r, label: roles[r] }))} onChange={(v) => save((s) => (s.profile.role = v))} />
      <ChoiceChips legend={t('bots.onboard.experience')} name="ob-exp" value={p.experience} options={PROFILE_EXPERIENCE.map((r) => ({ value: r, label: levels[r] }))} onChange={(v) => save((s) => (s.profile.experience = v))} />
      <fieldset className="onboard-field">
        <legend>{t('bots.onboard.uses')}</legend>
        <div className="choice-chips">
          {PROFILE_USES.map((u) => {
            const on = p.uses.includes(u)
            return (
              <label key={u} className={`choice-chip ${on ? 'on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => save((s) => (s.profile.uses = on ? s.profile.uses.filter((x) => x !== u) : PROFILE_USES.filter((x) => x === u || s.profile.uses.includes(x))))} />
                {purposes[u]}
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
  const { t } = useT()
  const presets = app.providerPresets
  const others = app.settings.providers.filter((p) => !PROVIDER_IDS.includes(p.id))
  const firstReady = [...PROVIDER_IDS, ...others.map((p) => p.id)].find((id) => app.ready[id])
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

  const otherValue = PROVIDER_IDS.includes(chosen) ? '' : chosen
  const otherLabel = (p: { id: string; name: string }) => {
    const named = FREE_TIER.has(p.id) ? t('bots.onboard.withFreeTier', { name: p.name }) : p.name
    return app.ready[p.id] ? t('bots.onboard.withConnected', { name: named }) : named
  }
  return (
    <>
      <StepTitle heading={heading} title={t('bots.welcome.connect')} text={t('bots.onboard.providerText')} />
      <fieldset className="onboard-field">
        <legend className="sr-only">{t('bots.onboard.provider')}</legend>
        <div className="provider-choices">
          {providerChoices(t).map((c) => {
            const label = app.settings.providers.find((p) => p.id === c.id)?.name ?? presets.find((p) => p.id === c.id)?.name ?? c.id
            const on = chosen === c.id
            return (
              <label key={c.id} className={`provider-choice ${on ? 'on' : ''}`}>
                <input type="radio" name="ob-provider" checked={on} onChange={() => choose(c.id)} />
                <ProviderLogo id={c.id} name={label} size={20} />
                <span className="provider-choice-text">
                  <b>
                    {label} <span className={`badge ${c.local ? '' : 'ok'}`}>{c.badge}</span>
                    {app.ready[c.id] && <span className="badge">{t('bots.onboard.connected')}</span>}
                  </b>
                  <span className="muted small">{c.text}</span>
                </span>
              </label>
            )
          })}
        </div>
        <div className="onboard-other">
          <label htmlFor="ob-other">{t('bots.onboard.other')}</label>
          <select id="ob-other" value={otherValue} onChange={(e) => e.target.value && choose(e.target.value)}>
            <option value="">{t('bots.dialog.choose')}</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {otherLabel(p)}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <section className="onboard-connect" aria-label={t('bots.onboard.connectNamed', { name })}>
        {config?.requiresKey ? (
          <>
            <label htmlFor={`ob-key-${chosen}`}>{t('bots.onboard.keyLabel', { name })}</label>
            <SecretInput
              id={`ob-key-${chosen}`}
              label={t('bots.onboard.keyLabel', { name })}
              saved={!!app.keys[chosen]}
              placeholder={t('bots.onboard.keyPlaceholder', { name })}
              onSave={(v) =>
                api.keys.set(chosen, v).then((s) => {
                  onState(s)
                  runTest(chosen)
                }, onError)
              }
            />
            <p className="muted small">
              {t('bots.onboard.keychain')}{' '}
              {KEY_LINKS[chosen] && (
                <button className="link small" onClick={() => api.app.openExternal(KEY_LINKS[chosen])}>
                  {t('bots.onboard.getKey', { name })} ↗
                </button>
              )}
            </p>
          </>
        ) : (
          <p className="muted small">{t('bots.onboard.noKey', { name })}</p>
        )}
        <div className="inline">
          <button className="btn" disabled={test === 'running' || (config?.requiresKey && !app.keys[chosen]) || !config} onClick={() => runTest(chosen)}>
            {test === 'running' ? t('bots.onboard.testing') : t('bots.onboard.test')}
          </button>
          {app.ready[chosen] && !test && <span className="small okc">{t('bots.onboard.ready')}</span>}
        </div>
        <p className={`small ${test && test !== 'running' ? (test.ok ? 'okc' : 'warn') : ''}`} role="status">
          {test && test !== 'running' ? test.message : ''}
        </p>
      </section>

      <div className="onboard-field">
        <div className="onboard-label" id="ob-model-l">
          {t('bots.dialog.defaultModel')}
        </div>
        {anyReady ? (
          <div role="group" aria-labelledby="ob-model-l">
            <ModelChoice app={app} value={app.ready[def.providerId] ? def : null} empty={t('bots.onboard.chooseModel')} required title={t('bots.onboard.modelTitle')} onChange={(r) => r && save((s) => (s.models.default = r))} onState={onState} onError={onError} />
            {app.ready[def.providerId] && <p className="muted small">{t('bots.onboard.newChats', { model: refText(def) })}</p>}
          </div>
        ) : (
          <p className="muted small">{t('bots.onboard.connectFirst')}</p>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- How it works

function HowStep({ app, save, heading }: StepProps) {
  const { t, lang } = useT()
  const s = app.settings
  const setMode = (mode: PermissionMode) => {
    void save((x) => (x.permissions.mode = mode))
    void api.agent.setMode(mode).catch(() => {})
  }
  return (
    <>
      <StepTitle heading={heading} title={t('bots.onboard.step.how')} text={t('bots.onboard.howText')} />
      <div className="onboard-field">
        <div className="onboard-label" id="ob-layout-l">
          {t('bots.onboard.layout')}
        </div>
        <LayoutPicker value={s.appearance.layout} onChange={(v) => save((x) => Object.assign(x, withLayout(x, v)))} />
      </div>
      <fieldset className="onboard-field">
        <legend>{t('bots.onboard.modeLegend')}</legend>
        <div className="mode-choices">
          {modeChoices(t).map((m) => (
            <label key={m.id} className={`mode-choice ${s.permissions.mode === m.id ? 'on' : ''}`}>
              <input type="radio" name="ob-mode" checked={s.permissions.mode === m.id} onChange={() => setMode(m.id)} />
              <span>
                <b>{m.label}</b>
                <span className="muted small">{m.text}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="muted small">{t('bots.onboard.shiftTab')}</p>
      </fieldset>
      <div className="onboard-row">
        <label htmlFor="ob-theme">{t('bots.onboard.theme')}</label>
        <select id="ob-theme" value={s.appearance.theme} onChange={(e) => save((x) => (x.appearance.theme = e.target.value as Settings['appearance']['theme']))}>
          {themes(t).map((th) => (
            <option key={th.value} value={th.value}>
              {th.label}
            </option>
          ))}
        </select>
      </div>
      <div className="onboard-row">
        <span>
          <label htmlFor="ob-lang">{t('bots.onboard.replyLanguage')}</label>
          <span className="muted small">{t('bots.onboard.replyLanguageHint')}</span>
        </span>
        <SelectById id="ob-lang" value={s.profile.language} options={languageOptions(s.profile.language, t, lang)} onChange={(v) => save((x) => (x.profile.language = v))} />
      </div>
      <div className="onboard-row">
        <span>
          <span id="ob-voice-l">{t('bots.onboard.voiceInput')}</span>
          <span className="muted small">{t('bots.onboard.voiceInputHint')}</span>
        </span>
        <Toggle label={t('bots.onboard.voiceInput')} value={s.voice.enabled} onChange={(v) => save((x) => (x.voice.enabled = v))} />
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
  const { t, lang } = useT()
  const s = app.settings
  const p = s.profile
  const def = s.models.default
  const rows: [string, string][] = [
    [t('bots.dialog.name'), p.name || t('bots.onboard.notSet')],
    [t('bots.dialog.model'), app.ready[def.providerId] ? refText(def) : t('bots.onboard.notConnected')],
    [t('bots.onboard.layout'), s.appearance.layout === 'elite' ? t('bots.onboard.layoutElite') : t('bots.onboard.layoutBasic')],
    [t('bots.onboard.mode'), modeChoices(t).find((m) => m.id === s.permissions.mode)?.label ?? s.permissions.mode],
    [t('bots.onboard.theme'), themes(t).find((th) => th.value === s.appearance.theme)?.label ?? s.appearance.theme],
    [t('bots.onboard.replyLanguage'), languageOptions(p.language, t, lang).find((o) => o.value === p.language)?.label ?? p.language],
    [t('bots.onboard.voiceInput'), s.voice.enabled ? t('common.on') : t('common.off')],
  ]
  return (
    <>
      <StepTitle heading={heading} title={t('bots.onboard.doneTitle')} text={t('bots.onboard.doneText')} />
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
            <b>{t('bots.onboard.share')}</b>
            <span className="muted small">{t('bots.onboard.shareHint')}</span>
          </span>
          <Toggle label={t('bots.onboard.share')} value={s.privacy.shareUsage} onChange={(v) => save((x) => (x.privacy.shareUsage = v))} />
        </div>
        <ShareInfoText />
        <p className="muted small">{t('bots.onboard.shareWhere')}</p>
      </section>
      {!app.ready[def.providerId] && <p className="small warn">{t('bots.onboard.noModel')}</p>}
    </>
  )
}
