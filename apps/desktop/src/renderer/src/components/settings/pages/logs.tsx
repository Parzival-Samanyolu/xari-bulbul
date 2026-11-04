import { useEffect, useMemo, useState } from 'react'
import type { LogEntry, LogLevel, ProcessUsage } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { bytes, cpuText, useResources } from '../../../lib/resources'
import { Row, Section, Select, Toggle } from '../../fields'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Performance

const KIND_ORDER: ProcessUsage['kind'][] = ['app', 'local', 'mcp', 'terminal', 'child']

export function ResourcesPage({ app, save }: PageProps) {
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
        <Row label="Show memory and CPU in the status bar" hint="A small readout at the bottom of the window, updated every few seconds. Off by default.">
          <Toggle label="Show memory and CPU in the status bar" value={app.settings.app.showResources} onChange={(v) => save((x) => ((x.app.showResources = v), x))} />
        </Row>
      </Section>
      <Section title="This computer">
        <Row
          label="App memory"
          hint={s ? `${bytes(s.app.memory)} for the app itself${s.children.measured ? `, ${bytes(s.children.memory)} for programs it started` : ''}. ${bytes(s.system.free)} of the computer's memory is free.` : 'Measuring…'}
          wide
        >
          {s && (
            <div className="res-meter">
              <div className="res-bar" role="meter" aria-label="App memory as a share of this computer's memory" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-valuetext={`${bytes(used)} of ${bytes(s.system.total)}`}>
                <span className={share > 0.5 ? 'hot' : ''} style={{ width: `${Math.max(0.5, Math.min(100, share * 100))}%` }} />
              </div>
              <span className="small">
                <b>{bytes(used)}</b> <span className="muted">of {bytes(s.system.total)} ({(share * 100).toFixed(share < 0.1 ? 1 : 0)}%)</span>
              </span>
            </div>
          )}
        </Row>
        <Row
          label="Graphics"
          hint="Electron doesn't report how much graphics memory (VRAM) the app uses, so only the GPU process's own memory and CPU are shown."
        >
          <span className="small res-gpu">
            {s ? (s.gpu.name ?? 'Unknown GPU') : '…'}
            {gpuProc && (
              <span className="muted">
                {' '}
                · {bytes(gpuProc.memory)}, {cpuText(gpuProc.cpu)} CPU
              </span>
            )}
          </span>
        </Row>
      </Section>
      <Section title="Processes" description="CPU is a percent of one core, so a busy process can pass 100%. Programs the app started include everything they started in turn.">
        {!s ? (
          <p className="muted small">Measuring…</p>
        ) : (
          <div>
            <table className="res-table">
              <thead>
                <tr>
                  <th scope="col">Process</th>
                  <th scope="col" className="num">
                    CPU
                  </th>
                  <th scope="col" className="num">
                    Memory
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
                      {p.count && <span className="muted small"> · {p.count} processes</span>}
                      {p.kind !== 'app' && <span className="muted small"> · started by the app</span>}
                    </td>
                    <td className="num">{cpuText(p.cpu)}</td>
                    <td className="num">{bytes(p.memory)}</td>
                    <td className="num muted">{p.pid}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="num">{cpuText(s.app.cpu + s.children.cpu)}</td>
                  <td className="num">{bytes(used)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            {!s.children.measured && <p className="muted small">On Windows, the memory and CPU of programs the app started (MCP servers, terminals, local models) aren't measured.</p>}
          </div>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- App log

const LEVELS: { value: 'all' | LogLevel; label: string }[] = [
  { value: 'all', label: 'All levels' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'info', label: 'Info and above' },
]
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
/** Entries drawn at once; the rest are a filter away. */
const SHOWN = 400

const dataText = (d: LogEntry['data']) => (d ? Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ') : '')
const lineText = (e: LogEntry) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.src}] ${e.msg}${e.data ? ` ${dataText(e.data)}` : ''}`

function timeText(t: number): string {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return today ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

export function AppLogPage({ onError }: PageProps) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState(true)
  const [copied, setCopied] = useState(false)

  const load = () => api.logs.read().then(setEntries, onError)
  useEffect(() => {
    void load()
    if (!live) return
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 3000)
    return () => clearInterval(t)
  }, [live])

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return (entries ?? []).filter((e) => (level === 'all' || RANK[e.level] >= RANK[level]) && (!terms.length || terms.every((t) => `${e.src} ${e.msg} ${dataText(e.data)}`.toLowerCase().includes(t))))
  }, [entries, level, query])

  const copy = () =>
    navigator.clipboard.writeText([...filtered].reverse().map(lineText).join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, onError)

  return (
    <div data-row="Log" className="log-view">
      <div className="log-tools">
        <input type="search" className="log-search" aria-label="Filter the log" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select label="Level" value={level} options={LEVELS} onChange={setLevel} />
        <label className="log-live small">
          <Toggle label="Refresh automatically" value={live} onChange={setLive} />
          Refresh automatically
        </label>
      </div>
      <div className="log-actions">
        {!live && (
          <button className="btn" onClick={() => void load()}>
            Refresh
          </button>
        )}
        <button className="btn" disabled={!filtered.length} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn" onClick={() => api.logs.export().catch(onError)}>
          Export…
        </button>
        <button className="btn" onClick={() => api.logs.openFolder().catch(onError)}>
          Open logs folder
        </button>
        <span className="muted small log-count" aria-live="polite">
          {entries == null ? 'Loading…' : filtered.length > SHOWN ? `Newest ${SHOWN} of ${filtered.length}` : `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`}
        </span>
      </div>
      {entries != null && !filtered.length ? (
        <p className="muted small log-empty">{entries.length ? 'No entries match.' : 'Nothing logged yet.'}</p>
      ) : (
        <ol className="log-list" aria-label="Log entries, newest first">
          {filtered.slice(0, SHOWN).map((e, i) => (
            <li key={`${e.t}:${i}`} className={`log-entry lv-${e.level}`}>
              <span className="log-time mono">{timeText(e.t)}</span>
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
