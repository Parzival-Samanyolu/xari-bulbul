import { useEffect, useMemo, useState } from 'react'
import type { LogEntry, LogLevel, ProcessUsage } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useFormat, useT } from '../../../lib/i18n'
import { useResources } from '../../../lib/resources'
import { Row, Section, Select, Toggle } from '../../fields'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Performance

const KIND_ORDER: ProcessUsage['kind'][] = ['app', 'local', 'mcp', 'terminal', 'child']

export function ResourcesPage({ app, save, onError }: PageProps) {
  const { t } = useT()
  const fmt = useFormat()
  const bytes = (n: number | null | undefined) => (n == null ? '—' : fmt.bytes(n))
  const cpuText = (n: number | null | undefined) => (n == null ? '—' : fmt.num(n / 100, { style: 'percent', maximumFractionDigits: n < 10 ? 1 : 0 }))
  const s = useResources(true, 2000)
  const procs = useMemo(
    () => (s ? [...s.processes].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.memory ?? 0) - (a.memory ?? 0)) : []),
    [s],
  )
  const used = s ? s.app.memory + s.children.memory : 0
  const share = s && s.system.total ? used / s.system.total : 0
  const gpuProc = s?.processes.find((p) => p.type === 'GPU')
  return (
    <>
      <Section>
        <Row label={t('settings.logs.showResources')} search="Show memory and CPU in the status bar" hint={t('settings.logs.showResourcesHint')}>
          <Toggle label={t('settings.logs.showResources')} value={app.settings.app.showResources} onChange={(v) => save((x) => ((x.app.showResources = v), x))} />
        </Row>
      </Section>
      <Section title={t('settings.logs.thisComputer')}>
        <Row
          label={t('settings.logs.appMemory')}
          search="App memory"
          hint={
            s
              ? s.children.measured
                ? t('settings.logs.appMemoryHint', { app: bytes(s.app.memory), children: bytes(s.children.memory), free: bytes(s.system.free) })
                : t('settings.logs.appMemoryHintAppOnly', { app: bytes(s.app.memory), free: bytes(s.system.free) })
              : t('settings.parts.measuring')
          }
          wide
        >
          {s && (
            <div className="res-meter">
              <div className="res-bar" role="meter" aria-label={t('settings.logs.memoryMeterLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-valuetext={t('settings.logs.usedOfTotal', { used: bytes(used), total: bytes(s.system.total) })}>
                <span className={share > 0.5 ? 'hot' : ''} style={{ width: `${Math.max(0.5, Math.min(100, share * 100))}%` }} />
              </div>
              <span className="small">
                <b>{bytes(used)}</b> <span className="muted">{t('settings.logs.ofTotal', { total: bytes(s.system.total), percent: fmt.num(share, { style: 'percent', maximumFractionDigits: share < 0.1 ? 1 : 0 }) })}</span>
              </span>
            </div>
          )}
        </Row>
        <Row
          label={t('settings.logs.graphics')}
          search="Graphics"
          hint={t('settings.logs.graphicsHint')}
        >
          <span className="small res-gpu">
            {s ? (s.gpu.name ?? t('settings.logs.unknownGpu')) : '…'}
            {gpuProc && (
              <span className="muted">
                {' '}
                · {t('settings.logs.gpuUsage', { memory: bytes(gpuProc.memory), cpu: cpuText(gpuProc.cpu) })}
              </span>
            )}
          </span>
        </Row>
      </Section>
      <Section title={t('settings.logs.processes')} description={t('settings.logs.processesHint')}>
        {!s ? (
          <p className="muted small">{t('settings.parts.measuring')}</p>
        ) : (
          <div>
            <table className="res-table">
              <thead>
                <tr>
                  <th scope="col">{t('settings.logs.process')}</th>
                  <th scope="col" className="num">
                    CPU
                  </th>
                  <th scope="col" className="num">
                    {t('settings.logs.memory')}
                  </th>
                  <th scope="col" className="num">
                    PID
                  </th>
                </tr>
              </thead>
              <tbody>
                {procs.map((p) => (
                  <tr key={`${p.kind}:${p.pid}`}>
                    <td>
                      {p.label}
                      {p.count && <span className="muted small"> · {t('settings.logs.processCount', { count: p.count })}</span>}
                      {p.kind !== 'app' && <span className="muted small"> · {t('settings.logs.startedByApp')}</span>}
                      {p.kind === 'local' && (
                        <button className="link small res-unload" title={t('settings.logs.unloadHint')} onClick={() => api.local.stop().catch(onError)}>
                          {t('settings.logs.unload')}
                        </button>
                      )}
                    </td>
                    <td className="num">{cpuText(p.cpu)}</td>
                    <td className="num">{bytes(p.memory)}</td>
                    <td className="num muted">{p.pid}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{t('settings.logs.total')}</th>
                  <td className="num">{cpuText(s.app.cpu + s.children.cpu)}</td>
                  <td className="num">{bytes(used)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            {!s.children.measured && <p className="muted small">{t('settings.logs.windowsNotMeasured')}</p>}
          </div>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- App log

const levels = (t: ReturnType<typeof useT>['t']): { value: 'all' | LogLevel; label: string }[] => [
  { value: 'all', label: t('settings.logs.levelAll') },
  { value: 'error', label: t('settings.logs.levelError') },
  { value: 'warn', label: t('settings.logs.levelWarn') },
  { value: 'info', label: t('settings.logs.levelInfo') },
]
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
/** Entries drawn at once; the rest are a filter away. */
const SHOWN = 400

const dataText = (d: LogEntry['data']) => (d ? Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ') : '')
const lineText = (e: LogEntry) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.src}] ${e.msg}${e.data ? ` ${dataText(e.data)}` : ''}`

function timeText(lang: string, t: number): string {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return today ? time : `${d.toLocaleDateString(lang, { month: 'short', day: 'numeric' })} ${time}`
}

export function AppLogPage({ onError }: PageProps) {
  const { t, lang } = useT()
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState(true)
  const [copied, setCopied] = useState(false)

  const load = () => api.logs.read().then(setEntries, onError)
  useEffect(() => {
    void load()
    if (!live) return
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 3000)
    return () => clearInterval(timer)
  }, [live])

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return (entries ?? []).filter((e) => (level === 'all' || RANK[e.level] >= RANK[level]) && (!terms.length || terms.every((term) => `${e.src} ${e.msg} ${dataText(e.data)}`.toLowerCase().includes(term))))
  }, [entries, level, query])

  const copy = () =>
    navigator.clipboard.writeText([...filtered].reverse().map(lineText).join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, onError)

  return (
    <div data-row="Log" className="log-view">
      <div className="log-tools">
        <input type="search" className="log-search" aria-label={t('settings.logs.filterLabel')} placeholder={t('settings.logs.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select label={t('settings.logs.level')} value={level} options={levels(t)} onChange={setLevel} />
        <label className="log-live small">
          <Toggle label={t('settings.logs.autoRefresh')} value={live} onChange={setLive} />
          {t('settings.logs.autoRefresh')}
        </label>
      </div>
      <div className="log-actions">
        {!live && (
          <button className="btn" onClick={() => void load()}>
            {t('settings.logs.refresh')}
          </button>
        )}
        <button className="btn" disabled={!filtered.length} onClick={copy}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
        <button className="btn" onClick={() => api.logs.export().catch(onError)}>
          {t('settings.logs.export')}
        </button>
        <button className="btn" onClick={() => api.logs.openFolder().catch(onError)}>
          {t('settings.logs.openFolder')}
        </button>
        <span className="muted small log-count" aria-live="polite">
          {entries == null ? t('common.loading') : filtered.length > SHOWN ? t('settings.logs.newestOf', { total: filtered.length, shown: SHOWN }) : t('settings.logs.entries', { count: filtered.length })}
        </span>
      </div>
      {entries != null && !filtered.length ? (
        <p className="muted small log-empty">{entries.length ? t('settings.logs.noMatch') : t('settings.logs.empty')}</p>
      ) : (
        <ol className="log-list" aria-label={t('settings.logs.listLabel')}>
          {filtered.slice(0, SHOWN).map((e, i) => (
            <li key={`${e.t}:${i}`} className={`log-entry lv-${e.level}`}>
              <span className="log-time mono">{timeText(lang, e.t)}</span>
              <span className="log-level">{e.level}</span>
              <span className="log-src mono">{e.src}</span>
              <span className="log-msg">
                {e.msg}
                {e.data && <span className="log-data mono"> {dataText(e.data)}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
