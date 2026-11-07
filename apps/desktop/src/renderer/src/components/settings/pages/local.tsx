import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../../../shared/i18n/catalog'
import type { Fit, HfResult, LocalDownload, LocalModelView, LocalStatus } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useFormat, useT } from '../../../lib/i18n'
import { Row } from '../../fields'
import { rich, type PageProps } from '../common'

const LOCAL = 'llama-local'
const ctxText = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))

const FIT_TEXT: Record<Fit, MessageKey> = { fits: 'settings.local.fits', tight: 'settings.local.tight', 'too-big': 'settings.local.tooBig' }
const FIT_CLASS: Record<Fit, string> = { fits: 'ok', tight: 'warn', 'too-big': 'bad' }

/** Download and memory sizes in the current language: decimal GB and MB for files, binary GB for RAM. */
function useSizes() {
  const { t } = useT()
  const { num } = useFormat()
  return {
    gb: (n: number) => t('settings.local.gb', { n: num(n / 1e9, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }),
    mb: (n: number) => t('settings.local.mb', { n: num(Math.round(n / 1e6)) }),
    ram: (n: number) => t('settings.local.gb', { n: num(Math.round(n / 1024 ** 3)) }),
  }
}

function FitBadge({ fit }: { fit: Fit }) {
  const { t } = useT()
  return <span className={`badge ${FIT_CLASS[fit]}`}>{t(FIT_TEXT[fit])}</span>
}

function Progress({ d }: { d: LocalDownload }) {
  const { t } = useT()
  const { gb, mb } = useSizes()
  return (
    <div className="voice-progress">
      <progress value={d.received} max={d.total || undefined} aria-label={t('settings.local.downloading', { name: d.label })} />
      <span className="small muted" aria-hidden>
        {d.total > 5e8 ? t('settings.local.of', { done: gb(d.received), total: gb(d.total) }) : d.total ? t('settings.local.of', { done: mb(d.received), total: mb(d.total) }) : mb(d.received)}
      </span>
    </div>
  )
}

/** Settings › Models › Local models. */
export function LocalModelsPage({ app, onState, onError }: PageProps) {
  const { t } = useT()
  const { num } = useFormat()
  const { gb, mb, ram } = useSizes()
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

  if (!status) return <p className="muted small">{t('settings.local.checking')}</p>

  const download = status.download ? (live?.target === status.download.target ? live : status.download) : null
  const busy = !!download
  const act = (p: Promise<LocalStatus | null>) => p.then((s) => s && setStatus(s), onError)
  const { runtime, machine, server } = status
  const def = app.settings.models.default
  const inUse = (id: string) => def.providerId === LOCAL && def.modelId === id
  const curated = status.models.filter((m) => m.source === 'curated')
  const recommended = curated.find((m) => m.fit === 'fits')
  /** A context option: its size, and how it fits this machine. */
  const choiceText = (ctx: number, fit: Fit) => (fit === 'tight' ? t('settings.local.choiceTight', { ctx: ctxText(ctx) }) : fit === 'too-big' ? t('settings.local.choiceTooBig', { ctx: ctxText(ctx) }) : ctxText(ctx))
  const search = () => {
    if (!query.trim()) return
    setResults('searching')
    api.local.search(query).then(setResults, (e) => {
      setResults(null)
      onError(e)
    })
  }
  const remove = (m: LocalModelView) =>
    confirm(m.source === 'file' ? t('settings.local.removeFileConfirm', { name: m.name }) : t('settings.local.deleteConfirm', { name: m.name, size: gb(m.size) })) && act(api.local.remove(m.id))

  const serverLine = () => {
    const name = (id: string) => status.models.find((m) => m.id === id)?.name ?? id
    if (server.state === 'starting')
      return (
        <span className="inline small">
          <span className="spinner" aria-hidden /> {t('settings.local.loading', { name: name(server.modelId), ctx: ctxText(server.ctx) })}
        </span>
      )
    if (server.state === 'ready')
      return (
        <span className="inline small">
          <span className="badge ok">{t('settings.local.running')}</span> {t('settings.local.runningLine', { name: name(server.modelId), ctx: ctxText(server.ctx), port: server.port })}
          <button className="link small" onClick={() => act(api.local.stop())}>
            {t('common.stop')}
          </button>
        </span>
      )
    if (server.state === 'error') return <span className="small warn">{server.message}</span>
    return <span className="small muted">{t('settings.local.notRunning')}</span>
  }

  const checkAgain = (
    <button className="link" onClick={() => act(api.local.status())}>
      {t('settings.local.checkAgain')}
    </button>
  )

  return (
    <>
      <section className="s-section" data-row={t('settings.local.runtime')}>
        <h3>{t('settings.local.runtime')}</h3>
        <div className="provider-card local-card">
          <div className="provider-head">
            <b>llama.cpp</b>
            <span className="badge">{runtime.binary?.source === 'path' ? t('settings.local.ownInstall') : `v${runtime.version} · ${runtime.release}`}</span>
            {runtime.binary && <span className="badge ok">{t('settings.local.installed')}</span>}
            <div className="spacer" />
            {!runtime.binary && runtime.canDownload && download?.target !== 'runtime' && (
              <button className="btn primary" disabled={busy} onClick={() => act(api.local.installRuntime())}>
                {t('settings.local.installRuntime')}
              </button>
            )}
            {download?.target === 'runtime' && (
              <button className="btn" onClick={() => act(api.local.cancelDownload())}>
                {t('common.cancel')}
              </button>
            )}
          </div>
          {!runtime.binary ? (
            <>
              <p className="local-lead">{t('settings.local.installLead')}</p>
              <p className="muted small">{runtime.downloadSize ? t('settings.local.installHintSize', { size: mb(runtime.downloadSize) }) : t('settings.local.installHint')}</p>
              {!runtime.canDownload && (
                <p className="small">
                  {app.platform === 'darwin'
                    ? rich(t('settings.local.noBuildMac'), { server: <code>llama-server</code>, brew: <code>brew install llama.cpp</code>, check: checkAgain })
                    : rich(t('settings.local.noBuild'), { server: <code>llama-server</code>, check: checkAgain })}
                </p>
              )}
            </>
          ) : (
            <div className="local-server">
              {serverLine()}
              <p className="muted small">
                <code>{runtime.binary.path}</code>
                {runtime.binary.source === 'download' && (
                  <button className="link danger small" disabled={busy} onClick={() => confirm(t('settings.local.deleteRuntimeConfirm')) && act(api.local.removeRuntime())}>
                    {t('settings.local.deleteRuntime')}
                  </button>
                )}
              </p>
            </div>
          )}
          {download?.target === 'runtime' && <Progress d={download} />}
        </div>
      </section>

      <section className="s-section" data-row={t('settings.local.machine')}>
        <h3>{t('settings.local.machine')}</h3>
        <div className="s-rows">
          <Row label={t('settings.local.gpuMemory')} hint={machine.unified ? t('settings.local.unifiedHint') : machine.gpu ? undefined : t('settings.local.noGpuHint')}>
            <span className="inline">
              {machine.unified ? ram(machine.ram) : machine.gpu ? `${ram(machine.gpu.vram)} · ${machine.gpu.name}` : t('settings.local.noneFound')}
              {machine.unified && <span className="badge reviewed">{t('settings.local.unified')}</span>}
            </span>
          </Row>
          <Row label={t('settings.local.ram')}>
            <span>{ram(machine.ram)}</span>
          </Row>
          <Row label={t('settings.local.unload')} labelFor="local-unload" hint={t('settings.local.unloadHint')}>
            <select
              id="local-unload"
              value={status.unloadAfterMin == null ? 'never' : String(status.unloadAfterMin)}
              onChange={(e) => act(api.local.setUnload(e.target.value === 'never' ? null : Number(e.target.value)))}
            >
              {[5, 15, 30, 60].map((n) => (
                <option key={n} value={String(n)}>
                  {t('settings.local.afterMinutes', { count: n })}
                </option>
              ))}
              <option value="never">{t('settings.local.never')}</option>
            </select>
          </Row>
        </div>
      </section>

      <section className="s-section" data-row={t('settings.local.models')}>
        <h3>{t('settings.local.modelsCount', { count: status.models.length })}</h3>
        <p className="muted small">{recommended ? t('settings.local.recommended', { name: recommended.name }) : t('settings.local.tooLarge')}</p>
        {status.models.map((m) => {
          const mine = download?.target === m.id || download?.target.endsWith(`/${m.name}.gguf`)
          return (
            <div key={m.id} className="provider-card local-card">
              <div className="provider-head">
                <b>{m.name}</b>
                {inUse(m.id) && <span className="badge reviewed">{t('settings.local.inUse')}</span>}
                <div className="spacer" />
                {m.installed ? (
                  <>
                    <button className="btn primary" disabled={inUse(m.id) || !runtime.binary} title={runtime.binary ? undefined : t('settings.local.installFirst')} onClick={() => api.local.use(m.id).then(onState, onError)}>
                      {inUse(m.id) ? t('settings.local.using') : t('settings.local.use')}
                    </button>
                    <button className="link danger small" disabled={busy} aria-label={t('settings.local.deleteLabel', { name: m.name })} onClick={() => remove(m)}>
                      {m.source === 'file' ? t('common.remove') : t('common.delete')}
                    </button>
                  </>
                ) : mine ? (
                  <button className="btn" onClick={() => act(api.local.cancelDownload())}>
                    {t('common.cancel')}
                  </button>
                ) : m.source === 'curated' ? (
                  <button className="btn" disabled={busy} onClick={() => act(api.local.download(m.id))}>
                    {m.partial ? t('settings.local.resume', { size: gb(m.size - m.partial) }) : t('settings.local.download', { size: gb(m.size) })}
                  </button>
                ) : (
                  <button className="link danger small" disabled={busy} onClick={() => remove(m)}>
                    {t('common.delete')}
                  </button>
                )}
              </div>
              <p className="muted small local-desc">{m.description}</p>
              <div className="inline local-chips">
                <FitBadge fit={m.fit} />
                {m.installed ? (
                  <label className="inline small local-ctx">
                    <span className="muted">{t('settings.local.context')}</span>
                    <select
                      aria-label={t('settings.local.contextFor', { name: m.name })}
                      value={m.auto ? 'auto' : String(m.ctx)}
                      onChange={(e) => act(api.local.setContext(m.id, e.target.value === 'auto' ? null : Number(e.target.value)))}
                    >
                      <option value="auto">{t('settings.local.autoCtx', { ctx: ctxText(m.autoCtx) })}</option>
                      {m.choices.map((c) => (
                        <option key={c.ctx} value={String(c.ctx)}>
                          {choiceText(c.ctx, c.fit)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="badge">{t('settings.local.upTo', { ctx: ctxText(m.maxCtx) })}</span>
                )}
                {m.vision && <span className="badge">{t('settings.local.vision')}</span>}
                {m.installed && <span className="badge">{t('settings.local.onDisk', { size: gb(m.size) })}</span>}
              </div>
              {mine && download && <Progress d={download} />}
              {!m.installed && !mine && m.source !== 'curated' && <p className="small warn">{t('settings.local.unfinished')}</p>}
            </div>
          )
        })}
      </section>

      <section className="s-section" data-row={t('settings.local.findMore')}>
        <h3>{t('settings.local.findMore')}</h3>
        <p className="muted small">{t('settings.local.findMoreHint')}</p>
        <form
          className="inline local-search"
          onSubmit={(e) => {
            e.preventDefault()
            search()
          }}
        >
          <input className="grow" type="search" aria-label={t('settings.local.searchHf')} placeholder="qwen coder, llama 3b, mistral…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" type="submit" disabled={!query.trim() || results === 'searching'}>
            {t('settings.local.search')}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => act(api.local.addFile())}>
            {t('settings.local.addFile')}
          </button>
        </form>
        {results === 'searching' && (
          <p className="small muted" role="status">
            {t('settings.local.searching')}
          </p>
        )}
        {Array.isArray(results) && results.length === 0 && (
          <p className="small muted" role="status">
            {t('settings.local.noResults')}
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
                    <span className="badge ok">{t('settings.local.downloaded')}</span>
                  ) : download?.target === target ? (
                    <button className="btn" onClick={() => act(api.local.cancelDownload())}>
                      {t('common.cancel')}
                    </button>
                  ) : (
                    <button className="btn" disabled={busy} onClick={() => act(api.local.downloadHf(r))}>
                      {t('settings.local.download', { size: gb(p.size) })}
                    </button>
                  )}
                </div>
                <p className="muted small local-desc">
                  <code>{p.weights.file}</code> · {t('settings.local.hfLine', { downloads: num(r.downloads, { notation: 'compact', maximumFractionDigits: 1 }), count: r.quants })}
                </p>
                <div className="inline local-chips">
                  <FitBadge fit={p.fit} />
                  {r.contextLength && <span className="badge">{t('settings.local.upTo', { ctx: ctxText(Math.min(131_072, r.contextLength)) })}</span>}
                  {p.mmproj && <span className="badge">{t('settings.local.vision')}</span>}
                </div>
                {download?.target === target && <Progress d={download} />}
              </div>
            )
          })}
      </section>
    </>
  )
}
