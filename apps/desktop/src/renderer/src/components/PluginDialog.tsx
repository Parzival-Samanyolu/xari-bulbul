import { useEffect, useRef, useState } from 'react'
import type { AppState, PluginInfo } from '../../../shared/ipc'
import { makeT } from '@harness/core/i18n'
import { CATALOGS, type MessageKey } from '../../../shared/i18n/catalog'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { rich } from '../lib/rich'

type Scope = 'user' | 'project'

const short = (sha: string) => sha.slice(0, 7)

const english = makeT<MessageKey>('en', CATALOGS)

/** "2 tools and 1 skill", in the language of `t` (English when it isn't given). */
export function includesText(inc: PluginInfo['includes'], t: (key: MessageKey, vars?: Record<string, string | number>) => string = english, lang = 'en'): string {
  const parts = (
    [
      [inc.tools.length, 'bots.plugin.countTools'],
      [inc.skills.length, 'bots.plugin.countSkills'],
      [inc.commands.length, 'bots.plugin.countCommands'],
      [inc.mcpServers.length, 'bots.plugin.countMcpServers'],
    ] as const
  )
    .filter(([n]) => n)
    .map(([n, key]) => t(key, { count: n }))
  return parts.length ? new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(parts) : t('bots.plugin.nothing')
}

interface Props {
  plugin: PluginInfo
  workspace: string | null
  onClose: () => void
  onState: (s: AppState) => void
}

/** Install (or update) a catalog plugin: what it is, what it adds, where it goes. */
export function PluginDialog({ plugin, workspace, onClose, onState }: Props) {
  const { t, lang } = useT()
  const installed = plugin.installed
  const update = !!installed && installed.pin !== plugin.pin
  const [scope, setScope] = useState<Scope>(installed?.scope ?? 'user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => primary.current?.focus(), [])

  const path = scope === 'user' ? plugin.installPaths.user : plugin.installPaths.project
  const canInstall = !busy && !!path

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      onState(await api.plugins.install(plugin.id, scope))
      onClose()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) onClose()
    if (e.key === 'Tab') {
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>('summary, select, button:not([disabled])') ?? [])]
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) (e.preventDefault(), f.at(-1)?.focus())
      else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0]?.focus())
    }
  }

  const names = (label: string, list: string[]) =>
    list.length > 0 && (
      <div className="plugin-kv">
        <span className="muted">{label}</span>
        <span>
          {list.map((n, i) => (
            <span key={n}>
              {i > 0 && ', '}
              <code>{n}</code>
            </span>
          ))}
        </span>
      </div>
    )

  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <div className="dialog plugin-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="plugin-dialog-title" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="plugin-title">
          <span className="dialog-title" id="plugin-dialog-title">
            {update ? t('bots.plugin.updateNamed', { name: plugin.name }) : plugin.name}
          </span>
          <span className="badge reviewed" title={t('bots.plugin.reviewedTitle')}>
            {t('bots.plugin.reviewed')}
          </span>
        </div>
        <p className="plugin-summary">{plugin.description}</p>
        <p className="muted small">
          {t('bots.plugin.adds', { items: includesText(plugin.includes, t, lang) })}
          {plugin.detected && <> {rich(t('bots.plugin.found'), { path: <code>{plugin.detected}</code> })}</>}
        </p>
        {update && installed && (
          <div className="plugin-kv">
            <span className="muted">{t('bots.plugin.version')}</span>
            <span>{rich(t('bots.plugin.versions'), { installed: <code>{short(installed.pin)}</code>, available: <code>{short(plugin.pin)}</code> })}</span>
          </div>
        )}
        <div className="plugin-kv">
          <label className="muted" htmlFor="plugin-scope">
            {t('bots.plugin.installFor')}
          </label>
          <span>
            <select id="plugin-scope" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="user">{t('bots.plugin.allProjects')}</option>
              <option value="project" disabled={!workspace}>
                {workspace ? t('bots.plugin.thisProject') : t('bots.plugin.thisProjectNoFolder')}
              </option>
            </select>
          </span>
        </div>
        <details className="advanced">
          <summary>{t('bots.dialog.advanced')}</summary>
          <div className="plugin-details">
            <div className="plugin-kv">
              <span className="muted">{t('bots.plugin.source')}</span>
              <span>
                <button className="link" onClick={() => api.app.openExternal(plugin.sourceUrl)}>
                  {plugin.sourceUrl.replace(/^https:\/\//, '')}
                </button>
                {' · '}
                <button className="link" onClick={() => api.app.openExternal(plugin.treeUrl)}>
                  {t('bots.plugin.viewFiles')}
                </button>
              </span>
            </div>
            <div className="plugin-kv">
              <span className="muted">{t('bots.plugin.reviewedCommit')}</span>
              <code title={plugin.pin}>{short(plugin.pin)}</code>
            </div>
            {names(t('bots.dialog.tools'), plugin.includes.tools)}
            {names(t('bots.dialog.skills'), plugin.includes.skills)}
            {names(t('bots.plugin.commands'), plugin.includes.commands)}
            {names(t('bots.plugin.mcpServers'), plugin.includes.mcpServers)}
            <div className="plugin-kv">
              <span className="muted">{t('bots.plugin.installsTo')}</span>
              <code className="plugin-path">{path ?? t('bots.plugin.openProject')}</code>
            </div>
          </div>
        </details>
        {error && (
          <div className="notice notice-error small" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions plugin-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" ref={primary} onClick={install} disabled={!canInstall} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? (update ? t('bots.plugin.updating') : t('bots.plugin.installing')) : update ? t('bots.plugin.update') : installed ? t('bots.plugin.reinstall') : t('bots.plugin.install')}
          </button>
        </div>
      </div>
    </div>
  )
}
