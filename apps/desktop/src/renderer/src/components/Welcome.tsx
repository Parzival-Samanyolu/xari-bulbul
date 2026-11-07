import { useState } from 'react'
import type { AppState } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import mark from '../assets/mark.png'
import { PluginDialog } from './PluginDialog'

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onSettings: (tab?: string) => void
}

export function Welcome({ app, onState, onError, onSettings }: Props) {
  const { t } = useT()
  const connected = Object.values(app.ready).some(Boolean)
  const hasFolder = !!app.workspace
  // The first unfinished step carries the primary action.
  const next = !connected ? 'connect' : !hasFolder ? 'folder' : null
  const recents = app.settings.app.recentWorkspaces.filter((w) => w !== app.workspace)
  const [installing, setInstalling] = useState<string | null>(null)
  const skipped = app.settings.app.skippedPlugins
  const suggestions = app.plugins.filter((p) => p.detected && !p.installed && !skipped.includes(p.id))
  const dialogPlugin = app.plugins.find((p) => p.id === installing)
  const skip = (id: string) => {
    const next = structuredClone(app.settings)
    next.app.skippedPlugins = [...skipped, id]
    api.settings.set(next).then(onState, onError)
  }

  return (
    <div className="welcome">
      <img className="welcome-mark" src={mark} alt="" width={96} height={76} />
      <h1>Xarı Bülbül</h1>
      <p className="muted">{t('bots.welcome.tagline')}</p>
      <ol className="steps">
        <li className={connected ? 'done' : ''}>
          <div>
            <b>{t('bots.welcome.connect')}</b>
            <div className="muted small">
              {connected
                ? t('bots.welcome.ready')
                : t('bots.welcome.connectHint')}
            </div>
          </div>
          <button className={`btn ${next === 'connect' ? 'primary' : ''}`} onClick={() => onSettings('providers')}>
            {connected ? t('bots.welcome.manage') : t('bots.welcome.connectButton')}
          </button>
        </li>
        <li className={hasFolder ? 'done' : ''}>
          <div>
            <b>{t('bots.welcome.openProject')}</b>
            <div className="muted small">{app.workspace ?? t('bots.welcome.oneFolder')}</div>
          </div>
          <button className={`btn ${next === 'folder' ? 'primary' : ''}`} onClick={() => api.workspace.pick().then(onState, onError)}>
            {hasFolder ? t('bots.welcome.changeFolder') : t('bots.sidebar.openFolder')}
          </button>
        </li>
      </ol>
      {suggestions.map((p) => (
        <section key={p.id} className="plugin-suggestion" aria-label={t('bots.welcome.pluginLabel', { name: p.name })}>
          <div>
            <b>{t('bots.welcome.pluginFound', { name: p.name })}</b>
            <div className="muted small">{p.description}</div>
          </div>
          <div className="inline">
            <button className="btn ghost" onClick={() => skip(p.id)}>
              {t('bots.welcome.skip')}
            </button>
            <button className="btn" onClick={() => setInstalling(p.id)}>
              {t('bots.welcome.review')}
            </button>
          </div>
        </section>
      ))}
      {dialogPlugin && <PluginDialog plugin={dialogPlugin} workspace={app.workspace} onClose={() => setInstalling(null)} onState={onState} />}
      {recents.length > 0 && (
        <div className="recents">
          <div className="muted small">{t('bots.welcome.recent')}</div>
          {recents.map((w) => (
            <button key={w} className="link" onClick={() => api.workspace.set(w).then(onState, onError)}>
              {w}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
