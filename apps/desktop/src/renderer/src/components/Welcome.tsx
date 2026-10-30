import { useState } from 'react'
import type { AppState } from '../../../shared/ipc'
import { api } from '../lib/api'
import mark from '../assets/mark.png'
import { LayoutPicker, withLayout, type Layout } from './LayoutPicker'
import { PluginDialog } from './PluginDialog'

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onSettings: (tab?: string) => void
}

export function Welcome({ app, onState, onError, onSettings }: Props) {
  const connected = Object.values(app.ready).some(Boolean)
  const hasFolder = !!app.workspace
  // The first unfinished step carries the primary action.
  const next = !connected ? 'connect' : !hasFolder ? 'folder' : null
  const recents = app.settings.app.recentWorkspaces.filter((w) => w !== app.workspace)
  const [layout, setLayout] = useState<Layout>(app.settings.appearance.layout)
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
      <p className="muted">An AI coding agent that works in your project, with any model you like.</p>
      {!app.settings.app.layoutChosen && (
        <section className="layout-card" aria-labelledby="layout-q">
          <h2 id="layout-q">Which layout?</h2>
          <p className="muted small">You can change it later in Settings → Appearance.</p>
          <LayoutPicker value={layout} onChange={setLayout} />
          <div className="layout-actions">
            <button className="btn primary" onClick={() => api.settings.set(withLayout(app.settings, layout)).then(onState, onError)}>
              Continue
            </button>
          </div>
        </section>
      )}
      <ol className="steps">
        <li className={connected ? 'done' : ''}>
          <div>
            <b>Connect a model</b>
            <div className="muted small">
              {connected
                ? 'A provider is ready.'
                : 'Add an OpenRouter or Ollama Cloud key (both have free models), or add a local Ollama / LM Studio server, which needs no key.'}
            </div>
          </div>
          <button className={`btn ${next === 'connect' ? 'primary' : ''}`} onClick={() => onSettings('providers')}>
            {connected ? 'Manage providers' : 'Connect…'}
          </button>
        </li>
        <li className={hasFolder ? 'done' : ''}>
          <div>
            <b>Open a project folder</b>
            <div className="muted small">{app.workspace ?? 'Xarı Bülbül works inside one folder at a time.'}</div>
          </div>
          <button className={`btn ${next === 'folder' ? 'primary' : ''}`} onClick={() => api.workspace.pick().then(onState, onError)}>
            {hasFolder ? 'Change folder…' : 'Open folder…'}
          </button>
        </li>
      </ol>
      {suggestions.map((p) => (
        <section key={p.id} className="plugin-suggestion" aria-label={`${p.name} plugin`}>
          <div>
            <b>Found {p.name}. Want its plugin?</b>
            <div className="muted small">{p.description}</div>
          </div>
          <div className="inline">
            <button className="btn ghost" onClick={() => skip(p.id)}>
              Skip
            </button>
            <button className="btn" onClick={() => setInstalling(p.id)}>
              Review and install…
            </button>
          </div>
        </section>
      ))}
      {dialogPlugin && <PluginDialog plugin={dialogPlugin} workspace={app.workspace} onClose={() => setInstalling(null)} onState={onState} />}
      {recents.length > 0 && (
        <div className="recents">
          <div className="muted small">Recent folders</div>
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
