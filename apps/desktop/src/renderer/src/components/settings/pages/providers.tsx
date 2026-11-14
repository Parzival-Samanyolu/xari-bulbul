import { useEffect, useState } from 'react'
import type { AccountView, AppState, EndpointProbe, ProviderTestResult, Settings, SynapseAccount } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useFormat, useT } from '../../../lib/i18n'
import { NumberField, Row, Section, TextField, Toggle } from '../../fields'
import { ProviderLogo } from '../../ProviderLogo'
import { Icon } from '../icons'
import { KEY_LINKS, SecretInput, type PageProps } from '../common'
import { rich } from '../../../lib/rich'
import { StatusDot } from './parts'
import { errorText as clean } from '../../../lib/errors'
import { ChatGptConnect } from '../../ChatGpt'
import { SYNAPSE_PROVIDER_ID, SYNAPSE_SITE } from '@harness/core/synapse'

type Provider = Settings['providers'][number]


/** Model counts for providers, loaded from the (cached) model lists. */
function useModelCounts(ids: string[]): Record<string, number | string> {
  const [counts, setCounts] = useState<Record<string, number | string>>({})
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    for (const id of ids)
      api.models.list(id).then(
        (m) => live && setCounts((c) => ({ ...c, [id]: m.length })),
        (e) => live && setCounts((c) => ({ ...c, [id]: clean(e) })),
      )
    return () => {
      live = false
    }
  }, [key])
  return counts
}

type T = ReturnType<typeof useT>['t']

const accountsText = (t: T, views: AccountView[] | undefined) => (views && views.length > 1 ? t('settings.providers.accountCount', { count: views.length }) : t('settings.providers.apiKey'))

const countText = (t: T, n: number | string | undefined) => (n === undefined ? t('settings.providers.loadingModels') : typeof n === 'string' ? n : t('settings.providers.modelCount', { count: n }))

// ---------------------------------------------------------------- Accounts

export function AccountsPage({ app, save, onState, onError, go }: PageProps) {
  const { t } = useT()
  const connected = app.settings.providers.filter((p) => app.ready[p.id])
  const counts = useModelCounts(connected.map((p) => p.id))
  const disconnect = (p: Provider) => {
    if (p.auth === 'chatgpt') {
      if (!confirm(t('settings.chatgpt.signOutConfirm'))) return
      api.chatgpt.signOut().then((r) => {
        onState(r.state)
        if (!r.revoked) alert(t('settings.chatgpt.notRevoked'))
      }, onError)
    } else if (p.requiresKey) {
      const keyed = (app.accounts[p.id] ?? []).filter((a) => a.hasKey)
      if (!confirm(keyed.length > 1 ? t('settings.providers.disconnectMany', { name: p.name, count: keyed.length }) : t('settings.providers.disconnectOne', { name: p.name }))) return
      keyed.reduce<Promise<AppState | null>>((prev, a) => prev.then(() => api.accounts.setKey(p.id, a.id, null)), Promise.resolve(null)).then((s) => s && onState(s), onError)
    } else save((s) => ((s.providers = s.providers.map((x) => (x.id === p.id ? { ...x, enabled: false } : x))), s))
  }
  if (!connected.length)
    return (
      <Section>
        <div className="empty-box">
          <b>{t('settings.providers.noProvider')}</b>
          <span className="muted small">{t('settings.providers.noProviderHint')}</span>
          <div className="inline">
            <button className="btn primary" onClick={() => go('providers.keys')}>
              {t('settings.providers.addApiKey')}
            </button>
            <button className="btn" onClick={() => go('providers.custom')}>
              {t('settings.providers.addEndpoint')}
            </button>
          </div>
        </div>
      </Section>
    )
  return (
    <Section>
      <ul className="account-list">
        {connected.map((p) => (
          <li key={p.id} className="account">
            <ProviderLogo id={p.id} name={p.name} size={22} />
            <div className="account-text">
              <b>{p.name}</b>
              <span className="muted small">
                {countText(t, counts[p.id])} ·{' '}
                {p.auth === 'chatgpt'
                  ? app.chatgpt.email
                    ? t('settings.chatgpt.signedInAs', { email: app.chatgpt.email })
                    : t('settings.chatgpt.signedIn')
                  : p.requiresKey
                    ? accountsText(t, app.accounts[p.id])
                    : t('settings.providers.noKeyNeeded')}
              </span>
            </div>
            <button className="btn ghost" onClick={() => disconnect(p)}>
              {p.auth === 'chatgpt' ? t('settings.chatgpt.signOut') : t('settings.providers.disconnect')}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- API keys

/** Synapse's plan, today's tokens and limits, from the key's `/v1/key`. */
function SynapsePlanRow({ ready }: { ready: boolean }) {
  const { t } = useT()
  const f = useFormat()
  const [acct, setAcct] = useState<SynapseAccount | null | undefined>(undefined)
  useEffect(() => {
    if (!ready) return setAcct(undefined)
    let live = true
    api.providers.synapseAccount().then((a) => live && setAcct(a), () => live && setAcct(null))
    return () => {
      live = false
    }
  }, [ready])
  if (!ready || acct === undefined) return null
  const hint = acct
    ? `${t('settings.providers.synapseUsage', {
        plan: acct.planLabel,
        used: f.num(acct.tokensToday),
        total: f.num(acct.limits.tokensPerDay),
        time: f.date(acct.resetsAt, { hour: '2-digit', minute: '2-digit' }),
      })} ${t('settings.providers.synapseLimits', { context: f.num(acct.limits.maxContextTokens), concurrent: f.num(acct.limits.maxConcurrent) })}`
    : t('settings.providers.synapseUnknown')
  const share = acct && acct.limits.tokensPerDay > 0 ? Math.min(1, acct.tokensToday / acct.limits.tokensPerDay) : null
  return (
    <Row label={t('settings.providers.synapsePlan')} hint={hint} search="">
      <div className="inline">
        {share !== null && (
          <span className="res-bar synapse-bar" aria-hidden="true">
            <span className={share > 0.9 ? 'hot' : ''} style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        )}
        <button className="link small" onClick={() => api.app.openExternal(`${SYNAPSE_SITE}/pricing`)}>
          {t('settings.providers.synapsePlans')}
        </button>
      </div>
    </Row>
  )
}

function ProviderKeyRow({ p, index, app, save, onState, onError }: { p: Provider; index: number } & Pick<PageProps, 'app' | 'save' | 'onState' | 'onError'>) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [test, setTest] = useState<ProviderTestResult | 'running' | null>(null)
  const [models, setModels] = useState<number | string | null>(null)
  const ready = !!app.ready[p.id]
  const hasKey = !!app.keys[p.id]
  const builtin = app.builtinProviders.includes(p.id)
  const runTest = () => {
    setTest('running')
    api.providers.test(p.id).then(setTest, (e) => setTest({ ok: false, message: clean(e) }))
  }
  useEffect(() => {
    if (!open || !ready) return setModels(null)
    api.models.list(p.id).then((m) => setModels(m.length), (e) => setModels(clean(e)))
  }, [open, ready])
  const status = !p.enabled ? t('settings.providers.turnedOff') : ready ? t('settings.providers.connected') : t('settings.providers.notConnected')
  const detailsId = `key-details-${p.id}`
  const accounts = app.accounts[p.id] ?? []
  const multi = accounts.length > 1
  const first = accounts.find((a) => a.active)?.label
  const plan = p.auth === 'chatgpt'
  return (
    <li className={`key-item ${open ? 'open' : ''}`}>
      <div className="key-line">
        <button className="key-name" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          <StatusDot on={ready} label={status} />
          <ProviderLogo id={p.id} name={p.name} size={16} />
          <span className="key-title">{p.name}</span>
          {!builtin && <span className="badge">{t('settings.providers.custom')}</span>}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="muted" />
        </button>
        {plan ? (
          <ChatGptConnect app={app} onState={onState} onError={onError} />
        ) : p.requiresKey && multi ? (
          <span className="muted small">
            {first ? t('settings.providers.accountsFirst', { count: accounts.length, name: first }) : t('settings.providers.accountsNoneOn', { count: accounts.length })}
          </span>
        ) : p.requiresKey ? (
          <SecretInput
            id={`key-${p.id}`}
            label={t('settings.providers.keyLabel', { name: p.name })}
            saved={hasKey}
            placeholder={t('settings.providers.pasteKey', { name: p.name })}
            onSave={(v) =>
              api.keys.set(p.id, v).then((s) => {
                onState(s)
                runTest()
              }, onError)
            }
          />
        ) : (
          <span className="muted small">{t('settings.providers.noKeyNeeded')}</span>
        )}
      </div>
      {test && test !== 'running' && (
        <p className={`small key-test ${test.ok ? 'okc' : 'warn'}`} role="status">
          {test.message}
        </p>
      )}
      {plan && open && <p className="small muted key-test">{t('settings.chatgpt.hint')}</p>}
      {open && (
        <div className="key-details" id={detailsId}>
          <Row label={t('settings.providers.turnedOn')} hint={t('settings.providers.turnedOnHint')} search="">
            <Toggle label={t('settings.providers.turnedOnToggle', { name: p.name })} value={p.enabled} onChange={(v) => save((s) => ((s.providers[index].enabled = v), s))} />
          </Row>
          <Row label={t('settings.providers.models')} hint={ready ? countText(t, models ?? undefined) : t('settings.providers.connectToList')} search="">
            <div className="inline">
              <button className="btn" disabled={!ready || test === 'running'} onClick={runTest}>
                {test === 'running' ? t('settings.providers.testing') : t('settings.providers.testConnection')}
              </button>
              {!plan && KEY_LINKS[p.id] && (
                <button className="link small" onClick={() => api.app.openExternal(KEY_LINKS[p.id])}>
                  {t('settings.providers.getKey')}
                </button>
              )}
              {hasKey && !multi && !plan && (
                <button className="link danger small" onClick={() => api.keys.set(p.id, null).then(onState, onError)}>
                  {t('settings.providers.removeKey')}
                </button>
              )}
            </div>
          </Row>
          {p.id === SYNAPSE_PROVIDER_ID && <SynapsePlanRow ready={ready} />}
          {p.requiresKey && !plan && <ProviderAccounts p={p} index={index} accounts={accounts} save={save} onState={onState} onError={onError} />}
          {!plan && (
            <>
          <Row label={t('settings.providers.baseUrl')} labelFor={`url-${p.id}`} search="">
            <TextField id={`url-${p.id}`} mono value={p.baseUrl} onChange={(v) => /^https?:\/\/\S+$/.test(v.trim()) && save((s) => ((s.providers[index].baseUrl = v.trim()), s))} />
          </Row>
          <Row label={t('settings.providers.needsKey')} hint={t('settings.providers.needsKeyHint')} search="">
            <Toggle label={t('settings.providers.needsKeyToggle', { name: p.name })} value={p.requiresKey} onChange={(v) => save((s) => ((s.providers[index].requiresKey = v), s))} />
          </Row>
          <Row label={t('settings.providers.exactCost')} hint={t('settings.providers.exactCostHint')} search="">
            <Toggle label={t('settings.providers.exactCostToggle', { name: p.name })} value={p.requestUsageCost} onChange={(v) => save((s) => ((s.providers[index].requestUsageCost = v), s))} />
          </Row>
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** While an account rests after a rate limit: until when, and why. */
const restingText = (t: T, date: (ts: number, o?: Intl.DateTimeFormatOptions) => string, c: AccountView['cooling']) =>
  c && c.until > Date.now() ? t('settings.providers.resting', { time: date(c.until, { hour: '2-digit', minute: '2-digit' }), reason: c.reason }) : null

type AccountMeta = { id: string; label: string; enabled: boolean }

/**
 * A provider's accounts, each with its own key, tried in order from the active one. Renaming,
 * turning off, reordering and the active pick are settings; adding, keys and removing go through main.
 */
function ProviderAccounts({ p, index, accounts, save, onState, onError }: { p: Provider; index: number; accounts: AccountView[] } & Pick<PageProps, 'save' | 'onState' | 'onError'>) {
  const { t } = useT()
  const { date } = useFormat()
  const resting = (c: AccountView['cooling']) => restingText(t, date, c)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)
  const multi = accounts.length > 1
  const edit = (fn: (list: AccountMeta[]) => AccountMeta[], activeAccount?: string) =>
    save((s) => {
      const pr = s.providers[index]
      pr.accounts = fn(accounts.map(({ id, label, enabled }) => ({ id, label, enabled })))
      if (activeAccount !== undefined) pr.activeAccount = activeAccount
      return s
    })
  const move = (i: number, by: number) =>
    edit((list) => {
      ;[list[i], list[i + by]] = [list[i + by], list[i]]
      return list
    })
  const add = () => {
    if (!label.trim() || !key.trim() || busy) return
    setBusy(true)
    api.accounts
      .add(p.id, label.trim(), key.trim())
      .then((s) => {
        onState(s)
        setAdding(false)
        setLabel('')
        setKey('')
      }, onError)
      .finally(() => setBusy(false))
  }
  const rename = () => {
    if (renaming?.label.trim()) edit((list) => list.map((a) => (a.id === renaming.id ? { ...a, label: renaming.label.trim() } : a)))
    setRenaming(null)
  }
  const status = (a: AccountView) => (!a.enabled ? t('settings.providers.turnedOff') : !a.hasKey ? t('settings.providers.noKey') : (resting(a.cooling) ?? t('settings.providers.keySaved')))
  const target = accounts.find((a) => a.id === replacing)
  return (
    <Row
      wide
      label={t('settings.providers.accounts')}
      hint={multi ? t('settings.providers.accountsHintMulti') : t('settings.providers.accountsHintSingle')}
      search=""
    >
      {multi && (
        <ol className="list-field ordered" aria-label={t('settings.providers.accountsList', { name: p.name })}>
          {accounts.map((a, i) => (
            <li key={a.id} className="list-item provider-acct">
              <span className="muted small order-num">{i + 1}</span>
              <StatusDot on={a.enabled && a.hasKey && !resting(a.cooling)} label={status(a)} />
              {renaming?.id === a.id ? (
                <input
                  className="acct-rename"
                  aria-label={t('settings.providers.renameLabel', { name: a.label })}
                  autoFocus
                  value={renaming.label}
                  onChange={(e) => setRenaming({ id: a.id, label: e.target.value })}
                  onBlur={rename}
                  onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setRenaming(null) : undefined)}
                />
              ) : (
                <span className="acct-name">
                  <b>{a.label}</b>
                  <span className={`small ${resting(a.cooling) ? 'warn' : 'muted'}`}>{status(a)}</span>
                </span>
              )}
              {a.active ? (
                <span className="badge ok">{t('settings.providers.active')}</span>
              ) : (
                a.enabled &&
                a.hasKey && (
                  <button className="link small" onClick={() => edit((list) => list, a.id)}>
                    {t('settings.providers.makeActive')}
                  </button>
                )
              )}
              <span className="spacer" />
              <button className="link small" disabled={i === 0} aria-label={t('settings.providers.moveUp', { name: a.label })} onClick={() => move(i, -1)}>
                {t('settings.providers.up')}
              </button>
              <button className="link small" disabled={i === accounts.length - 1} aria-label={t('settings.providers.moveDown', { name: a.label })} onClick={() => move(i, 1)}>
                {t('settings.providers.down')}
              </button>
              <button className="link small" aria-label={t('settings.providers.rename.label', { name: a.label })} onClick={() => setRenaming({ id: a.id, label: a.label })}>
                {t('settings.providers.rename')}
              </button>
              <button className="link small" aria-label={a.hasKey ? t('settings.providers.replaceKeyLabel', { name: a.label }) : t('settings.providers.addKeyLabel', { name: a.label })} onClick={() => setReplacing(replacing === a.id ? null : a.id)}>
                {a.hasKey ? t('settings.providers.replaceKey') : t('settings.providers.addKey')}
              </button>
              <Toggle label={t('settings.providers.turnedOnToggle', { name: a.label })} value={a.enabled} onChange={(v) => edit((list) => list.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)))} />
              <button
                className="link danger small"
                aria-label={t('settings.providers.removeLabel', { name: a.label })}
                onClick={() => confirm(t('settings.providers.removeAccountConfirm', { name: a.label })) && api.accounts.remove(p.id, a.id).then(onState, onError)}
              >
                {t('common.remove')}
              </button>
            </li>
          ))}
        </ol>
      )}
      {target && (
        <SecretInput
          id={`acct-key-${p.id}-${target.id}`}
          label={t('settings.providers.keyLabel', { name: target.label })}
          saved={target.hasKey}
          placeholder={t('settings.providers.pasteAccountKey', { name: target.label })}
          onSave={(v) =>
            api.accounts.setKey(p.id, target.id, v).then((s) => {
              onState(s)
              setReplacing(null)
            }, onError)
          }
        />
      )}
      {adding ? (
        <form
          className="acct-add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input aria-label={t('settings.providers.accountName')} placeholder={t('settings.providers.accountNamePlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          <input type="password" className="mono" autoComplete="off" spellCheck={false} aria-label={t('settings.providers.accountKey')} placeholder={t('settings.providers.pasteKey', { name: p.name })} value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="btn primary" disabled={!label.trim() || !key.trim() || busy}>
            {t('common.add')}
          </button>
          <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
            {t('common.cancel')}
          </button>
        </form>
      ) : (
        <div className="inline">
          <button className="btn" onClick={() => setAdding(true)}>
            {t('settings.providers.addAccount')}
          </button>
          {!multi && accounts[0]?.hasKey && <span className="muted small">{t('settings.providers.becomesAccount', { name: accounts[0].label })}</span>}
        </div>
      )}
    </Row>
  )
}

export function ApiKeysPage(props: PageProps) {
  const { app, go } = props
  const { t } = useT()
  const [q, setQ] = useState('')
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = app.settings.providers.map((p, index) => ({ p, index })).filter(({ p }) => terms.every((t) => `${p.name} ${p.id}`.toLowerCase().includes(t)))
  return (
    <Section>
      <button className="nav-row" onClick={() => go('providers.custom')}>
        <span>
          <b>{t('settings.providers.localCustom')}</b>
          <span className="muted small">{t('settings.providers.localCustomHint')}</span>
        </span>
        <Icon name="chevronRight" />
      </button>
      <input type="search" className="key-search" aria-label={t('settings.providers.search')} placeholder={t('settings.providers.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="muted small">
        {app.keyStorage === 'os' ? t('settings.providers.keychainOs') : <span className="warn">{t('settings.providers.keychainNone')}</span>} {rich(t('settings.providers.envVars'), { example: <code>OPENROUTER_API_KEY</code> })}
      </p>
      <ul className="key-list" aria-label={t('settings.providers.list')}>
        {list.map(({ p, index }) => (
          <ProviderKeyRow key={p.id} p={p} index={index} {...props} />
        ))}
        {!list.length && <li className="muted small">{t('settings.providers.noMatch', { query: q.trim() })}</li>}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- Custom endpoints

type ApiMode = 'auto' | 'openai' | 'anthropic'

/** The API modes; the two protocols keep their own names. */
const apiModes = (t: T): { value: ApiMode; label: string }[] => [
  { value: 'auto', label: t('settings.providers.autoDetect') },
  { value: 'openai', label: 'Chat Completions' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]

interface Draft {
  /** Set while editing a saved endpoint (its id can't change). */
  editing: string | null
  name: string
  id: string
  idTouched: boolean
  baseUrl: string
  api: ApiMode
  model: string
  context: number | null
  key: string
  useForNew: boolean
  discover: boolean
}

const blank: Draft = { editing: null, name: '', id: '', idTouched: false, baseUrl: '', api: 'auto', model: '', context: null, key: '', useForNew: false, discover: true }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function draftFor(p: Provider, app: AppState): Draft {
  const def = app.settings.models.default
  const model = def.providerId === p.id ? def.modelId : ''
  return {
    editing: p.id,
    name: p.name,
    id: p.id,
    idTouched: true,
    baseUrl: p.baseUrl,
    api: p.api === 'openai-responses' ? 'openai' : p.api,
    model,
    context: (model && app.settings.models.overrides[`${p.id}:${model}`]?.contextLength) || null,
    key: '',
    useForNew: def.providerId === p.id,
    discover: true,
  }
}

export function CustomEndpointsPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const builtin = new Set(app.builtinProviders)
  const custom = app.settings.providers.filter((p) => !builtin.has(p.id))
  const existing = new Set(app.settings.providers.map((p) => p.id))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [probe, setProbe] = useState<EndpointProbe | 'running' | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const open = (d: Draft) => (setDraft(d), setProbe(null))

  const idProblem = !draft
    ? null
    : !draft.id
      ? t('settings.providers.idNeeded')
      : !/^[a-z0-9-]+$/.test(draft.id)
        ? t('settings.providers.idChars')
        : !draft.editing && existing.has(draft.id)
          ? t('settings.providers.idTaken')
          : null
  const urlOk = !!draft && /^https?:\/\/\S+$/.test(draft.baseUrl.trim())
  const models = probe && probe !== 'running' ? probe.models : []

  const runProbe = (d: Draft) =>
    api.providers.probe({ id: d.id || undefined, name: d.name, baseUrl: d.baseUrl.trim(), api: d.api, key: d.key || undefined, model: d.model.trim() || undefined }).catch((e): EndpointProbe => ({ ok: false, message: clean(e), models: [] }))

  const test = () => {
    if (!draft) return
    setProbe('running')
    runProbe(draft).then((r) => {
      setProbe(r)
      if (r.ok && draft.discover && !draft.model && r.models.length) set({ model: r.models[0] })
    })
  }

  const submit = async () => {
    if (!draft || idProblem || !urlOk || !draft.name.trim()) return
    setSaving(true)
    try {
      let detected = draft.api === 'auto' && probe && probe !== 'running' && probe.ok ? probe.api : undefined
      if (draft.api === 'auto' && !detected) {
        const r = await runProbe(draft)
        setProbe(r)
        detected = r.ok ? r.api : undefined
      }
      const apiMode = draft.api === 'auto' ? (detected ?? 'openai') : draft.api
      const prev = app.settings.providers.find((p) => p.id === draft.id)
      const hasKey = !!draft.key.trim() || !!app.keys[draft.id]
      const config: Provider = {
        id: draft.id,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        enabled: true,
        headers: prev?.headers ?? {},
        requestUsageCost: prev?.requestUsageCost ?? false,
        auth: prev?.auth ?? 'key',
        requiresKey: hasKey,
        api: apiMode,
      }
      const next = structuredClone(app.settings)
      next.providers = prev ? next.providers.map((p) => (p.id === config.id ? config : p)) : [...next.providers, config]
      const model = draft.model.trim()
      if (model && draft.useForNew) next.models.default = { providerId: config.id, modelId: model }
      if (model) {
        const k = `${config.id}:${model}`
        const o = { ...(next.models.overrides[k] ?? {}), contextLength: draft.context ?? undefined }
        if (o.contextLength === undefined) delete o.contextLength
        if (Object.keys(o).length) next.models.overrides[k] = o
        else delete next.models.overrides[k]
      }
      let state = await api.settings.set(next)
      if (draft.key.trim()) state = await api.keys.set(config.id, draft.key.trim())
      onState(state)
      setDraft(null)
    } catch (e) {
      onError(e)
    } finally {
      setSaving(false)
    }
  }

  const remove = (p: Provider) => {
    if (!confirm(t('settings.providers.removeConfirm', { name: p.name }))) return
    save((s) => ((s.providers = s.providers.filter((x) => x.id !== p.id)), s))
    for (const a of app.accounts[p.id] ?? []) if (a.hasKey) api.accounts.setKey(p.id, a.id, null).then(onState, onError)
  }

  const quick = app.providerPresets.filter((p) => !existing.has(p.id))
  const addPreset = (p: AppState['providerPresets'][number]) =>
    api.settings.set({ ...app.settings, providers: [...app.settings.providers, { ...p, enabled: true, headers: {}, requestUsageCost: false, api: 'openai' as const, auth: 'key' as const }] }).then(onState, onError)

  return (
    <>
      <Section>
        {custom.length === 0 && !draft && (
          <div className="empty-box">
            <b>{t('settings.providers.noCustom')}</b>
            <span className="muted small">{t('settings.providers.noCustomHint')}</span>
          </div>
        )}
        {custom.length > 0 && (
          <ul className="account-list">
            {custom.map((p) => (
              <li key={p.id} className="account">
                <StatusDot on={!!app.ready[p.id]} label={app.ready[p.id] ? t('settings.providers.connected') : p.enabled ? t('settings.providers.notConnected') : t('settings.providers.turnedOff')} />
                <ProviderLogo id={p.id} name={p.name} size={20} />
                <div className="account-text">
                  <b>{p.name}</b>
                  <span className="muted small mono">{p.baseUrl}</span>
                </div>
                <span className="badge">{p.api === 'anthropic' ? 'Anthropic Messages' : p.api === 'openai-responses' ? 'Responses' : 'Chat Completions'}</span>
                <button className="btn ghost" onClick={() => open(draftFor(p, app))}>
                  {t('common.edit')}
                </button>
                <button className="link danger small" onClick={() => remove(p)}>
                  {t('common.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {quick.length > 0 && (
        <Section title={t('settings.providers.quickAdd')}>
          <div className="presets">
            {quick.map((p) => (
              <button key={p.id} className="btn" onClick={() => addPreset(p)} title={p.baseUrl}>
                <ProviderLogo id={p.id} name={p.name} /> {p.name}
                <span className="muted small">{p.requiresKey ? t('settings.providers.needsAKey') : t('settings.providers.noKeyShort')}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section title={draft?.editing ? t('settings.providers.editEndpoint', { name: draft.name || draft.editing }) : t('settings.providers.newEndpoint')}>
        {!draft ? (
          <div>
            <button className="btn" onClick={() => open({ ...blank })}>
              {t('settings.providers.addEndpointButton')}
            </button>
          </div>
        ) : (
          <form
            className="endpoint-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Row label={t('settings.providers.name')} labelFor="ep-name" search="">
              <input id="ep-name" value={draft.name} placeholder={t('settings.providers.namePlaceholder')} onChange={(e) => set({ name: e.target.value, ...(draft.idTouched ? {} : { id: slug(e.target.value) }) })} />
            </Row>
            <Row label={t('settings.providers.providerId')} hint={idProblem ?? t('settings.providers.providerIdHint')} labelFor="ep-id" search="">
              <input id="ep-id" className="mono" value={draft.id} disabled={!!draft.editing} aria-invalid={!!idProblem} placeholder="my-server" onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''), idTouched: true })} />
            </Row>
            <Row label={t('settings.providers.endpointUrl')} hint={t('settings.providers.endpointUrlHint')} labelFor="ep-url" search="">
              <input id="ep-url" className="mono" value={draft.baseUrl} placeholder="http://localhost:8000/v1" aria-invalid={!!draft.baseUrl && !urlOk} onChange={(e) => set({ baseUrl: e.target.value })} />
            </Row>
            <Row label={t('settings.providers.apiMode')} hint={t('settings.providers.apiModeHint')} search="">
              <div className="segmented" role="radiogroup" aria-label={t('settings.providers.apiMode')}>
                {apiModes(t).map((m) => (
                  <button key={m.value} type="button" role="radio" aria-checked={draft.api === m.value} className={draft.api === m.value ? 'on' : ''} onClick={() => set({ api: m.value })}>
                    {m.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row
              label={t('settings.providers.defaultModel')}
              hint={draft.discover ? (models.length ? t('settings.providers.modelsFound', { count: models.length }) : t('settings.providers.testToList')) : t('settings.providers.typeModelId')}
              labelFor="ep-model"
              search=""
            >
              {draft.discover && models.length > 0 ? (
                <select id="ep-model" value={draft.model} onChange={(e) => set({ model: e.target.value })}>
                  <option value="">{t('common.none')}</option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input id="ep-model" className="mono" value={draft.model} placeholder="llama3.3" onChange={(e) => set({ model: e.target.value })} />
              )}
            </Row>
            <Row label={t('settings.providers.context')} hint={t('settings.providers.contextHint')} search="">
              <NumberField label={t('settings.model.contextWindow')} nullable value={draft.context} min={1000} step={1000} placeholder={t('settings.model.auto')} suffix={t('settings.model.tokens')} onChange={(v) => set({ context: v })} />
            </Row>
            <Row label={t('settings.providers.apiKey')} hint={draft.editing && app.keys[draft.editing] ? t('settings.providers.keySavedHint') : t('settings.providers.keyOptionalHint')} labelFor="ep-key" search="">
              <input id="ep-key" type="password" className="mono" autoComplete="off" spellCheck={false} value={draft.key} placeholder={draft.editing && app.keys[draft.editing] ? t('settings.common.savedMask') : t('settings.providers.optional')} onChange={(e) => set({ key: e.target.value })} />
            </Row>
            <div className="checks">
              <label className="check">
                <input type="checkbox" checked={draft.useForNew} onChange={(e) => set({ useForNew: e.target.checked })} /> {t('settings.providers.useForNew')}
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.discover} onChange={(e) => set({ discover: e.target.checked })} /> {t('settings.providers.discover')}
              </label>
            </div>
            {draft.useForNew && !draft.model.trim() && <p className="small warn">{t('settings.providers.chooseDefault')}</p>}
            {probe && (
              <p className={`small ${probe === 'running' ? 'muted' : probe.ok ? 'okc' : 'warn'}`} role="status">
                {probe === 'running' ? t('settings.providers.testing') : probe.message}
                {probe !== 'running' && probe.ok && draft.api === 'auto' && probe.api ? ` ${t('settings.providers.detected', { api: probe.api === 'anthropic' ? 'Anthropic Messages' : 'Chat Completions' })}` : ''}
              </p>
            )}
            <div className="inline form-actions">
              <button type="button" className="btn" disabled={!urlOk || probe === 'running'} onClick={test}>
                {t('settings.providers.test')}
              </button>
              <button type="submit" className="btn primary" disabled={!!idProblem || !urlOk || !draft.name.trim() || saving}>
                {saving ? t('settings.providers.saving') : t('common.save')}
              </button>
              <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </Section>
    </>
  )
}
