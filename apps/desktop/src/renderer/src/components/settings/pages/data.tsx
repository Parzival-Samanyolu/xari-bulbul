import { useState } from 'react'
import { CHATGPT_PROVIDER_ID, ManageUsageLink } from '../../ChatGpt'
import type { PluginInfo, Settings, UpdateStatus } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { cost, modelLabel, tokens } from '../../../lib/format'
import { useFormat, useT } from '../../../lib/i18n'
import { NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import { ModelPicker } from '../../ModelPicker'
import { PluginDialog, includesText } from '../../PluginDialog'
import type { PageProps } from '../common'
import { toolToggle } from './advanced'
import { rich } from '../../../lib/rich'

type T = ReturnType<typeof useT>['t']

// ---------------------------------------------------------------- Usage

export function UsagePage({ app, save, onState, onError }: PageProps) {
  const { t, lang } = useT()
  const u = app.settings.usage
  const sum = app.usage
  const byModel = Object.entries(sum.byModel).sort((a, b) => b[1].cost - a[1].cost || b[1].requests - a[1].requests)
  const plan = app.chatgpt
  return (
    <>
      {(plan.signedIn || plan.usage.totals.requests > 0) && (
        <Section title={t('settings.chatgpt.usageTitle')} description={t('settings.chatgpt.usageIntro', { days: plan.usage.days })}>
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">{t('settings.data.requests')}</th>
                <th scope="col">{t('settings.data.promptTokens')}</th>
                <th scope="col">{t('settings.data.completion')}</th>
                <th scope="col">{t('settings.chatgpt.activeDays')}</th>
                <th scope="col">{t('settings.chatgpt.peakDay')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{plan.usage.totals.requests}</td>
                <td>{tokens(lang, plan.usage.totals.promptTokens)}</td>
                <td>{tokens(lang, plan.usage.totals.completionTokens)}</td>
                <td>{plan.usage.activeDays}</td>
                <td>{tokens(lang, plan.usage.peakDayTokens)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small">
            {t('settings.chatgpt.manageHint')} <ManageUsageLink />
          </p>
        </Section>
      )}
      <Section description={t('settings.data.usageIntro')}>
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">{t('settings.data.period')}</th>
              <th scope="col">{t('settings.data.requests')}</th>
              <th scope="col">{t('settings.data.promptTokens')}</th>
              <th scope="col">{t('settings.data.completion')}</th>
              <th scope="col">{t('settings.data.cached')}</th>
              <th scope="col">{t('settings.data.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['session', t('settings.data.thisChat'), sum.session],
                ['today', t('settings.data.today'), sum.today],
                ['all', t('settings.data.allTime'), sum.allTime],
              ] as const
            ).map(([id, label, row]) => (
              <tr key={id}>
                <th scope="row">{label}</th>
                <td>{row.requests}</td>
                <td>{tokens(lang, row.promptTokens)}</td>
                <td>{tokens(lang, row.completionTokens)}</td>
                <td>{tokens(lang, row.cachedTokens)}</td>
                <td>{cost(lang, row.cost, row.costPartial)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {byModel.length > 0 && (
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">{t('settings.data.byModel')}</th>
                <th scope="col">{t('settings.data.requests')}</th>
                <th scope="col">{t('settings.data.promptTokens')}</th>
                <th scope="col">{t('settings.data.completion')}</th>
                <th scope="col">{t('settings.data.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map(([k, row]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{row.requests}</td>
                  <td>{tokens(lang, row.promptTokens)}</td>
                  <td>{tokens(lang, row.completionTokens)}</td>
                  <td>
                    {!k.startsWith(`${CHATGPT_PROVIDER_ID}:`)
                      ? cost(lang, row.cost, row.costPartial)
                      : row.apiCost > 0
                        ? t('settings.chatgpt.planApiCost', { value: cost(lang, row.apiCost) })
                        : t('settings.chatgpt.planCost')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="inline">
          <button className="btn" onClick={() => api.usage.exportCsv().catch(onError)}>
            {t('settings.data.exportCsv')}
          </button>
          <button className="btn ghost danger" onClick={() => confirm(t('settings.data.clearUsageConfirm')) && api.usage.clear().then(onState, onError)}>
            {t('settings.data.clearHistory')}
          </button>
        </div>
      </Section>
      <Section title={t('settings.data.display')}>
        <Row label={t('settings.data.showCost')} search="Show cost" hint={t('settings.data.showCostHint')}>
          <Toggle label={t('settings.data.showCost')} value={u.showCost} onChange={(v) => save((s) => ((s.usage.showCost = v), s))} />
        </Row>
        <Row label={t('settings.data.showLastRequest')} search="Show the last request in the status bar" hint={t('settings.data.showLastRequestHint')}>
          <Toggle label={t('settings.data.showLastRequest')} value={u.showPerMessageUsage} onChange={(v) => save((s) => ((s.usage.showPerMessageUsage = v), s))} />
        </Row>
      </Section>
      <Section title={t('settings.data.budgets')} description={t('settings.data.budgetsHint')}>
        <Row label={t('settings.data.chatBudget')} search="Per-chat budget">
          <NumberField label={t('settings.data.chatBudget')} nullable value={u.sessionBudgetUsd} min={0} step={0.5} placeholder={t('settings.data.noLimit')} suffix="USD" onChange={(v) => save((s) => ((s.usage.sessionBudgetUsd = v), s))} />
        </Row>
        <Row label={t('settings.data.dailyBudget')} search="Daily budget">
          <NumberField label={t('settings.data.dailyBudget')} nullable value={u.dailyBudgetUsd} min={0} step={1} placeholder={t('settings.data.noLimit')} suffix="USD" onChange={(v) => save((s) => ((s.usage.dailyBudgetUsd = v), s))} />
        </Row>
        <Row label={t('settings.data.budgetReached')} search="When a budget is reached">
          <Select
            label={t('settings.data.budgetReached')}
            value={u.budgetAction}
            options={[
              { value: 'warn', label: t('settings.data.budgetWarn') },
              { value: 'stop', label: t('settings.data.budgetStop') },
            ]}
            onChange={(v) => save((s) => ((s.usage.budgetAction = v), s))}
          />
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Sessions

const retention = (t: T) => [
  { value: '', label: t('settings.data.keepForever') },
  { value: '7', label: t('settings.data.afterDays', { count: 7 }) },
  { value: '30', label: t('settings.data.afterDays', { count: 30 }) },
  { value: '90', label: t('settings.data.afterDays', { count: 90 }) },
  { value: '180', label: t('settings.data.afterSixMonths') },
  { value: '365', label: t('settings.data.afterYear') },
]

export function SessionsPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const days = app.settings.sessions.retentionDays
  const total = app.folders.reduce((n, f) => n + f.sessions.length, 0)
  const base = retention(t)
  const options = days == null || base.some((r) => r.value === String(days)) ? base : [...base, { value: String(days), label: t('settings.data.afterDays', { count: days }) }]
  return (
    <>
      <Section>
        <Row label={t('settings.data.deleteOldChats')} search="Delete old chats" hint={t('settings.data.deleteOldChatsHint')}>
          <Select
            label={t('settings.data.deleteOldChats')}
            value={days == null ? '' : String(days)}
            options={options}
            onChange={(v) => {
              const n = v ? Number(v) : null
              // Shorter retention deletes chats right away, in every folder.
              if (n != null && (days == null || n < days) && !confirm(t('settings.data.retentionConfirm', { count: n }))) return
              save((s) => ((s.sessions.retentionDays = n), s))
            }}
          />
        </Row>
        <Row label={t('settings.data.searchPastChats')} search="Search past chats" hint={t('settings.data.searchPastChatsHint')}>
          {toolToggle(app, save, 'session_search', t('settings.data.searchPastChats'))}
        </Row>
      </Section>
      <Section title={t('settings.data.storedChats')} search="Stored chats">
        <Row label={t('settings.data.chats')} search="Chats" hint={t('settings.data.chatsHint', { count: total, path: app.paths.sessions })}>
          <div className="inline">
            <button className="btn" onClick={() => api.app.openPath(app.paths.sessions)}>
              {t('settings.parts.openFolder')}
            </button>
            <button className="btn ghost danger" onClick={() => confirm(t('settings.data.deleteAllChatsConfirm')) && api.sessions.removeAll().then(onState, onError)}>
              {t('settings.data.deleteAllChats')}
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
  const { t, lang } = useT()
  const [open, setOpen] = useState<string | null>(null)
  const dialogPlugin = app.plugins.find((p) => p.id === open)
  const remove = (p: PluginInfo) => confirm(t('settings.data.removePluginConfirm', { name: p.name })) && api.plugins.remove(p.id).then(onState, onError)
  return (
    <>
      <Section>
        {app.plugins.map((p) => {
          const inst = p.installed
          const update = !!inst && inst.pin !== p.pin
          return (
            <div key={p.id} className="provider-card plugin-card">
              <div className="provider-head">
                {inst && <Toggle label={t('settings.data.turnOnPlugin', { name: p.name })} value={inst.enabled} onChange={(v) => api.plugins.setEnabled(p.id, v).then(onState, onError)} />}
                <b>{p.name}</b>
                <span className="badge reviewed">{t('settings.data.reviewed')}</span>
                {inst ? (
                  <span className={`badge ${inst.enabled ? 'ok' : ''}`} title={inst.dir}>
                    {inst.enabled ? t('common.on') : t('common.off')} · {inst.scope === 'user' ? t('settings.data.allProjects') : t('settings.data.projectScope', { name: folderName(inst.cwd ?? '') })}
                  </span>
                ) : (
                  p.detected && (
                    <span className="badge" title={p.detected}>
                      {t('settings.data.foundOnComputer')}
                    </span>
                  )
                )}
                <div className="spacer" />
                {p.busy && <span className="spinner" aria-label={t('settings.data.installing')} />}
                {!inst && (
                  <button className="btn" disabled={p.busy} onClick={() => setOpen(p.id)}>
                    {t('settings.data.install')}
                  </button>
                )}
                {update && (
                  <button className="btn" disabled={p.busy} onClick={() => setOpen(p.id)}>
                    {t('settings.data.updatePlugin')}
                  </button>
                )}
                {inst && (
                  <button className="link danger small" disabled={p.busy} onClick={() => remove(p)}>
                    {t('common.remove')}
                  </button>
                )}
              </div>
              <p className="muted small plugin-desc">
                {p.description} {t('settings.data.pluginAdds', { what: includesText(p.includes, t, lang) })}
              </p>
              {update && inst && (
                <p className="small plugin-desc">
                  {rich(t('settings.data.pluginUpdateAvailable'), { installed: <code>{shortSha(inst.pin)}</code>, reviewed: <code>{shortSha(p.pin)}</code> })}
                </p>
              )}
              {inst && !update && (
                <div className="inline small">
                  <span className="muted">{rich(t('settings.data.pluginCommit'), { sha: <code title={inst.pin}>{shortSha(inst.pin)}</code> })}</span>
                  <button className="link small" onClick={() => api.app.openPath(inst.dir)}>
                    {t('settings.parts.openFolder')}
                  </button>
                  <button className="link small" onClick={() => setOpen(p.id)}>
                    {t('settings.data.details')}
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

function updateText(t: T, u: UpdateStatus): string {
  switch (u.state) {
    case 'checking':
      return t('settings.parts.checking')
    case 'none':
      return t('settings.data.upToDate')
    case 'available':
      return t('settings.data.updateAvailable', { version: u.version ?? '' })
    case 'downloading':
      return t('settings.data.updateDownloading', { percent: u.percent ?? 0 })
    case 'ready':
      return t('settings.data.updateReady', { version: u.version ?? '' })
    case 'manual':
      return t('settings.data.updateManual', { version: u.version })
    case 'error':
      return u.message
    default:
      return ''
  }
}

export function VersionPage({ app, save, update }: PageProps) {
  const { t } = useT()
  return (
    <Section>
      <Row label={t('settings.data.version')} search="Version" hint={updateText(t, update) || `Xarı Bülbül ${app.version}`}>
        <div className="inline">
          <span className="mono">{app.version}</span>
          {update.state === 'manual' && (
            <button className="btn" onClick={() => api.app.openExternal(update.url)}>
              {t('settings.data.downloadVersion', { version: update.version })}
            </button>
          )}
          {update.state === 'ready' && (
            <button className="btn primary" onClick={() => api.app.installUpdate()}>
              {t('settings.data.restartInstall')}
            </button>
          )}
          <button className="btn" onClick={() => api.app.checkForUpdates()}>
            {t('settings.data.checkNow')}
          </button>
        </div>
      </Row>
      <Row label={t('settings.data.autoUpdate')} search="Check for updates automatically" hint={t('settings.data.autoUpdateHint')}>
        <Toggle label={t('settings.data.autoUpdate')} value={app.settings.app.autoUpdate} onChange={(v) => save((s) => ((s.app.autoUpdate = v), s))} />
      </Row>
      <Row label={t('settings.data.sourceCode')} search="Source code" hint={t('settings.data.sourceCodeHint')}>
        <button className="link small" onClick={() => api.app.openExternal('https://github.com/Parzival-Samanyolu/xari-bulbul')}>
          github.com/Parzival-Samanyolu/xari-bulbul ↗
        </button>
      </Row>
    </Section>
  )
}
