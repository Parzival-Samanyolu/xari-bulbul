import { useEffect, useState } from 'react'
import type { Fit, HfResult, LocalDownload, LocalModelView, LocalStatus } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { Row } from '../../fields'
import type { PageProps } from '../common'

const LOCAL = 'llama-local'
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`
const mb = (n: number) => `${Math.round(n / 1e6)} MB`
const ram = (n: number) => `${Math.round(n / 1024 ** 3)} GB`
const ctxText = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

const FIT_TEXT: Record<Fit, string> = { fits: 'Fits this machine', tight: 'Tight fit: slow, crowds other apps', 'too-big': 'Too big for this machine' }
const FIT_CLASS: Record<Fit, string> = { fits: 'ok', tight: 'warn', 'too-big': 'bad' }

function FitBadge({ fit }: { fit: Fit }) {
  return <span className={`badge ${FIT_CLASS[fit]}`}>{FIT_TEXT[fit]}</span>
}

function Progress({ d }: { d: LocalDownload }) {
  return (
    <div className="voice-progress">
      <progress value={d.received} max={d.total || undefined} aria-label={`Downloading ${d.label}`} />
      <span className="small muted" aria-hidden>
        {d.total > 5e8 ? `${gb(d.received)} of ${gb(d.total)}` : `${mb(d.received)}${d.total ? ` of ${mb(d.total)}` : ''}`}
      </span>
    </div>
  )
}

/** Settings › Providers › Local models. */
export function LocalModelsPage({ app, onState, onError }: PageProps) {
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [live, setLive] = useState<LocalDownload | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HfResult[] | 'searching' | null>(null)

  useEffect(() => {
    api.local.status().then(setStatus, onError)
    return api.onEvent((e) => {
      if (e.type === 'local') setStatus(e.status)
      else if (e.type === 'local_download') setLive(e.download)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) return <p className="muted small">Checking this computer…</p>

  const download = status.download ? (live?.target === status.download.target ? live : status.download) : null
  const busy = !!download
  const act = (p: Promise<LocalStatus | null>) => p.then((s) => s && setStatus(s), onError)
  const { runtime, machine, server } = status
  const def = app.settings.models.default
  const inUse = (id: string) => def.providerId === LOCAL && def.modelId === id
  const curated = status.models.filter((m) => m.source === 'curated')
  const recommended = curated.find((m) => m.fit === 'fits')
  const search = () => {
    if (!query.trim()) return
    setResults('searching')
    api.local.search(query).then(setResults, (e) => {
      setResults(null)
      onError(e)
    })
  }
  const remove = (m: LocalModelView) =>
    confirm(m.source === 'file' ? `Remove ${m.name} from the list? The file stays where it is.` : `Delete ${m.name}? Its ${gb(m.size)} download is removed.`) && act(api.local.remove(m.id))

  const serverLine = () => {
    const name = (id: string) => status.models.find((m) => m.id === id)?.name ?? id
    if (server.state === 'starting')
      return (
        <span className="inline small">
          <span className="spinner" aria-hidden /> Loading {name(server.modelId)} ({ctxText(server.ctx)} context). This can take a few minutes.
        </span>
      )
    if (server.state === 'ready')
      return (
        <span className="inline small">
          <span className="badge ok">Running</span> {name(server.modelId)} · {ctxText(server.ctx)} context · port {server.port}
          <button className="link small" onClick={() => act(api.local.stop())}>
            Stop
          </button>
        </span>
      )
    if (server.state === 'error') return <span className="small warn">{server.message}</span>
    return <span className="small muted">Not running. A local model starts when a chat uses it.</span>
  }

  return (
    <>
      <section className="s-section" data-row="Local runtime">
        <h3>Local runtime</h3>
        <div className="provider-card local-card">
          <div className="provider-head">
            <b>llama.cpp</b>
            <span className="badge">{runtime.binary?.source === 'path' ? 'Your own install' : `v${runtime.version} · ${runtime.release}`}</span>
            {runtime.binary && <span className="badge ok">Installed</span>}
            <div className="spacer" />
            {!runtime.binary && runtime.canDownload && download?.target !== 'runtime' && (
              <button className="btn primary" disabled={busy} onClick={() => act(api.local.installRuntime())}>
                Install runtime
              </button>
            )}
            {download?.target === 'runtime' && (
              <button className="btn" onClick={() => act(api.local.cancelDownload())}>
                Cancel
              </button>
            )}
          </div>
          {!runtime.binary ? (
            <>
              <p className="local-lead">Install the local runtime</p>
              <p className="muted small">
                Downloads the llama.cpp engine{runtime.downloadSize ? ` (${mb(runtime.downloadSize)})` : ''}. Models then run entirely on this computer: no account, and nothing you type leaves it.
              </p>
              {!runtime.canDownload && (
                <p className="small">
                  llama.cpp publishes no ready-made build for this system. Install <code>llama-server</code> yourself
                  {app.platform === 'darwin' && (
                    <>
                      {' '}
                      with Homebrew: <code>brew install llama.cpp</code>
                    </>
                  )}
                  , then{' '}
                  <button className="link" onClick={() => act(api.local.status())}>
                    check again
                  </button>
                  .
                </p>
              )}
            </>
          ) : (
            <div className="local-server">
              {serverLine()}
              <p className="muted small">
                <code>{runtime.binary.path}</code>
                {runtime.binary.source === 'download' && (
                  <button className="link danger small" disabled={busy} onClick={() => confirm('Delete the downloaded llama.cpp runtime? Your models stay.') && act(api.local.removeRuntime())}>
                    Delete runtime
                  </button>
                )}
              </p>
            </div>
          )}
          {download?.target === 'runtime' && <Progress d={download} />}
        </div>
      </section>

      <section className="s-section" data-row="This machine">
        <h3>This machine</h3>
        <div className="s-rows">
          <Row label="GPU memory" hint={machine.unified ? 'The GPU uses the same memory as everything else.' : machine.gpu ? undefined : 'No supported GPU found; models run on the processor, more slowly.'}>
            <span className="inline">
              {machine.unified ? ram(machine.ram) : machine.gpu ? `${ram(machine.gpu.vram)} · ${machine.gpu.name}` : 'None found'}
              {machine.unified && <span className="badge reviewed">Unified memory</span>}
            </span>
          </Row>
          <Row label="RAM">
            <span>{ram(machine.ram)}</span>
          </Row>
        </div>
      </section>

      <section className="s-section" data-row="Models">
        <h3>Models ({status.models.length})</h3>
        <p className="muted small">
          {recommended ? `${recommended.name} is a good start on this computer. Both models call tools and read images.` : 'These models are larger than this computer handles comfortably. They may run slowly.'}
        </p>
        {status.models.map((m) => {
          const mine = download?.target === m.id || download?.target.endsWith(`/${m.name}.gguf`)
          return (
            <div key={m.id} className="provider-card local-card">
              <div className="provider-head">
                <b>{m.name}</b>
                {inUse(m.id) && <span className="badge reviewed">In use</span>}
                <div className="spacer" />
                {m.installed ? (
                  <>
                    <button className="btn primary" disabled={inUse(m.id) || !runtime.binary} title={runtime.binary ? undefined : 'Install the local runtime first'} onClick={() => api.local.use(m.id).then(onState, onError)}>
                      {inUse(m.id) ? 'Using' : 'Use'}
                    </button>
                    <button className="link danger small" disabled={busy} aria-label={`Delete ${m.name}`} onClick={() => remove(m)}>
                      {m.source === 'file' ? 'Remove' : 'Delete'}
                    </button>
                  </>
                ) : mine ? (
                  <button className="btn" onClick={() => act(api.local.cancelDownload())}>
                    Cancel
                  </button>
                ) : m.source === 'curated' ? (
                  <button className="btn" disabled={busy} onClick={() => act(api.local.download(m.id))}>
                    {m.partial ? `Resume · ${gb(m.size - m.partial)} left` : `Download · ${gb(m.size)}`}
                  </button>
                ) : (
                  <button className="link danger small" disabled={busy} onClick={() => remove(m)}>
                    Delete
                  </button>
                )}
              </div>
              <p className="muted small local-desc">{m.description}</p>
              <div className="inline local-chips">
                <FitBadge fit={m.fit} />
                <span className="badge">Up to {ctxText(m.maxCtx)} context</span>
                {m.vision && <span className="badge">Sees images</span>}
                {m.installed && <span className="badge">{gb(m.size)} on disk</span>}
              </div>
              {mine && download && <Progress d={download} />}
              {!m.installed && !mine && m.source !== 'curated' && <p className="small warn">The download didn't finish. Search for it again to resume, or delete it.</p>}
            </div>
          )
        })}
      </section>

      <section className="s-section" data-row="Find more models">
        <h3>Find more models</h3>
        <p className="muted small">Search Hugging Face for GGUF models. Each result shows the version sized to this computer; these aren't tested by us.</p>
        <form
          className="inline local-search"
          onSubmit={(e) => {
            e.preventDefault()
            search()
          }}
        >
          <input className="grow" type="search" aria-label="Search Hugging Face" placeholder="qwen coder, llama 3b, mistral…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" type="submit" disabled={!query.trim() || results === 'searching'}>
            Search
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => act(api.local.addFile())}>
            Add model file…
          </button>
        </form>
        {results === 'searching' && (
          <p className="small muted" role="status">
            Searching…
          </p>
        )}
        {Array.isArray(results) && results.length === 0 && (
          <p className="small muted" role="status">
            No GGUF models found.
          </p>
        )}
        {Array.isArray(results) &&
          results.map((r) => {
            const p = r.pick!
            const target = `hf:${r.repo}/${p.weights.file}`
            const have = status.models.some((m) => m.source === 'hf' && m.installed && m.name === p.weights.file.replace(/\.gguf$/i, ''))
            return (
              <div key={r.repo} className="provider-card local-card">
                <div className="provider-head">
                  <b className="ellipsis" title={r.repo}>
                    {r.repo}
                  </b>
                  <div className="spacer" />
                  {have ? (
                    <span className="badge ok">Downloaded</span>
                  ) : download?.target === target ? (
                    <button className="btn" onClick={() => act(api.local.cancelDownload())}>
                      Cancel
                    </button>
                  ) : (
                    <button className="btn" disabled={busy} onClick={() => act(api.local.downloadHf(r))}>
                      Download · {gb(p.size)}
                    </button>
                  )}
                </div>
                <p className="muted small local-desc">
                  <code>{p.weights.file}</code> · {count(r.downloads)} downloads · one of {r.quants} versions
                </p>
                <div className="inline local-chips">
                  <FitBadge fit={p.fit} />
                  {r.contextLength && <span className="badge">Up to {ctxText(Math.min(32_768, r.contextLength))} context</span>}
                  {p.mmproj && <span className="badge">Sees images</span>}
                </div>
                {download?.target === target && <Progress d={download} />}
              </div>
            )
          })}
      </section>
    </>
  )
}
