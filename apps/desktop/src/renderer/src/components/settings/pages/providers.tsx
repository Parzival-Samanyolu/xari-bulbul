import { useEffect, useState } from 'react'
import type { AccountView, AppState, EndpointProbe, ProviderTestResult, Settings } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { NumberField, Row, Section, TextField, Toggle } from '../../fields'
import { ProviderLogo } from '../../ProviderLogo'
import { Icon } from '../icons'
import { KEY_LINKS, SecretInput, type PageProps } from '../common'
import { StatusDot } from './parts'

type Provider = Settings['providers'][number]

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

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

const accountsText = (views: AccountView[] | undefined) => (views && views.length > 1 ? `${views.length} accounts` : 'API key')

const countText = (n: number | string | undefined) => (n === undefined ? 'Loading models…' : typeof n === 'string' ? n : `${n} ${n === 1 ? 'model' : 'models'}`)

// ---------------------------------------------------------------- Accounts

export function AccountsPage({ app, save, onState, onError, go }: PageProps) {
  const connected = app.settings.providers.filter((p) => app.ready[p.id])
  const counts = useModelCounts(connected.map((p) => p.id))
  const disconnect = (p: Provider) => {
    if (p.requiresKey) {
      const keyed = (app.accounts[p.id] ?? []).filter((a) => a.hasKey)
      if (!confirm(`Disconnect ${p.name}? ${keyed.length > 1 ? `The saved keys of all ${keyed.length} accounts are removed.` : 'Its saved API key is removed.'}`)) return
      keyed.reduce<Promise<AppState | null>>((prev, a) => prev.then(() => api.accounts.setKey(p.id, a.id, null)), Promise.resolve(null)).then((s) => s && onState(s), onError)
    } else save((s) => ((s.providers = s.providers.map((x) => (x.id === p.id ? { ...x, enabled: false } : x))), s))
  }
  if (!connected.length)
    return (
      <Section>
        <div className="empty-box">
          <b>No provider connected</b>
          <span className="muted small">Paste a key for OpenRouter or Ollama Cloud (both have free models), or add a local endpoint such as Ollama.</span>
          <div className="inline">
            <button className="btn primary" onClick={() => go('providers.keys')}>
              Add an API key
            </button>
            <button className="btn" onClick={() => go('providers.custom')}>
              Add an endpoint
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
                {countText(counts[p.id])} · {p.requiresKey ? accountsText(app.accounts[p.id]) : 'No key needed'}
              </span>
            </div>
            <button className="btn ghost" onClick={() => disconnect(p)}>
              Disconnect
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- API keys

function ProviderKeyRow({ p, index, app, save, onState, onError }: { p: Provider; index: number } & Pick<PageProps, 'app' | 'save' | 'onState' | 'onError'>) {
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
  const status = !p.enabled ? 'Turned off' : ready ? 'Connected' : 'Not connected'
  const detailsId = `key-details-${p.id}`
  const accounts = app.accounts[p.id] ?? []
  const multi = accounts.length > 1
  return (
    <li className={`key-item ${open ? 'open' : ''}`}>
      <div className="key-line">
        <button className="key-name" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          <StatusDot on={ready} label={status} />
          <ProviderLogo id={p.id} name={p.name} size={16} />
          <span className="key-title">{p.name}</span>
          {!builtin && <span className="badge">custom</span>}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="muted" />
        </button>
        {p.requiresKey && multi ? (
          <span className="muted small">
            {accounts.length} accounts · {accounts.find((a) => a.active)?.label ?? 'none turned on'} first
          </span>
        ) : p.requiresKey ? (
          <SecretInput
            id={`key-${p.id}`}
            label={`${p.name} API key`}
            saved={hasKey}
            placeholder={`Paste ${p.name} key`}
            onSave={(v) =>
              api.keys.set(p.id, v).then((s) => {
                onState(s)
                runTest()
              }, onError)
            }
          />
        ) : (
          <span className="muted small">No key needed</span>
        )}
      </div>
      {test && test !== 'running' && (
        <p className={`small key-test ${test.ok ? 'okc' : 'warn'}`} role="status">
          {test.message}
        </p>
      )}
      {open && (
        <div className="key-details" id={detailsId}>
          <Row label="Turned on" hint="Off hides it everywhere, even with a key saved." search="">
            <Toggle label={`${p.name} turned on`} value={p.enabled} onChange={(v) => save((s) => ((s.providers[index].enabled = v), s))} />
          </Row>
          <Row label="Models" hint={ready ? countText(models ?? undefined) : 'Connect it to list its models.'} search="">
            <div className="inline">
              <button className="btn" disabled={!ready || test === 'running'} onClick={runTest}>
                {test === 'running' ? 'Testing…' : 'Test connection'}
              </button>
              {KEY_LINKS[p.id] && (
                <button className="link small" onClick={() => api.app.openExternal(KEY_LINKS[p.id])}>
                  Get a key ↗
                </button>
              )}
              {hasKey && !multi && (
                <button className="link danger small" onClick={() => api.keys.set(p.id, null).then(onState, onError)}>
                  Remove key
                </button>
              )}
            </div>
          </Row>
          {p.requiresKey && <ProviderAccounts p={p} index={index} accounts={accounts} save={save} onState={onState} onError={onError} />}
          <Row label="Base URL" labelFor={`url-${p.id}`} search="">
            <TextField id={`url-${p.id}`} mono value={p.baseUrl} onChange={(v) => /^https?:\/\/\S+$/.test(v.trim()) && save((s) => ((s.providers[index].baseUrl = v.trim()), s))} />
          </Row>
          <Row label="Needs an API key" hint="Off for local servers such as Ollama or LM Studio." search="">
            <Toggle label={`${p.name} needs an API key`} value={p.requiresKey} onChange={(v) => save((s) => ((s.providers[index].requiresKey = v), s))} />
          </Row>
          <Row label="Report exact cost" hint="Asks the provider to include each request's cost (OpenRouter supports this)." search="">
            <Toggle label={`${p.name}: report exact cost`} value={p.requestUsageCost} onChange={(v) => save((s) => ((s.providers[index].requestUsageCost = v), s))} />
          </Row>
        </div>
      )}
    </li>
  )
}

const restingText = (c: AccountView['cooling']) =>
  c && c.until > Date.now() ? `Resting until ${new Date(c.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${c.reason}` : null

type AccountMeta = { id: string; label: string; enabled: boolean }

/**
 * A provider's accounts, each with its own key, tried in order from the active one. Renaming,
 * turning off, reordering and the active pick are settings; adding, keys and removing go through main.
 */
function ProviderAccounts({ p, index, accounts, save, onState, onError }: { p: Provider; index: number; accounts: AccountView[] } & Pick<PageProps, 'save' | 'onState' | 'onError'>) {
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
  const status = (a: AccountView) => (!a.enabled ? 'Turned off' : !a.hasKey ? 'No key' : (restingText(a.cooling) ?? 'Key saved'))
  const target = accounts.find((a) => a.id === replacing)
  return (
    <Row
      wide
      label="Accounts"
      hint={
        multi
          ? 'Requests use the active account. When it hits a rate limit, runs out of credits or has its key rejected, they move to the next one in this order.'
          : 'Add another account to switch to it automatically when this one hits a rate limit or runs out of credits.'
      }
      search=""
    >
      {multi && (
        <ol className="list-field ordered" aria-label={`${p.name} accounts`}>
          {accounts.map((a, i) => (
            <li key={a.id} className="list-item provider-acct">
              <span className="muted small order-num">{i + 1}</span>
              <StatusDot on={a.enabled && a.hasKey && !restingText(a.cooling)} label={status(a)} />
              {renaming?.id === a.id ? (
                <input
                  className="acct-rename"
                  aria-label={`New name for ${a.label}`}
                  autoFocus
                  value={renaming.label}
                  onChange={(e) => setRenaming({ id: a.id, label: e.target.value })}
                  onBlur={rename}
                  onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setRenaming(null) : undefined)}
                />
              ) : (
                <span className="acct-name">
                  <b>{a.label}</b>
                  <span className={`small ${restingText(a.cooling) ? 'warn' : 'muted'}`}>{status(a)}</span>
                </span>
              )}
              {a.active ? (
                <span className="badge ok">Active</span>
              ) : (
                a.enabled &&
                a.hasKey && (
                  <button className="link small" onClick={() => edit((list) => list, a.id)}>
                    Make active
                  </button>
                )
              )}
              <span className="spacer" />
              <button className="link small" disabled={i === 0} aria-label={`Move ${a.label} up`} onClick={() => move(i, -1)}>
                Up
              </button>
              <button className="link small" disabled={i === accounts.length - 1} aria-label={`Move ${a.label} down`} onClick={() => move(i, 1)}>
                Down
              </button>
              <button className="link small" aria-label={`Rename ${a.label}`} onClick={() => setRenaming({ id: a.id, label: a.label })}>
                Rename
              </button>
              <button className="link small" aria-label={`${a.hasKey ? 'Replace' : 'Add'} the ${a.label} key`} onClick={() => setReplacing(replacing === a.id ? null : a.id)}>
                {a.hasKey ? 'Replace key' : 'Add key'}
              </button>
              <Toggle label={`${a.label} turned on`} value={a.enabled} onChange={(v) => edit((list) => list.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)))} />
              <button
                className="link danger small"
                aria-label={`Remove ${a.label}`}
                onClick={() => confirm(`Remove the ${a.label} account? Its saved key is removed.`) && api.accounts.remove(p.id, a.id).then(onState, onError)}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {target && (
        <SecretInput
          id={`acct-key-${p.id}-${target.id}`}
          label={`${target.label} API key`}
          saved={target.hasKey}
          placeholder={`Paste the ${target.label} key`}
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
          <input aria-label="Account name" placeholder="Name, e.g. Work" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          <input type="password" className="mono" autoComplete="off" spellCheck={false} aria-label="Account API key" placeholder={`Paste ${p.name} key`} value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="btn primary" disabled={!label.trim() || !key.trim() || busy}>
            Add
          </button>
          <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="inline">
          <button className="btn" onClick={() => setAdding(true)}>
            + Add account
          </button>
          {!multi && accounts[0]?.hasKey && <span className="muted small">The saved key becomes the “{accounts[0].label}” account.</span>}
        </div>
      )}
    </Row>
  )
}

export function ApiKeysPage(props: PageProps) {
  const { app, go } = props
  const [q, setQ] = useState('')
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = app.settings.providers.map((p, index) => ({ p, index })).filter(({ p }) => terms.every((t) => `${p.name} ${p.id}`.toLowerCase().includes(t)))
  return (
    <Section>
      <button className="nav-row" onClick={() => go('providers.custom')}>
        <span>
          <b>Local / custom endpoint</b>
          <span className="muted small">Ollama, LM Studio, vLLM, or any server that speaks the OpenAI or Anthropic API.</span>
        </span>
        <Icon name="chevronRight" />
      </button>
      <input type="search" className="key-search" aria-label="Search providers" placeholder="Search providers…" value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="muted small">
        {app.keyStorage === 'os' ? 'Keys are stored in your system keychain and never shown again.' : <span className="warn">No system keychain was found, so keys are only obfuscated.</span>} Environment variables such as <code>OPENROUTER_API_KEY</code> also work.
      </p>
      <ul className="key-list" aria-label="Providers">
        {list.map(({ p, index }) => (
          <ProviderKeyRow key={p.id} p={p} index={index} {...props} />
        ))}
        {!list.length && <li className="muted small">No provider matches “{q.trim()}”.</li>}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- Custom endpoints

type ApiMode = 'auto' | 'openai' | 'anthropic'

const API_MODES: { value: ApiMode; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
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
    api: p.api,
    model,
    context: (model && app.settings.models.overrides[`${p.id}:${model}`]?.contextLength) || null,
    key: '',
    useForNew: def.providerId === p.id,
    discover: true,
  }
}

export function CustomEndpointsPage({ app, save, onState, onError }: PageProps) {
  const builtin = new Set(app.builtinProviders)
  const custom = app.settings.providers.filter((p) => !builtin.has(p.id))
  const existing = new Set(app.settings.providers.map((p) => p.id))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [probe, setProbe] = useState<EndpointProbe | 'running' | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const open = (d: Draft) => (setDraft(d), setProbe(null))

  const idProblem = !draft ? null : !draft.id ? 'Needs an id.' : !/^[a-z0-9-]+$/.test(draft.id) ? 'Use lowercase letters, digits and dashes.' : !draft.editing && existing.has(draft.id) ? 'Another provider already has this id.' : null
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
    if (!confirm(`Remove ${p.name}? Its saved key is removed too.`)) return
    save((s) => ((s.providers = s.providers.filter((x) => x.id !== p.id)), s))
    for (const a of app.accounts[p.id] ?? []) if (a.hasKey) api.accounts.setKey(p.id, a.id, null).then(onState, onError)
  }

  const quick = app.providerPresets.filter((p) => !existing.has(p.id))
  const addPreset = (p: AppState['providerPresets'][number]) =>
    api.settings.set({ ...app.settings, providers: [...app.settings.providers, { ...p, enabled: true, headers: {}, requestUsageCost: false, api: 'openai' as const }] }).then(onState, onError)

  return (
    <>
      <Section>
        {custom.length === 0 && !draft && (
          <div className="empty-box">
            <b>No custom endpoints</b>
            <span className="muted small">Add an OpenAI-compatible endpoint below.</span>
          </div>
        )}
        {custom.length > 0 && (
          <ul className="account-list">
            {custom.map((p) => (
              <li key={p.id} className="account">
                <StatusDot on={!!app.ready[p.id]} label={app.ready[p.id] ? 'Connected' : p.enabled ? 'Not connected' : 'Turned off'} />
                <ProviderLogo id={p.id} name={p.name} size={20} />
                <div className="account-text">
                  <b>{p.name}</b>
                  <span className="muted small mono">{p.baseUrl}</span>
                </div>
                <span className="badge">{p.api === 'anthropic' ? 'Anthropic Messages' : 'Chat Completions'}</span>
                <button className="btn ghost" onClick={() => open(draftFor(p, app))}>
                  Edit
                </button>
                <button className="link danger small" onClick={() => remove(p)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {quick.length > 0 && (
        <Section title="Quick add">
          <div className="presets">
            {quick.map((p) => (
              <button key={p.id} className="btn" onClick={() => addPreset(p)} title={p.baseUrl}>
                <ProviderLogo id={p.id} name={p.name} /> {p.name}
                <span className="muted small">{p.requiresKey ? 'needs a key' : 'no key'}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section title={draft?.editing ? `Edit ${draft.name || draft.editing}` : 'New endpoint'}>
        {!draft ? (
          <div>
            <button className="btn" onClick={() => open({ ...blank })}>
              + Add endpoint
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
            <Row label="Name" labelFor="ep-name" search="">
              <input id="ep-name" value={draft.name} placeholder="My server" onChange={(e) => set({ name: e.target.value, ...(draft.idTouched ? {} : { id: slug(e.target.value) }) })} />
            </Row>
            <Row label="Provider ID" hint={idProblem ?? 'Used in model references and rules. Can’t change after saving.'} labelFor="ep-id" search="">
              <input id="ep-id" className="mono" value={draft.id} disabled={!!draft.editing} aria-invalid={!!idProblem} placeholder="my-server" onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''), idTouched: true })} />
            </Row>
            <Row label="Endpoint URL" hint="The base URL, usually ending in /v1." labelFor="ep-url" search="">
              <input id="ep-url" className="mono" value={draft.baseUrl} placeholder="http://localhost:8000/v1" aria-invalid={!!draft.baseUrl && !urlOk} onChange={(e) => set({ baseUrl: e.target.value })} />
            </Row>
            <Row label="API mode" hint="Auto-detect tries the protocol the URL suggests, then the other. OpenAI's Responses API isn't supported; servers that offer it usually offer Chat Completions too." search="">
              <div className="segmented" role="radiogroup" aria-label="API mode">
                {API_MODES.map((m) => (
                  <button key={m.value} type="button" role="radio" aria-checked={draft.api === m.value} className={draft.api === m.value ? 'on' : ''} onClick={() => set({ api: m.value })}>
                    {m.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Default model" hint={draft.discover ? (models.length ? `${models.length} models found.` : 'Test to list the endpoint’s models, or type an id.') : 'Type the model id.'} labelFor="ep-model" search="">
              {draft.discover && models.length > 0 ? (
                <select id="ep-model" value={draft.model} onChange={(e) => set({ model: e.target.value })}>
                  <option value="">None</option>
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
            <Row label="Context" hint="The default model's context window. Empty: what the endpoint reports, else the fallback size." search="">
              <NumberField label="Context window" nullable value={draft.context} min={1000} step={1000} placeholder="Auto" suffix="tokens" onChange={(v) => set({ context: v })} />
            </Row>
            <Row label="API key" hint={draft.editing && app.keys[draft.editing] ? 'A key is saved. Paste a new one to replace it.' : 'Optional. Local servers usually need none.'} labelFor="ep-key" search="">
              <input id="ep-key" type="password" className="mono" autoComplete="off" spellCheck={false} value={draft.key} placeholder={draft.editing && app.keys[draft.editing] ? '•••••••• saved' : 'Optional'} onChange={(e) => set({ key: e.target.value })} />
            </Row>
            <div className="checks">
              <label className="check">
                <input type="checkbox" checked={draft.useForNew} onChange={(e) => set({ useForNew: e.target.checked })} /> Use for new chats
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.discover} onChange={(e) => set({ discover: e.target.checked })} /> Discover models
              </label>
            </div>
            {draft.useForNew && !draft.model.trim() && <p className="small warn">Choose a default model to use it for new chats.</p>}
            {probe && (
              <p className={`small ${probe === 'running' ? 'muted' : probe.ok ? 'okc' : 'warn'}`} role="status">
                {probe === 'running' ? 'Testing…' : probe.message}
                {probe !== 'running' && probe.ok && draft.api === 'auto' && probe.api ? ` Detected ${probe.api === 'anthropic' ? 'Anthropic Messages' : 'Chat Completions'}.` : ''}
              </p>
            )}
            <div className="inline form-actions">
              <button type="button" className="btn" disabled={!urlOk || probe === 'running'} onClick={test}>
                Test
              </button>
              <button type="submit" className="btn primary" disabled={!!idProblem || !urlOk || !draft.name.trim() || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Section>
    </>
  )
}
