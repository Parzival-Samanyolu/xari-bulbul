// Settings › Providers › Local models: the llama.cpp runtime, model downloads, Hugging Face
// search, and the one llama-server that serves the chosen model to the "Local (llama.cpp)" provider.

import {
  CURATED_MODELS,
  CONTEXT_STEPS,
  LOCAL_PROVIDER_ID,
  LlamaServer,
  LocalLlamaProvider,
  addModelFile,
  detectMachine,
  downloadCurated,
  downloadHfModel,
  installLlamaRuntime,
  installedModels,
  llamaDirs,
  llamaRuntimeStatus,
  modelFit,
  partialBytes,
  readAdded,
  removeLlamaRuntime,
  removeLocalModel,
  searchHf,
  upsertLocalProvider,
  type HfResult,
  type MachineInfo,
  type ModelInfo,
  type ProviderConfig,
  type ProviderRegistry,
} from '@harness/core'
import os from 'node:os'
import type { LocalDownload, LocalModelView, LocalStatus, UiEvent } from '../shared/ipc'

export interface LocalHost {
  dataDir: string
  send: (e: UiEvent) => void
  providers: () => ProviderConfig[]
  /** Saves a new provider list; `rebuild` when the registry must see it (first registration). */
  setProviders: (list: ProviderConfig[], rebuild: boolean) => void
  retries: () => number
}

const MAX_CTX = CONTEXT_STEPS[0]

export class LocalModels {
  readonly server: LlamaServer
  private machine: MachineInfo | null = null
  private machineP: Promise<MachineInfo> | null = null
  private download: { ac: AbortController; progress: LocalDownload } | null = null

  constructor(private readonly host: LocalHost) {
    this.server = new LlamaServer({
      onChange: (s) => {
        // Point the provider entry at the port in use (no registry rebuild: the provider reads the server directly).
        if (s.state === 'ready') this.host.setProviders(upsertLocalProvider(this.host.providers(), s.port), false)
        this.changed()
      },
    })
  }

  private machineInfo(): Promise<MachineInfo> {
    if (this.machine) return Promise.resolve(this.machine)
    this.machineP ??= detectMachine().then((m) => (this.machine = m))
    return this.machineP
  }

  /** Before detection finishes: RAM only. */
  private machineNow(): MachineInfo {
    return this.machine ?? { platform: process.platform, arch: process.arch, ram: os.totalmem(), unified: process.platform === 'darwin' && process.arch === 'arm64', gpu: null }
  }

  async status(): Promise<LocalStatus> {
    const machine = await this.machineInfo()
    return this.statusWith(machine)
  }

  private statusWith(machine: MachineInfo): LocalStatus {
    const dataDir = this.host.dataDir
    const installed = installedModels(dataDir)
    const models: LocalModelView[] = CURATED_MODELS.map((m) => {
      const files = [m.weights, ...(m.mmproj ? [m.mmproj] : [])]
      const size = files.reduce((n, f) => n + f.size, 0)
      const r = modelFit({ size, maxContext: m.contextLength, kvPerToken: m.kvPerToken }, machine)
      const inst = installed.find((x) => x.id === m.id)
      return { id: m.id, name: m.name, description: m.description, source: 'curated', size, ctx: r.ctx, maxCtx: Math.min(MAX_CTX, m.contextLength), vision: !!m.mmproj, fit: r.fit, installed: !!inst, partial: inst ? 0 : partialBytes(dataDir, files) }
    })
    for (const a of readAdded(dataDir)) {
      const inst = installed.find((x) => x.id === a.id)
      const r = modelFit({ size: a.size, maxContext: a.contextLength }, machine)
      const files = [a.weights, a.mmproj].filter((f) => !!f) as NonNullable<typeof a.weights>[]
      models.push({
        id: a.id,
        name: a.name,
        description: a.source === 'file' ? (a.path ?? '') : `${a.weights?.repo ?? ''} · not tested by us`,
        source: a.source,
        size: a.size,
        ctx: r.ctx,
        maxCtx: Math.min(MAX_CTX, a.contextLength || MAX_CTX),
        vision: a.vision,
        fit: r.fit,
        installed: !!inst,
        partial: inst ? 0 : partialBytes(dataDir, files),
      })
    }
    return { runtime: llamaRuntimeStatus(dataDir), machine, models, server: this.server.state, download: this.download?.progress ?? null, dir: llamaDirs(dataDir).root }
  }

  /** Pushes a fresh status to the window. */
  changed() {
    this.status().then(
      (status) => this.host.send({ type: 'local', status }),
      () => {},
    )
  }

  /** Installed models as the model picker lists them. */
  modelInfos(): ModelInfo[] {
    const machine = this.machineNow()
    return installedModels(this.host.dataDir).map((m) => ({
      id: m.id,
      name: `${m.name} (local)`,
      providerId: LOCAL_PROVIDER_ID,
      contextLength: modelFit({ size: m.size, maxContext: m.contextLength, kvPerToken: m.kvPerToken }, machine).ctx,
      free: true,
      supportsTools: true,
      supportsImages: m.vision,
    }))
  }

  /** Registers the local provider in `registry` when it's configured. */
  register(registry: ProviderRegistry) {
    const config = this.host.providers().find((p) => p.id === LOCAL_PROVIDER_ID)
    if (!config?.enabled) return
    registry.register(
      new LocalLlamaProvider({
        config,
        models: () => this.modelInfos(),
        ensure: (id) => this.ensure(id),
        isReady: (id) => this.server.isReady(id),
        apiKey: this.server.apiKey,
        retries: this.host.retries(),
      }),
    )
  }

  /** Starts (or switches) llama-server to the model; resolves to its base URL. */
  async ensure(id: string): Promise<string> {
    const model = installedModels(this.host.dataDir).find((m) => m.id === id)
    if (!model) throw new Error(`${id} isn't downloaded. Download it in Settings › Providers › Local models.`)
    const runtime = llamaRuntimeStatus(this.host.dataDir)
    if (!runtime.binary) throw new Error('The local runtime is not installed. Install it in Settings › Providers › Local models.')
    const machine = await this.machineInfo()
    const ctx = modelFit({ size: model.size, maxContext: model.contextLength, kvPerToken: model.kvPerToken }, machine).ctx
    return this.server.ensure({ bin: runtime.binary.path, modelId: model.id, model: model.file, mmproj: model.mmproj, ctx })
  }

  /** Adds the provider entry once a model is on disk, so the picker shows it. */
  private registerProvider() {
    if (!this.host.providers().some((p) => p.id === LOCAL_PROVIDER_ID)) this.host.setProviders(upsertLocalProvider(this.host.providers()), true)
  }

  private async run(target: string, label: string, total: number, job: (o: { signal: AbortSignal; onProgress: (r: number, t: number) => void }) => Promise<unknown>): Promise<LocalStatus> {
    if (this.download) throw new Error('A download is already running.')
    const ac = new AbortController()
    const progress: LocalDownload = { target, label, received: 0, total }
    this.download = { ac, progress }
    let last = 0
    const onProgress = (received: number, t: number) => {
      progress.received = received
      progress.total = t
      const now = Date.now()
      if (now - last < 200 && received !== t) return
      last = now
      this.host.send({ type: 'local_download', download: { ...progress } })
    }
    this.changed()
    try {
      await job({ signal: ac.signal, onProgress })
    } catch (e) {
      if (!ac.signal.aborted) throw e
    } finally {
      this.download = null
      this.changed()
    }
    return this.status()
  }

  installRuntime(): Promise<LocalStatus> {
    const s = llamaRuntimeStatus(this.host.dataDir)
    return this.run('runtime', 'llama.cpp', s.downloadSize ?? 0, (o) => installLlamaRuntime(this.host.dataDir, o))
  }

  async removeRuntime(): Promise<LocalStatus> {
    if (this.download) throw new Error('Wait for the download to finish or cancel it first.')
    await this.server.stop()
    removeLlamaRuntime(this.host.dataDir)
    return this.status()
  }

  async downloadModel(id: string): Promise<LocalStatus> {
    const m = CURATED_MODELS.find((x) => x.id === id)
    if (!m) throw new Error(`Unknown local model: ${id}`)
    const status = await this.run(id, m.name, m.weights.size + (m.mmproj?.size ?? 0), (o) => downloadCurated(this.host.dataDir, id, o))
    if (status.models.find((x) => x.id === id)?.installed) this.registerProvider()
    return this.status()
  }

  async downloadHf(result: HfResult): Promise<LocalStatus> {
    const pick = result?.pick
    if (!pick || !/^[0-9a-f]{40}$/.test(result.revision)) throw new Error('Nothing to download for that result.')
    let id = ''
    await this.run(`hf:${result.repo}/${pick.weights.file}`, pick.weights.file, pick.size, async (o) => {
      id = (await downloadHfModel(this.host.dataDir, { repo: result.repo, revision: result.revision, weights: pick.weights, mmproj: pick.mmproj, contextLength: result.contextLength }, o)).id
    })
    if (id) this.registerProvider()
    return this.status()
  }

  cancel(): Promise<LocalStatus> {
    this.download?.ac.abort()
    return this.status()
  }

  async remove(id: string): Promise<LocalStatus> {
    if (this.download) throw new Error('Wait for the download to finish or cancel it first.')
    const st = this.server.state
    if (st.state !== 'stopped' && st.modelId === id) await this.server.stop()
    removeLocalModel(this.host.dataDir, id)
    return this.status()
  }

  async search(query: string): Promise<HfResult[]> {
    return searchHf(query, await this.machineInfo(), { signal: AbortSignal.timeout(20_000) })
  }

  addFile(file: string): Promise<LocalStatus> {
    addModelFile(this.host.dataDir, file)
    this.registerProvider()
    return this.status()
  }

  hasModel(id: string): boolean {
    return installedModels(this.host.dataDir).some((m) => m.id === id)
  }

  async stop(): Promise<LocalStatus> {
    await this.server.stop()
    return this.status()
  }

  async dispose() {
    this.download?.ac.abort()
    await this.server.stop()
  }
}
