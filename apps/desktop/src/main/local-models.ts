// Settings › Models › Local models: the llama.cpp runtime, model downloads, Hugging Face
// search, and the one llama-server that serves the chosen model to the "Local (llama.cpp)" provider.

import {
  CURATED_MODELS,
  CONTEXT_CHOICES,
  contextChoices,
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
  type Settings,
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
  /** `settings.localModels`: chosen contexts and the idle unload time. */
  options: () => Settings['localModels']
}

const MAX_CTX = CONTEXT_CHOICES[0]
const GiB = 1024 ** 3

export class LocalModels {
  readonly server: LlamaServer
  private machine: MachineInfo | null = null
  private machineP: Promise<MachineInfo> | null = null
  private download: { ac: AbortController; progress: LocalDownload } | null = null
  /** Requests in flight on the local server, and when the last one ended. */
  private inUse = 0
  private lastUse = Date.now()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly host: LocalHost) {
    this.server = new LlamaServer({
      onChange: (s) => {
        // Point the provider entry at the port in use (no registry rebuild: the provider reads the server directly).
        if (s.state === 'ready') this.host.setProviders(upsertLocalProvider(this.host.providers(), s.port), false)
        if (s.state === 'ready' || s.state === 'starting') this.lastUse = Date.now()
        this.changed()
      },
    })
    // A loaded model holds gigabytes; unload it when nothing has used it for a while.
    this.idleTimer = setInterval(() => this.unloadIfIdle(), 30_000)
    this.idleTimer.unref?.()
  }

  private unloadIfIdle() {
    const after = this.host.options().unloadAfterMin
    if (!after || this.inUse > 0 || this.server.state.state !== 'ready') return
    if (Date.now() - this.lastUse >= after * 60_000) void this.server.stop()
  }

  /** Marks a request on the local server; the returned function ends it. */
  private hold(): () => void {
    this.inUse++
    this.lastUse = Date.now()
    let done = false
    return () => {
      if (done) return
      done = true
      this.inUse = Math.max(0, this.inUse - 1)
      this.lastUse = Date.now()
    }
  }

  /** The context the user chose for a model, if any. */
  private chosen(id: string): number | null {
    return this.host.options().context[id] ?? null
  }

  /** RAM llama-server may spend caching earlier prompts: none on small machines. */
  private cacheRamMib(machine: MachineInfo): number {
    return machine.ram >= 32 * GiB ? 2048 : machine.ram >= 16 * GiB ? 512 : 0
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
      const input = { size, maxContext: m.contextLength, kvPerToken: m.kvPerToken }
      const r = modelFit(input, machine, this.chosen(m.id))
      const inst = installed.find((x) => x.id === m.id)
      return { id: m.id, name: m.name, description: m.description, source: 'curated', size, ctx: r.ctx, auto: !this.chosen(m.id), autoCtx: modelFit(input, machine).ctx, choices: contextChoices(input, machine), maxCtx: Math.min(MAX_CTX, m.contextLength), vision: !!m.mmproj, fit: r.fit, installed: !!inst, partial: inst ? 0 : partialBytes(dataDir, files) }
    })
    for (const a of readAdded(dataDir)) {
      const inst = installed.find((x) => x.id === a.id)
      // Installed entries carry what the GGUF file says (context, KV size).
      const input = { size: a.size, maxContext: inst?.contextLength ?? a.contextLength, kvPerToken: inst?.kvPerToken }
      const r = modelFit(input, machine, this.chosen(a.id))
      const files = [a.weights, a.mmproj].filter((f) => !!f) as NonNullable<typeof a.weights>[]
      models.push({
        id: a.id,
        name: a.name,
        description: a.source === 'file' ? (a.path ?? '') : `${a.weights?.repo ?? ''} · not tested by us`,
        source: a.source,
        size: a.size,
        ctx: r.ctx,
        auto: !this.chosen(a.id),
        autoCtx: modelFit(input, machine).ctx,
        choices: contextChoices(input, machine),
        maxCtx: Math.min(MAX_CTX, input.maxContext || MAX_CTX),
        vision: a.vision,
        fit: r.fit,
        installed: !!inst,
        partial: inst ? 0 : partialBytes(dataDir, files),
      })
    }
    return { runtime: llamaRuntimeStatus(dataDir), machine, models, server: this.server.state, download: this.download?.progress ?? null, dir: llamaDirs(dataDir).root, unloadAfterMin: this.host.options().unloadAfterMin }
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
      contextLength: modelFit({ size: m.size, maxContext: m.contextLength, kvPerToken: m.kvPerToken }, machine, this.chosen(m.id)).ctx,
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
        hold: () => this.hold(),
      }),
    )
  }

  /** Starts (or switches) llama-server to the model; resolves to its base URL. */
  async ensure(id: string): Promise<string> {
    const model = installedModels(this.host.dataDir).find((m) => m.id === id)
    if (!model) throw new Error(`${id} isn't downloaded. Download it in Settings › Models › Local models.`)
    const runtime = llamaRuntimeStatus(this.host.dataDir)
    if (!runtime.binary) throw new Error('The local runtime is not installed. Install it in Settings › Models › Local models.')
    const machine = await this.machineInfo()
    const ctx = modelFit({ size: model.size, maxContext: model.contextLength, kvPerToken: model.kvPerToken }, machine, this.chosen(model.id)).ctx
    this.lastUse = Date.now()
    return this.server.ensure({ bin: runtime.binary.path, modelId: model.id, model: model.file, mmproj: model.mmproj, ctx, cacheRamMib: this.cacheRamMib(machine) })
  }

  /** After the chosen context changed: reload the model if it's the one running, so it applies now. */
  contextChanged(id: string) {
    const st = this.server.state
    if (st.state !== 'stopped' && st.state !== 'error' && st.modelId === id) this.ensure(id).catch(() => {})
    this.changed()
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
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.download?.ac.abort()
    await this.server.stop()
  }
}
