import fs from 'node:fs'
import path from 'node:path'
import {
  Agent,
  McpManager,
  MemoryStore,
  Permissions,
  ProviderRegistry,
  SessionStore,
  UsageTracker,
  assembleTools,
  detectSecretBackend,
  envKeyName,
  KeyStore,
  latestSession,
  loadExtensions,
  loadSettingsFile,
  newSession,
  providerReady,
  pushRecent,
  resolveDataDir,
  saveSettingsFile,
  type AgentEvent,
  type LoadedExtensions,
  type ModelInfo,
  type ModelRef,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type ProviderConfig,
  type Session,
  type Settings,
  type Tool,
} from '@harness/core'

export interface HostOptions {
  cwd: string
  version: string
  env?: NodeJS.ProcessEnv
  dataDir?: string
  /** Tests inject an in-memory key store and a registry with mock providers. */
  keys?: KeyStore
  registry?: ProviderRegistry
  /** Skip loading user/project extensions and MCP servers (tests, headless with --bare). */
  bare?: boolean
}

/** MCP bearer tokens live next to API keys, under their own prefix (same as desktop). */
export const mcpSecretId = (serverId: string) => `mcp:${serverId}`

/**
 * Everything the terminal app needs from the engine: settings, keys, providers, sessions, usage,
 * memory, extensions and MCP. The terminal shows one chat at a time.
 */
export class Host {
  readonly dataDir: string
  readonly cwd: string
  readonly version: string
  settings: Settings
  readonly keys: KeyStore
  registry: ProviderRegistry
  readonly usage: UsageTracker
  readonly store: SessionStore
  readonly memory: MemoryStore
  readonly mcp: McpManager
  ext: LoadedExtensions = { tools: [], commands: [], errors: [] }
  tools: Tool[]
  private fixedRegistry: boolean
  private toolListeners = new Set<() => void>()

  constructor(o: HostOptions) {
    const env = o.env ?? process.env
    this.cwd = path.resolve(o.cwd).normalize('NFC')
    this.version = o.version
    this.dataDir = o.dataDir ?? resolveDataDir(env)
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.settings = loadSettingsFile(this.dataDir)
    this.keys = o.keys ?? new KeyStore(detectSecretBackend(this.dataDir), env)
    this.usage = new UsageTracker(path.join(this.dataDir, 'usage.jsonl'))
    this.store = new SessionStore(path.join(this.dataDir, 'sessions'))
    this.memory = new MemoryStore(path.join(this.dataDir, 'memory'), this.settings.memory.maxChars)
    this.mcp = new McpManager({
      clientVersion: o.version,
      secret: (id) => this.keys.get(mcpSecretId(id)),
      onChange: () => this.applyTools(),
    })
    this.fixedRegistry = !!o.registry
    this.registry = o.registry ?? this.buildRegistry()
    this.tools = assembleTools([]).tools
  }

  private buildRegistry(): ProviderRegistry {
    const reg = new ProviderRegistry(this.settings.providers, (id) => this.keys.get(id), { retries: this.settings.agent.requestRetries })
    if (this.registry) reg.restoreCache(this.registry.cacheSnapshot())
    return reg
  }

  /** Loads extensions and starts MCP servers in the background. */
  async start(opts: { bare?: boolean } = {}) {
    if (opts.bare) return
    this.ext = await loadExtensions(this.cwd, {
      user: this.settings.tools.loadUserExtensions,
      project: this.settings.tools.loadProjectExtensions,
    })
    this.applyTools()
    void this.mcp.sync(this.settings.mcp.servers)
  }

  private applyTools() {
    const { tools, conflicts } = assembleTools(this.ext.tools, this.mcp.tools())
    for (const name of conflicts) {
      if (!this.ext.errors.some((e) => e.file === name)) this.ext.errors.push({ file: name, error: `Tool "${name}" conflicts with an existing tool and was skipped.` })
    }
    this.tools = tools
    for (const l of this.toolListeners) l()
  }

  onToolsChange(fn: () => void): () => void {
    this.toolListeners.add(fn)
    return () => this.toolListeners.delete(fn)
  }

  /**
   * Changes settings with a fresh read of settings.json first, so edits made in the desktop app
   * meanwhile are not overwritten.
   */
  updateSettings(fn: (s: Settings) => Settings): Settings {
    const fresh = loadSettingsFile(this.dataDir)
    const next = fn(fresh)
    saveSettingsFile(this.dataDir, next)
    const providersChanged = JSON.stringify(next.providers) !== JSON.stringify(this.settings.providers)
    this.settings = next
    if (providersChanged && !this.fixedRegistry) this.registry = this.buildRegistry()
    return next
  }

  rememberModel(ref: ModelRef) {
    this.updateSettings((s) => ({ ...s, models: { ...s.models, recent: pushRecent(s.models.recent, ref) } }))
  }

  toggleFavorite(ref: ModelRef) {
    this.updateSettings((s) => {
      const has = s.models.favorites.some((f) => f.providerId === ref.providerId && f.modelId === ref.modelId)
      const favorites = has ? s.models.favorites.filter((f) => !(f.providerId === ref.providerId && f.modelId === ref.modelId)) : [...s.models.favorites, ref]
      return { ...s, models: { ...s.models, favorites } }
    })
  }

  setPicker(patch: Partial<Settings['models']['picker']>) {
    this.updateSettings((s) => ({ ...s, models: { ...s.models, picker: { ...s.models.picker, ...patch } } }))
  }

  provider(id: string): ProviderConfig | undefined {
    return this.settings.providers.find((p) => p.id === id)
  }

  /** null when the model's provider can be used; otherwise a sentence saying how to fix it. */
  problem(ref: ModelRef): string | null {
    const p = this.provider(ref.providerId)
    if (!p) return `Unknown provider "${ref.providerId}". Add it in settings.json or pick another model with /model.`
    if (!p.enabled) return `${p.name} is turned off in settings.`
    if (!providerReady(p, this.keys.has(p.id))) return `No API key for ${p.name}. Run /login ${p.id}, or set ${envKeyName(p.id)}.`
    return null
  }

  /** `provider:model`, or a bare model id on the default model's provider. */
  parseModel(spec: string): ModelRef {
    const i = spec.indexOf(':')
    if (i > 0 && this.provider(spec.slice(0, i))) return { providerId: spec.slice(0, i), modelId: spec.slice(i + 1) }
    return { providerId: this.settings.models.default.providerId, modelId: spec }
  }

  setKey(id: string, value: string | null) {
    this.keys.set(id, value)
    if (!this.fixedRegistry) this.registry = this.buildRegistry()
  }

  /** Fetches the model list and sends a 5-token request, like the desktop "Test" button. */
  async testProvider(id: string): Promise<{ ok: boolean; message: string }> {
    try {
      const models = await this.registry.models(id, { refresh: true })
      const fav = this.settings.models.favorites.find((f) => f.providerId === id)?.modelId
      const def = this.settings.models.default.providerId === id ? this.settings.models.default.modelId : undefined
      const model = fav ?? def ?? models.find((m) => m.free)?.id ?? models[0]?.id
      if (!model) return { ok: true, message: `Connected, but the provider lists no models.` }
      for await (const _ of this.registry.get(id).chat({ model, maxTokens: 5, messages: [{ role: 'user', content: 'Say OK' }] })) {
        /* drain */
      }
      return { ok: true, message: `Connected. ${models.length} models; a test request to ${model} succeeded.` }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }

  async models(providerId: string, refresh = false): Promise<ModelInfo[]> {
    return this.registry.models(providerId, { refresh })
  }

  newSession(model?: ModelRef): Session {
    return newSession(this.cwd, model ?? this.settings.models.default)
  }

  latest(): Session | null {
    const meta = latestSession(this.store, this.cwd)
    return meta ? this.store.load(meta.id) : null
  }

  /** A session by id or unique id prefix, in any folder. */
  findSession(idOrPrefix: string): Session | null {
    const exact = this.store.load(idOrPrefix)
    if (exact) return exact
    const matches = this.store.list().filter((m) => m.id.startsWith(idOrPrefix))
    return matches.length === 1 ? this.store.load(matches[0].id) : null
  }

  createAgent(
    session: Session,
    mode: PermissionMode,
    handlers: { onEvent: (e: AgentEvent) => void; askPermission: (r: PermissionRequest) => Promise<PermissionAnswer> },
  ): { agent: Agent; permissions: Permissions } {
    const permissions = new Permissions({ ...this.settings.permissions, mode }, session.meta.cwd)
    const agent = new Agent({
      session,
      registry: this.registry,
      tools: this.tools,
      settings: this.settings,
      usage: this.usage,
      permissions,
      memory: this.memory,
      onSave: (s) => {
        if (s.messages.length) this.store.save(s)
      },
      ...handlers,
    })
    // Warm the model cache so context size and pricing are known.
    this.registry.models(session.meta.model.providerId).catch(() => {})
    return { agent, permissions }
  }

  get historyFile(): string {
    return path.join(this.dataDir, 'xb-history.jsonl')
  }

  async dispose() {
    await this.mcp.close()
  }
}
