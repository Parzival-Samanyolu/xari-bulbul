import type { AppState, UpdateStatus } from '../../../shared/ipc'
import type { LiveState } from '../App'
import { api } from '../lib/api'
import { cost, modelLabel, tokens } from '../lib/format'
import { cpuText, useResources } from '../lib/resources'
import { useFormat, useT } from '../lib/i18n'
import { rich } from '../lib/rich'

interface Props {
  app: AppState
  live: LiveState
  onOpenPicker: () => void
  onUsage: () => void
  /** Opens Settings › Logs & performance. */
  onResources: () => void
  update: UpdateStatus
  /** Toggles for the bottom (terminal) and right (files, changes) panels; hidden without a folder. */
  panels?: { bottom: boolean; right: boolean; onBottom: () => void; onRight: () => void }
}

export function StatusBar({ app, live, onOpenPicker, onUsage, onResources, update, panels }: Props) {
  const { t: tr } = useT()
  const fmt = useFormat()
  const bytes = (n: number | null | undefined) => (n == null ? '—' : fmt.bytes(n))
  const percent = (n: number) => fmt.num(n / 100, { style: 'percent' })
  const res = useResources(app.settings.app.showResources, 3000)
  const mac = app.platform === 'darwin'
  const s = app.usage.session
  const t = app.usage.today
  const showCost = app.settings.usage.showCost
  const ctx = live.context
  const pct = ctx ? Math.min(100, Math.round((ctx.tokens / ctx.length) * 100)) : null
  const budget = app.settings.usage.sessionBudgetUsd
  const model = app.session?.meta.model

  return (
    <footer className="statusbar">
      <button className="sb-item" onClick={onOpenPicker} title={tr('chat.picker.title')}>
        {model ? modelLabel(model.modelId) : '—'}
      </button>
      <span className="sb-sep" />
      <button className="sb-item" onClick={onUsage} title={tr('chat.statusbar.tokensTitle')}>
        <b>{tokens(s.promptTokens)}</b>↑ <b>{tokens(s.completionTokens)}</b>↓{s.cachedTokens > 0 && <span className="muted"> {tr('chat.statusbar.cached', { tokens: tokens(s.cachedTokens) })}</span>}
      </button>
      <button className="sb-item" onClick={onUsage} title={tr('chat.statusbar.requestsTitle')}>
        {/* The plural form needs the number; the number itself is then shown bold. */}
        {rich(tr('chat.statusbar.requests', { count: s.requests }).replace(String(s.requests), '{n}'), { n: <b>{s.requests}</b> })}
        <span className="muted sb-today"> · {tr('chat.statusbar.today', { value: t.requests })}</span>
      </button>
      {showCost && (
        <button className={`sb-item ${budget != null && s.cost >= budget ? 'warn' : ''}`} onClick={onUsage} title={tr('chat.statusbar.costTitle')}>
          <b>{cost(s.cost, s.costPartial)}</b>
          {budget != null && <span className="muted"> / {cost(budget)}</span>}
          <span className="muted sb-today"> · {tr('chat.statusbar.today', { value: cost(t.cost, t.costPartial) })}</span>
        </button>
      )}
      {live.lastUsage && app.settings.usage.showPerMessageUsage && (
        <span className="sb-item sb-last muted" title={tr('chat.statusbar.lastTitle')}>
          {tr('chat.statusbar.last', {
            usage: `${tokens(live.lastUsage.prompt)}↑ ${tokens(live.lastUsage.completion)}↓${showCost && live.lastUsage.cost != null ? ` ${cost(live.lastUsage.cost)}` : ''}`,
          })}
        </span>
      )}
      <div className="spacer" />
      {res && (
        <button
          className="sb-item sb-res"
          onClick={onResources}
          title={
            res.children.measured && res.children.memory
              ? tr('chat.statusbar.resourcesChildren', { app: bytes(res.app.memory), children: bytes(res.children.memory), total: bytes(res.system.total), cpu: cpuText(res.app.cpu + res.children.cpu) })
              : tr('chat.statusbar.resources', { app: bytes(res.app.memory), total: bytes(res.system.total), cpu: cpuText(res.app.cpu + res.children.cpu) })
          }
        >
          <span className="muted">{tr('chat.statusbar.ram')}</span> <b>{bytes(res.app.memory + res.children.memory)}</b>
          <span className="muted"> · {tr('chat.statusbar.cpu')}</span> <b>{cpuText(res.app.cpu + res.children.cpu)}</b>
        </button>
      )}
      {pct != null && (
        <span className="sb-item" title={tr('chat.statusbar.contextTitle', { used: tokens(ctx!.tokens), total: tokens(ctx!.length) })}>
          <span className="meter">
            <span className={`meter-fill ${pct > 80 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
          </span>
          {tr('chat.statusbar.context', { percent: percent(pct) })}
        </span>
      )}
      {update.state === 'ready' && (
        <button className="sb-item accent" onClick={() => api.app.installUpdate()}>
          {tr('chat.statusbar.restart', { version: update.version ?? '' })}
        </button>
      )}
      {update.state === 'manual' && (
        <button className="sb-item accent" onClick={() => api.app.openExternal(update.url)}>
          {tr('chat.statusbar.download', { version: update.version })}
        </button>
      )}
      {update.state === 'downloading' && <span className="sb-item muted">{tr('chat.statusbar.downloading', { percent: percent(update.percent ?? 0) })}</span>}
      {panels && (
        <>
          <span className="sb-sep" />
          <button className={`sb-item sb-toggle ${panels.bottom ? 'on' : ''}`} aria-pressed={panels.bottom} onClick={panels.onBottom} title={tr('chat.statusbar.terminalTitle', { key: mac ? '⌘J' : 'Ctrl+J' })}>
            {tr('chat.statusbar.terminal')}
          </button>
          <button className={`sb-item sb-toggle ${panels.right ? 'on' : ''}`} aria-pressed={panels.right} onClick={panels.onRight} title={tr('chat.statusbar.filesTitle', { key: mac ? '⌥⌘B' : 'Ctrl+Alt+B' })}>
            {tr('chat.statusbar.files')}
          </button>
        </>
      )}
    </footer>
  )
}
