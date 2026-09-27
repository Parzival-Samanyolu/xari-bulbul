import type { AppState } from '../../../shared/ipc'
import { api } from '../lib/api'
import mark from '../assets/mark.png'

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

  return (
    <div className="welcome">
      <img className="welcome-mark" src={mark} alt="" width={96} height={76} />
      <h1>Xarı Bülbül</h1>
      <p className="muted">An AI coding agent that works in your project, with any model you like.</p>
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
