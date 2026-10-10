import type { AppState, UpdateStatus } from '../../../shared/ipc'
import type { LiveState } from '../App'
import { api } from '../lib/api'
import { cost, modelLabel, tokens } from '../lib/format'

interface Props {
  app: AppState
  live: LiveState
  onOpenPicker: () => void
  onUsage: () => void
  update: UpdateStatus
}

export function StatusBar({ app, live, onOpenPicker, onUsage, update }: Props) {
  const s = app.usage.session
  const t = app.usage.today
  const showCost = app.settings.usage.showCost
  const ctx = live.context
  const pct = ctx ? Math.min(100, Math.round((ctx.tokens / ctx.length) * 100)) : null
  const budget = app.settings.usage.sessionBudgetUsd
  const model = app.session?.meta.model

  return (
    <footer className="statusbar">
      <button className="sb-item" onClick={onOpenPicker} title="Switch model">
        {model ? modelLabel(model.modelId) : '—'}
      </button>
      <span className="sb-sep" />
      <button className="sb-item" onClick={onUsage} title="Session tokens: prompt ↑ / completion ↓ (cached)">
        <b>{tokens(s.promptTokens)}</b>↑ <b>{tokens(s.completionTokens)}</b>↓{s.cachedTokens > 0 && <span className="muted"> ({tokens(s.cachedTokens)} cached)</span>}
      </button>
      <button className="sb-item" onClick={onUsage} title="Requests this session / today">
        <b>{s.requests}</b> req<span className="muted"> · {t.requests} today</span>
      </button>
      {showCost && (
        <button className={`sb-item ${budget != null && s.cost >= budget ? 'warn' : ''}`} onClick={onUsage} title="Cost this session / today (+ = some requests had unknown cost)">
          <b>{cost(s.cost, s.costPartial)}</b>
          {budget != null && <span className="muted"> / {cost(budget)}</span>}
          <span className="muted"> · {cost(t.cost, t.costPartial)} today</span>
        </button>
      )}
      {live.lastUsage && app.settings.usage.showPerMessageUsage && (
        <span className="sb-item muted" title="Last request">
          last: {tokens(live.lastUsage.prompt)}↑ {tokens(live.lastUsage.completion)}↓{showCost && live.lastUsage.cost != null ? ` ${cost(live.lastUsage.cost)}` : ''}
        </span>
      )}
      <div className="spacer" />
      {pct != null && (
        <span className="sb-item" title={`Context: ${tokens(ctx!.tokens)} of ${tokens(ctx!.length)} tokens`}>
          <span className="meter">
            <span className={`meter-fill ${pct > 80 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
          </span>
          {pct}% ctx
        </span>
      )}
      {update.state === 'ready' && (
        <button className="sb-item accent" onClick={() => api.app.installUpdate()}>
          Restart to update {update.version}
        </button>
      )}
      {update.state === 'manual' && (
        <button className="sb-item accent" onClick={() => api.app.openExternal(update.url)}>
          Download update {update.version}
        </button>
      )}
      {update.state === 'downloading' && <span className="sb-item muted">Downloading update {update.percent}%</span>}
    </footer>
  )
}
