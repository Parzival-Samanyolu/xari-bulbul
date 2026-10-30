import { useEffect, useRef, useState } from 'react'
import type { AppState, PluginInfo } from '../../../shared/ipc'
import { api } from '../lib/api'

type Scope = 'user' | 'project'

const short = (sha: string) => sha.slice(0, 7)

/** "2 tools and 1 skill" */
export function includesText(inc: PluginInfo['includes']): string {
  const parts = [
    [inc.tools.length, 'tool'],
    [inc.skills.length, 'skill'],
    [inc.commands.length, 'command'],
    [inc.mcpServers.length, 'MCP server'],
  ]
    .filter(([n]) => n)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing')
}

interface Props {
  plugin: PluginInfo
  workspace: string | null
  onClose: () => void
  onState: (s: AppState) => void
}

/** Install (or update) a catalog plugin: what it is, what it adds, where it goes. */
export function PluginDialog({ plugin, workspace, onClose, onState }: Props) {
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
            {update ? `Update ${plugin.name}` : plugin.name}
          </span>
          <span className="badge reviewed" title="We reviewed these files at the pinned commit">
            Reviewed
          </span>
        </div>
        <p className="plugin-summary">{plugin.description}</p>
        <p className="muted small">
          Adds {includesText(plugin.includes)}. Every file is checked against the reviewed version before it's installed, and the plugin turns on right away.
          {plugin.detected && <> Found on this computer at <code>{plugin.detected}</code>.</>}
        </p>
        {update && installed && (
          <div className="plugin-kv">
            <span className="muted">Version</span>
            <span>
              <code>{short(installed.pin)}</code> installed, <code>{short(plugin.pin)}</code> available
            </span>
          </div>
        )}
        <div className="plugin-kv">
          <label className="muted" htmlFor="plugin-scope">
            Install for
          </label>
          <span>
            <select id="plugin-scope" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="user">All projects</option>
              <option value="project" disabled={!workspace}>
                This project{workspace ? '' : ' (open a folder first)'}
              </option>
            </select>
          </span>
        </div>
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="plugin-details">
            <div className="plugin-kv">
              <span className="muted">Source</span>
              <span>
                <button className="link" onClick={() => api.app.openExternal(plugin.sourceUrl)}>
                  {plugin.sourceUrl.replace(/^https:\/\//, '')}
                </button>
                {' · '}
                <button className="link" onClick={() => api.app.openExternal(plugin.treeUrl)}>
                  View plugin files
                </button>
              </span>
            </div>
            <div className="plugin-kv">
              <span className="muted">Reviewed commit</span>
              <code title={plugin.pin}>{short(plugin.pin)}</code>
            </div>
            {names('Tools', plugin.includes.tools)}
            {names('Skills', plugin.includes.skills)}
            {names('Commands', plugin.includes.commands)}
            {names('MCP servers', plugin.includes.mcpServers)}
            <div className="plugin-kv">
              <span className="muted">Installs to</span>
              <code className="plugin-path">{path ?? 'Open a project folder first'}</code>
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
            Cancel
          </button>
          <button className="btn primary" ref={primary} onClick={install} disabled={!canInstall} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? (update ? 'Updating…' : 'Installing…') : update ? 'Update' : installed ? 'Reinstall' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}
