import { useState } from 'react'
import type { PluginInfo, Settings, UpdateStatus } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { ago, cost, modelLabel, tokens } from '../../../lib/format'
import { NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import { ModelPicker } from '../../ModelPicker'
import { PluginDialog, includesText } from '../../PluginDialog'
import type { PageProps } from '../common'
import { toolToggle } from './advanced'

// ---------------------------------------------------------------- Usage

export function UsagePage({ app, save, onState, onError }: PageProps) {
  const u = app.settings.usage
  const sum = app.usage
  const byModel = Object.entries(sum.byModel).sort((a, b) => b[1].cost - a[1].cost || b[1].requests - a[1].requests)
  return (
    <>
      <Section description="Every model request is counted on this computer. Cost comes from the provider when it reports one, otherwise from the model's list price. “+” means some requests had unknown cost (subscription plans, for example).">
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
        <Row label="Show cost" hint="In the status bar and the tables above.">
          <Toggle label="Show cost" value={u.showCost} onChange={(v) => save((s) => ((s.usage.showCost = v), s))} />
        </Row>
        <Row label="Show the last request in the status bar" hint="Tokens sent and received by the latest request.">
          <Toggle label="Show the last request in the status bar" value={u.showPerMessageUsage} onChange={(v) => save((s) => ((s.usage.showPerMessageUsage = v), s))} />
        </Row>
      </Section>
      <Section title="Budgets" description="Guard rails against runaway spending. Empty means no limit.">
        <Row label="Per-chat budget">
          <NumberField label="Per-chat budget" nullable value={u.sessionBudgetUsd} min={0} step={0.5} placeholder="No limit" suffix="USD" onChange={(v) => save((s) => ((s.usage.sessionBudgetUsd = v), s))} />
        </Row>
        <Row label="Daily budget">
          <NumberField label="Daily budget" nullable value={u.dailyBudgetUsd} min={0} step={1} placeholder="No limit" suffix="USD" onChange={(v) => save((s) => ((s.usage.dailyBudgetUsd = v), s))} />
        </Row>
        <Row label="When a budget is reached">
          <Select
            label="When a budget is reached"
            value={u.budgetAction}
            options={[
              { value: 'warn', label: 'Warn and continue' },
              { value: 'stop', label: 'Stop the agent' },
            ]}
            onChange={(v) => save((s) => ((s.usage.budgetAction = v), s))}
          />
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Schedules

type ScheduleConfig = Settings['schedules'][number]

const FREQUENCIES = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'interval', label: 'Every few hours' },
] as const
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, i) => ({ value: String(i), label }))

function when(t: number | null): string {
  if (t == null) return '—'
  return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SchedulesPage({ app, save, onState, onError }: PageProps) {
  const list = app.settings.schedules
  const status = new Map(app.schedules.map((s) => [s.id, s]))
  const [picking, setPicking] = useState<number | null>(null)
  const update = (i: number, fn: (s: ScheduleConfig) => void) => save((st) => (fn(st.schedules[i]), st))
  const add = () =>
    save((st) => {
      st.schedules.push({
        id: `sch-${Date.now().toString(36)}`,
        name: 'New schedule',
        enabled: true,
        cwd: app.workspace ?? '',
        prompt: '',
        when: { kind: 'daily', time: '09:00', weekday: 1, hours: 24 },
        model: null,
      })
      return st
    })
  const pickFolder = (i: number) => api.schedules.pickFolder().then((dir) => dir && update(i, (s) => (s.cwd = dir)), onError)
  return (
    <>
      <Section>
        {list.length === 0 && (
          <div className="empty-box">
            <b>No schedules</b>
            <span className="muted small">Add one to run a prompt every day, every week or every few hours.</span>
          </div>
        )}
        {list.map((sch, i) => {
          const st = status.get(sch.id)
          const missing = !sch.cwd.trim() ? 'Choose a folder.' : !sch.prompt.trim() ? 'Write a prompt.' : null
          return (
            <div key={sch.id} className="provider-card schedule">
              <div className="provider-head">
                <Toggle label={`Enable ${sch.name}`} value={sch.enabled} onChange={(v) => update(i, (s) => (s.enabled = v))} />
                <b>{sch.name || 'Schedule'}</b>
                {st?.running && (
                  <span className="badge ok" role="status">
                    Running
                  </span>
                )}
                <div className="spacer" />
                <button className="btn ghost" disabled={!!missing || st?.running} onClick={() => api.schedules.runNow(sch.id).then(onState, onError)}>
                  Run now
                </button>
                <button className="link danger small" onClick={() => confirm(`Remove ${sch.name || 'this schedule'}?`) && save((x) => ((x.schedules = x.schedules.filter((y) => y.id !== sch.id)), x))}>
                  Remove
                </button>
              </div>
              <div className="muted small schedule-times">
                Last run: {st?.lastRun ? `${when(st.lastRun)} (${ago(st.lastRun)})` : 'never'} · Next run: {sch.enabled && !missing ? when(st?.nextRun ?? null) : 'off'}
              </div>
              {missing && <div className="small warn">{missing}</div>}
              {st?.error && <div className="notice notice-error small">Last run couldn't start: {st.error}</div>}
              <Row label="Name" labelFor={`sch-name-${sch.id}`} search="">
                <TextField label="Name" id={`sch-name-${sch.id}`} value={sch.name} onChange={(v) => update(i, (s) => (s.name = v))} />
              </Row>
              <Row label="Folder" hint="The chat runs here, with this folder's project instructions and extensions." search="">
                <div className="inline">
                  <span className="mono small schedule-path" title={sch.cwd}>
                    {sch.cwd || 'None'}
                  </span>
                  <button className="btn" onClick={() => pickFolder(i)}>
                    Choose…
                  </button>
                </div>
              </Row>
              <Row label="Prompt" hint="Sent as the first message. Slash commands work." wide search="">
                <TextField label="Prompt" multiline rows={4} value={sch.prompt} placeholder="Check the open pull requests and summarize what needs review." onChange={(v) => update(i, (s) => (s.prompt = v))} />
              </Row>
              <Row label="Frequency" search="">
                <div className="inline">
                  <Select label="Frequency" value={sch.when.kind} options={[...FREQUENCIES]} onChange={(v) => update(i, (s) => (s.when.kind = v))} />
                  {sch.when.kind === 'weekly' && <Select label="Weekday" value={String(sch.when.weekday)} options={WEEKDAYS} onChange={(v) => update(i, (s) => (s.when.weekday = Number(v)))} />}
                  {sch.when.kind !== 'interval' ? (
                    <input type="time" aria-label="Time" value={sch.when.time} onChange={(e) => e.target.value && update(i, (s) => (s.when.time = e.target.value))} />
                  ) : (
                    <IntervalField hours={sch.when.hours} onChange={(h) => update(i, (s) => (s.when.hours = h))} />
                  )}
                </div>
              </Row>
              <Row label="Model" search="">
                <div className="inline">
                  <button className="btn" onClick={() => setPicking(i)}>
                    {sch.model ? `${modelLabel(sch.model.modelId)} · ${sch.model.providerId}` : 'Default model'}
                  </button>
                  {sch.model && (
                    <button className="link small" onClick={() => update(i, (s) => (s.model = null))}>
                      reset
                    </button>
                  )}
                </div>
              </Row>
            </div>
          )
        })}
        <div>
          <button className="btn" onClick={add}>
            Add schedule
          </button>
        </div>
      </Section>
      {picking != null && <ModelPicker app={app} onClose={() => setPicking(null)} onState={onState} onError={onError} onPick={(r) => update(picking, (s) => (s.model = r))} title="Model for this schedule…" />}
    </>
  )
}

/** "Every N minutes/hours"; stored as hours. */
function IntervalField({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  const [unit, setUnit] = useState<'minutes' | 'hours'>(hours < 1 ? 'minutes' : 'hours')
  const shown = unit === 'minutes' ? Math.round(hours * 60) : Math.round(hours * 100) / 100
  return (
    <>
      <NumberField label="Interval" value={shown} min={1} onChange={(v) => v && onChange(unit === 'minutes' ? v / 60 : v)} />
      <Select
        label="Unit"
        value={unit}
        options={[
          { value: 'minutes', label: 'minutes' },
          { value: 'hours', label: 'hours' },
        ]}
        onChange={(u) => {
          setUnit(u)
          onChange(u === 'minutes' ? shown / 60 : shown)
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------- Sessions

const RETENTION = [
  { value: '', label: 'Keep forever' },
  { value: '7', label: 'After 7 days' },
  { value: '30', label: 'After 30 days' },
  { value: '90', label: 'After 90 days' },
  { value: '180', label: 'After 6 months' },
  { value: '365', label: 'After a year' },
]

export function SessionsPage({ app, save, onState, onError }: PageProps) {
  const days = app.settings.sessions.retentionDays
  const total = app.folders.reduce((n, f) => n + f.sessions.length, 0)
  const options = days == null || RETENTION.some((r) => r.value === String(days)) ? RETENTION : [...RETENTION, { value: String(days), label: `After ${days} days` }]
  return (
    <>
      <Section>
        <Row label="Delete old chats" hint="Chats nobody has opened or changed for this long are deleted at launch and every few hours. Open and running chats are kept.">
          <Select
            label="Delete old chats"
            value={days == null ? '' : String(days)}
            options={options}
            onChange={(v) => {
              const n = v ? Number(v) : null
              // Shorter retention deletes chats right away, in every folder.
              if (n != null && (days == null || n < days) && !confirm(`Delete every chat not changed in the last ${n} days, in all folders? This happens now and keeps happening. Deleted chats can't be restored.`)) return
              save((s) => ((s.sessions.retentionDays = n), s))
            }}
          />
        </Row>
        <Row label="Search past chats" hint="The session_search tool: the agent can look up earlier chats in the same folder.">
          {toolToggle(app, save, 'session_search', 'Search past chats')}
        </Row>
      </Section>
      <Section title="Stored chats">
        <Row label="Chats" hint={`${total} in the open folders. Chats are JSON files in ${app.paths.sessions}.`}>
          <div className="inline">
            <button className="btn" onClick={() => api.app.openPath(app.paths.sessions)}>
              Open folder
            </button>
            <button className="btn ghost danger" onClick={() => confirm('Delete ALL chats in every folder? This cannot be undone.') && api.sessions.removeAll().then(onState, onError)}>
              Delete all chats
            </button>
          </div>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Plugins

const shortSha = (sha: string) => sha.slice(0, 7)
const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export function PluginsPage({ app, onState, onError }: PageProps) {
  const [open, setOpen] = useState<string | null>(null)
  const dialogPlugin = app.plugins.find((p) => p.id === open)
  const remove = (p: PluginInfo) => confirm(`Remove the ${p.name} plugin? Its tools, skills and files are deleted.`) && api.plugins.remove(p.id).then(onState, onError)
  return (
    <>
      <Section>
        {app.plugins.map((p) => {
          const inst = p.installed
          const update = !!inst && inst.pin !== p.pin
          return (
            <div key={p.id} className="provider-card plugin-card">
              <div className="provider-head">
                {inst && <Toggle label={`Turn on ${p.name}`} value={inst.enabled} onChange={(v) => api.plugins.setEnabled(p.id, v).then(onState, onError)} />}
                <b>{p.name}</b>
                <span className="badge reviewed">Reviewed</span>
                {inst ? (
                  <span className={`badge ${inst.enabled ? 'ok' : ''}`} title={inst.dir}>
                    {inst.enabled ? 'On' : 'Off'} · {inst.scope === 'user' ? 'All projects' : `Project ${folderName(inst.cwd ?? '')}`}
                  </span>
                ) : (
                  p.detected && (
                    <span className="badge" title={p.detected}>
                      Found on this computer
                    </span>
                  )
                )}
                <div className="spacer" />
                {p.busy && <span className="spinner" aria-label="Installing" />}
                {!inst && (
                  <button className="btn" disabled={p.busy} onClick={() => setOpen(p.id)}>
                    Install…
                  </button>
                )}
                {update && (
                  <button className="btn" disabled={p.busy} onClick={() => setOpen(p.id)}>
                    Update…
                  </button>
                )}
                {inst && (
                  <button className="link danger small" disabled={p.busy} onClick={() => remove(p)}>
                    Remove
                  </button>
                )}
              </div>
              <p className="muted small plugin-desc">
                {p.description} Adds {includesText(p.includes)}.
              </p>
              {update && inst && (
                <p className="small plugin-desc">
                  An update is available: <code>{shortSha(inst.pin)}</code> installed, <code>{shortSha(p.pin)}</code> reviewed.
                </p>
              )}
              {inst && !update && (
                <div className="inline small">
                  <span className="muted">
                    Commit <code title={inst.pin}>{shortSha(inst.pin)}</code>
                  </span>
                  <button className="link small" onClick={() => api.app.openPath(inst.dir)}>
                    Open folder
                  </button>
                  <button className="link small" onClick={() => setOpen(p.id)}>
                    Details…
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </Section>
      {dialogPlugin && <PluginDialog plugin={dialogPlugin} workspace={app.workspace} onClose={() => setOpen(null)} onState={onState} />}
    </>
  )
}

// ---------------------------------------------------------------- About

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'checking':
      return 'Checking…'
    case 'none':
      return 'You are up to date.'
    case 'available':
      return `Version ${u.version} is available and downloading.`
    case 'downloading':
      return `Downloading… ${u.percent ?? 0}%`
    case 'ready':
      return `Version ${u.version} is ready. Restart to install it.`
    case 'manual':
      return `Version ${u.version} is available. This build can't install updates itself, so download it from GitHub.`
    case 'error':
      return u.message
    default:
      return ''
  }
}

export function VersionPage({ app, save, update }: PageProps) {
  return (
    <Section>
      <Row label="Version" hint={updateText(update) || `Xarı Bülbül ${app.version}`}>
        <div className="inline">
          <span className="mono">{app.version}</span>
          {update.state === 'manual' && (
            <button className="btn" onClick={() => api.app.openExternal(update.url)}>
              Download {update.version}
            </button>
          )}
          {update.state === 'ready' && (
            <button className="btn primary" onClick={() => api.app.installUpdate()}>
              Restart and install
            </button>
          )}
          <button className="btn" onClick={() => api.app.checkForUpdates()}>
            Check now
          </button>
        </div>
      </Row>
      <Row label="Check for updates automatically" hint="Downloads new versions from GitHub Releases and installs them when you restart.">
        <Toggle label="Check for updates automatically" value={app.settings.app.autoUpdate} onChange={(v) => save((s) => ((s.app.autoUpdate = v), s))} />
      </Row>
      <Row label="Source code" hint="Open source, MIT licensed.">
        <button className="link small" onClick={() => api.app.openExternal('https://github.com/Parzival-Samanyolu/xari-bulbul')}>
          github.com/Parzival-Samanyolu/xari-bulbul ↗
        </button>
      </Row>
    </Section>
  )
}
