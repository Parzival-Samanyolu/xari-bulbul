import fs from 'node:fs'
import path from 'node:path'
import {
  Agent,
  McpManager,
  MemoryStore,
  Permissions,
  ProviderRegistry,
  SessionStore,
  USER_EXT_DIR,
  UsageTracker,
  assembleTools,
  builtinTools,
  expandSlashCommand,
  imageFromData,
  loadAttachment,
  loadExtensions,
  loadSettingsFile,
  newSession,
  PROVIDER_PRESETS,
  providerReady,
  pushRecent,
  parseSettings,
  saveSettingsFile,
  projectExtDir,
  type AgentEvent,
  type FileAttachment,
  type ImageAttachment,
  type LoadedExtensions,
  type ModelRef,
  type PermissionAnswer,
  type PermissionMode,
  type Session,
  type Settings,
  type Tool,
} from '@harness/core'
import type { AppState, AttachmentInput, ExtensionsInfo, MemoryInfo, ProviderTestResult, SessionView, UiEvent } from '../shared/ipc'
import { SecretStore } from './secrets'

const MAX_ATTACHMENTS = 10

/** MCP bearer tokens live next to API keys, under their own prefix. */
const mcpSecretId = (serverId: string) => `mcp:${serverId}`

const BUILTIN_COMMANDS = [
  { name: 'compact', description: 'Summarize older messages to free up context', source: 'builtin' as const },
  { name: 'clear', description: 'Start a new chat', source: 'builtin' as const },
  { name: 'model', description: 'Open the model switcher', source: 'builtin' as const },
  { name: 'mode', description: 'Cycle the permission mode', source: 'builtin' as const },
]

interface Running {
  agent: Agent
  permissions: Permissions
}

export interface BackgroundNotice {
  sessionId: string
  title: string
  body: string
}

/**
 * Owns all engine state for the app. Every open chat has its own agent, so chats keep
 * working while you view another one. One chat is "active" (shown in the window).
 */
export class AppController {
  private settings: Settings
  private readonly secrets: SecretStore
  private registry!: ProviderRegistry
  private readonly usage: UsageTracker
  private readonly store: SessionStore
  private readonly memory: MemoryStore
  private readonly mcp: McpManager
  private mcpTimer: NodeJS.Timeout | null = null
  private ext: LoadedExtensions = { tools: [], commands: [], errors: [] }
  private tools: Tool[] = builtinTools()
  private workspace: string | null = null
  private agents = new Map<string, Running>()
  private activeId: string | null = null
  /** Chats deleted while their agent was still winding down; never save them again. */
  private removed = new Set<string>()
  private mode: PermissionMode
  private pending = new Map<string, { sessionId: string; resolve: (a: PermissionAnswer) => void }>()
  readonly paths: AppState['paths']

  constructor(
    private readonly dataDir: string,
    private readonly version: string,
    private readonly send: (e: UiEvent) => void,
    private readonly notify: (n: BackgroundNotice) => void = () => {},
  ) {
    this.paths = {
      data: dataDir,
      sessions: path.join(dataDir, 'sessions'),
      usage: path.join(dataDir, 'usage.jsonl'),
    }
    this.settings = this.loadSettings()
    this.mode = this.settings.permissions.mode
    this.secrets = new SecretStore(path.join(dataDir, 'secrets.json'))
    this.usage = new UsageTracker(this.paths.usage)
    this.store = new SessionStore(this.paths.sessions)
    this.memory = new MemoryStore(path.join(dataDir, 'memory'), this.settings.memory.maxChars)
    this.mcp = new McpManager({
      clientVersion: version,
      secret: (id) => this.secrets.get(mcpSecretId(id)),
      // Servers connect in the background; batch their updates into one tool refresh.
      onChange: () => {
        if (this.mcpTimer) return
        this.mcpTimer = setTimeout(() => {
          this.mcpTimer = null
          this.applyTools()
          this.pushState()
        }, 50)
      },
    })
    this.buildRegistry()
  }

  /** The agent for the chat shown in the window. */
  private get agent(): Agent | null {
    return (this.activeId && this.agents.get(this.activeId)?.agent) || null
  }

  // ---------- settings ----------

  private loadSettings(): Settings {
    return loadSettingsFile(this.dataDir)
  }

  private saveSettings() {
    saveSettingsFile(this.dataDir, this.settings)
  }

  getSettings(): Settings {
    return this.settings
  }

  async setSettings(next: unknown): Promise<AppState> {
    const prev = this.settings
    this.settings = parseSettings(next)
    this.saveSettings()
    this.memory.maxChars = this.settings.memory.maxChars
    if (JSON.stringify(prev.providers) !== JSON.stringify(this.settings.providers) || prev.agent.requestRetries !== this.settings.agent.requestRetries) {
      this.buildRegistry()
    }
    if (prev.tools.loadProjectExtensions !== this.settings.tools.loadProjectExtensions || prev.tools.loadUserExtensions !== this.settings.tools.loadUserExtensions) {
      await this.reloadExtensions()
    }
    if (JSON.stringify(prev.mcp) !== JSON.stringify(this.settings.mcp)) void this.mcp.sync(this.settings.mcp.servers)
    for (const r of this.agents.values()) r.agent.updateSettings(this.settings)
    return this.state()
  }

  async resetSettings(): Promise<AppState> {
    const keep = { app: this.settings.app }
    return this.setSettings(keep)
  }

  // ---------- providers / keys ----------

  private buildRegistry() {
    const snapshot = this.registry?.cacheSnapshot()
    this.registry = new ProviderRegistry(this.settings.providers, (id) => this.secrets.get(id), {
      retries: this.settings.agent.requestRetries,
    })
    if (snapshot) this.registry.restoreCache(snapshot)
    for (const r of this.agents.values()) r.agent.setRegistry(this.registry)
  }

  setKey(providerId: string, key: string | null): AppState {
    this.secrets.set(providerId, key)
    this.buildRegistry()
    return this.state()
  }

  async listModels(providerId: string, refresh = false) {
    return this.registry.models(providerId, { refresh })
  }

  private isReady(providerId: string): boolean {
    return providerReady(this.settings.providers.find((p) => p.id === providerId), this.secrets.has(providerId))
  }

  async testProvider(providerId: string): Promise<ProviderTestResult> {
    const config = this.settings.providers.find((p) => p.id === providerId)
    if (!config?.enabled) return { ok: false, message: 'This provider is turned off.' }
    if (config.requiresKey && !this.secrets.has(providerId)) return { ok: false, message: 'No API key set.' }
    try {
      const models = await this.registry.models(providerId, { refresh: true })
      // The model list is often public; a tiny completion proves the key works.
      const model = this.settings.models.favorites.find((f) => f.providerId === providerId)?.modelId ??
        (this.settings.models.default.providerId === providerId ? this.settings.models.default.modelId : models[0]?.id)
      if (!model) return { ok: true, message: `Connected, but no models listed.`, models: 0 }
      const provider = this.registry.get(providerId)
      for await (const _ of provider.chat({ model, maxTokens: 5, messages: [{ role: 'user', content: 'Say OK' }] })) {
        /* drain */
      }
      return { ok: true, message: `Connected. ${models.length} models available; test request to ${model} succeeded.`, models: models.length }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }

  // ---------- extensions ----------

  async reloadExtensions(): Promise<AppState> {
    this.ext = this.workspace
      ? await loadExtensions(this.workspace, {
          user: this.settings.tools.loadUserExtensions,
          project: this.settings.tools.loadProjectExtensions,
        })
      : { tools: [], commands: [], errors: [] }
    for (const name of assembleTools(this.ext.tools).conflicts) {
      this.ext.errors.push({ file: name, error: `Tool "${name}" conflicts with a built-in tool and was skipped.` })
    }
    this.applyTools()
    return this.state()
  }

  /** Built-in tools, then this folder's extensions, then MCP tools; later duplicates are skipped. */
  private applyTools() {
    this.tools = assembleTools(this.ext.tools, this.mcp.tools()).tools
    for (const r of this.agents.values()) {
      // Extensions belong to a folder; chats in other folders keep theirs but get current MCP tools.
      if (r.agent.session.meta.cwd.normalize('NFC') === this.workspace) r.agent.updateSettings(this.settings, this.tools)
      else r.agent.updateSettings(this.settings, [...r.agent.availableTools.filter((t) => t.source !== 'mcp'), ...this.mcp.tools()])
    }
  }

  // ---------- MCP ----------

  /** Starts the configured MCP servers in the background. */
  startMcp() {
    void this.mcp.sync(this.settings.mcp.servers)
  }

  async restartMcp(id: string): Promise<AppState> {
    await this.mcp.restart(id)
    return this.state()
  }

  async setMcpToken(id: string, token: string | null): Promise<AppState> {
    this.secrets.set(mcpSecretId(id), token?.trim() || null)
    await this.mcp.sync(this.settings.mcp.servers)
    return this.state()
  }

  async dispose() {
    await this.mcp.close()
  }

  private extensionsInfo(): ExtensionsInfo {
    return {
      tools: this.tools.map((t) => ({ name: t.name, description: t.description, source: t.source ?? 'builtin', readOnly: t.readOnly, kind: t.kind })),
      commands: [...BUILTIN_COMMANDS, ...this.ext.commands.map((c) => ({ name: c.name, description: c.description, source: c.source }))],
      errors: this.ext.errors,
      userDir: USER_EXT_DIR,
      projectDir: this.workspace ? projectExtDir(this.workspace) : null,
    }
  }

  extensionDir(which: 'user' | 'project'): string | null {
    const dir = which === 'user' ? USER_EXT_DIR : this.workspace && projectExtDir(this.workspace)
    if (!dir) return null
    for (const sub of ['tools', 'commands']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    return dir
  }

  // ---------- workspace & sessions ----------

  /** Opens a folder (adding it to the sidebar) and shows its most recent chat. */
  async setWorkspace(dir: string): Promise<AppState> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`)
    const cwd = await this.enterFolder(dir)
    const latest = this.store.list({ cwd })[0]
    const session = latest ? this.store.load(latest.id) : null
    this.activate(session ?? newSession(cwd, this.settings.models.default))
    return this.state()
  }

  /**
   * Makes `dir` the current folder: keeps it in the sidebar and recents and loads its
   * extensions. Chats in other folders keep running with their own tools.
   */
  private async enterFolder(dir: string): Promise<string> {
    // NFC so the same folder isn't treated as two (macOS may return decomposed Unicode).
    const cwd = path.resolve(dir).normalize('NFC')
    const changed = cwd !== this.workspace
    this.workspace = cwd
    const app = this.settings.app
    const recents = [cwd, ...app.recentWorkspaces.map((w) => w.normalize('NFC')).filter((w) => w !== cwd)].slice(0, 10)
    const open = app.openWorkspaces.includes(cwd) ? app.openWorkspaces : [...app.openWorkspaces, cwd]
    this.settings = { ...this.settings, app: { ...app, lastWorkspace: cwd, recentWorkspaces: recents, openWorkspaces: open } }
    this.saveSettings()
    if (changed) await this.reloadExtensions()
    return cwd
  }

  /** Removes a folder from the sidebar. Its chats stay on disk, and running ones finish. */
  async closeWorkspace(dir: string): Promise<AppState> {
    const cwd = dir.normalize('NFC')
    const open = this.settings.app.openWorkspaces.filter((w) => w !== cwd)
    this.settings = { ...this.settings, app: { ...this.settings.app, openWorkspaces: open } }
    this.saveSettings()
    if (cwd !== this.workspace) return this.state()
    if (open.length) return this.setWorkspace(open[0])
    this.workspace = null
    this.activeId = null
    this.settings = { ...this.settings, app: { ...this.settings.app, lastWorkspace: null } }
    this.saveSettings()
    await this.reloadExtensions()
    return this.state()
  }

  async restoreWorkspace(): Promise<void> {
    const app = this.settings.app
    // Folders that were deleted or unmounted drop out; older settings only knew the last folder.
    let open = app.openWorkspaces.map((w) => w.normalize('NFC')).filter((w) => fs.existsSync(w))
    const last = app.lastWorkspace && fs.existsSync(app.lastWorkspace) ? app.lastWorkspace.normalize('NFC') : null
    if (!open.length && last) open = [last]
    this.settings = { ...this.settings, app: { ...app, openWorkspaces: open } }
    const start = last && open.includes(last) ? last : open[0]
    if (start) await this.setWorkspace(start).catch(() => {})
  }

  private activate(session: Session) {
    const id = session.meta.id
    this.activeId = id
    const existing = this.agents.get(id)
    if (existing) {
      // Re-insert so the map stays in most-recently-used order.
      this.agents.delete(id)
      this.agents.set(id, existing)
    } else {
      this.agents.set(id, this.createAgent(session))
    }
    this.prune()
    // Warm the model cache so context size and pricing are known.
    this.registry.models(session.meta.model.providerId).catch(() => {})
  }

  private createAgent(session: Session): Running {
    const id = session.meta.id
    const permissions = new Permissions({ ...this.settings.permissions, mode: this.mode }, session.meta.cwd)
    const agent = new Agent({
      session,
      registry: this.registry,
      tools: this.tools,
      settings: this.settings,
      usage: this.usage,
      permissions,
      memory: this.memory,
      onSave: (s) => {
        if (s.messages.length && !this.removed.has(id)) this.store.save(s)
      },
      onEvent: (event) => this.onAgentEvent(id, event),
      askPermission: (request) =>
        new Promise<PermissionAnswer>((resolve) => {
          // Call ids are only unique within a chat (providers reuse ids like "call_0").
          this.pending.set(`${id}:${request.callId}`, { sessionId: id, resolve })
          this.send({ type: 'permission', sessionId: id, request })
          if (id !== this.activeId) this.notify({ sessionId: id, title: agent.session.meta.title, body: `Needs approval: ${request.tool} ${request.subject}`.trim() })
          this.pushState()
        }),
    })
    return { agent, permissions }
  }

  /** Keep a handful of idle chats warm (they remember "allow for this session" rules); drop the rest. */
  private prune(keep = 8) {
    const idle = [...this.agents.entries()].filter(
      ([id, r]) => id !== this.activeId && !r.agent.running && !this.awaiting(id) && !r.agent.jobs.list().some((j) => !j.done),
    )
    for (const [id, r] of idle.slice(0, Math.max(0, idle.length - keep))) {
      r.agent.dispose()
      this.agents.delete(id)
    }
  }

  private awaiting(sessionId: string): boolean {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return true
    return false
  }

  private onAgentEvent(sessionId: string, event: AgentEvent) {
    if (this.removed.has(sessionId)) return
    this.send({ type: 'agent', sessionId, event })
    if (event.type === 'turn_end') {
      this.cancelPending(sessionId)
      if (sessionId !== this.activeId) {
        const title = this.agents.get(sessionId)?.agent.session.meta.title ?? 'Chat'
        const body = ({ done: 'Finished.', error: 'Stopped with an error.', aborted: 'Stopped.', max_steps: 'Hit the step limit.', budget: 'Hit the budget limit.' })[event.reason]
        this.notify({ sessionId, title, body })
      }
    }
    // Titles, session lists and running indicators change at these points.
    if (event.type === 'turn_start' || event.type === 'turn_end' || (event.type === 'message' && event.index === 0)) this.pushState()
    // Compaction rewrites history; resync the renderer's copy.
    if (event.type === 'compacted') this.pushState()
  }

  private cancelPending(sessionId?: string) {
    for (const [key, p] of this.pending) {
      if (sessionId && p.sessionId !== sessionId) continue
      this.pending.delete(key)
      p.resolve({ type: 'deny', feedback: 'Cancelled.' })
      this.send({ type: 'permission_cancelled', sessionId: p.sessionId, callId: key.slice(p.sessionId.length + 1) })
    }
  }

  async openSession(id: string): Promise<AppState> {
    if (!this.agents.has(id)) {
      const s = this.store.load(id)
      if (!s) throw new Error('Session not found')
      this.activate(s)
    } else this.activate(this.agents.get(id)!.agent.session)
    // A chat in another folder switches folders (and that folder's extensions).
    await this.enterFolder(this.agent!.session.meta.cwd)
    return this.state()
  }

  async createSession(cwd?: string): Promise<AppState> {
    const dir = cwd ?? this.workspace
    if (!dir) throw new Error('Open a folder first.')
    const model = this.agent?.model ?? this.settings.models.default
    this.activate(newSession(await this.enterFolder(dir), model))
    return this.state()
  }

  private discard(id: string) {
    const r = this.agents.get(id)
    this.removed.add(id)
    this.cancelPending(id)
    r?.agent.dispose()
    this.agents.delete(id)
  }

  removeSession(id: string): AppState {
    const model = this.agent?.model ?? this.settings.models.default
    this.discard(id)
    this.store.delete(id)
    if (this.activeId === id) {
      this.activeId = null
      if (this.workspace) this.activate(newSession(this.workspace, model))
    }
    return this.state()
  }

  removeAllSessions(): AppState {
    const model = this.agent?.model ?? this.settings.models.default
    for (const id of [...this.agents.keys()]) this.discard(id)
    this.store.deleteAll()
    this.activeId = null
    if (this.workspace) this.activate(newSession(this.workspace, model))
    return this.state()
  }

  // ---------- agent ----------

  async sendMessage(text: string, attachments: AttachmentInput[] = []): Promise<void> {
    if (!this.agent) throw new Error('Open a folder first.')
    // Check before the prompt is posted, so a missing key never leaves an orphaned message.
    const { providerId } = this.agent.model
    const config = this.settings.providers.find((p) => p.id === providerId)
    if (!config) throw new Error(`The provider "${providerId}" no longer exists. Pick another model (⌘/Ctrl+K).`)
    if (!config.enabled) throw new Error(`${config.name} is turned off. Turn it on in Settings → Providers & Keys, or pick another model.`)
    if (!this.isReady(providerId)) throw new Error(`${config.name} needs an API key. Add one in Settings → Providers & Keys.`)
    if (attachments.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files at a time.`)
    // Read everything first so one bad file fails the send without posting a half message.
    const files: FileAttachment[] = []
    const images: ImageAttachment[] = []
    for (const a of attachments) {
      if (a.data && a.mediaType) images.push(imageFromData(a.name, a.mediaType, a.data))
      else if (a.path) {
        const loaded = loadAttachment(a.path)
        if (loaded.kind === 'image') images.push(loaded.image)
        else files.push(loaded.file)
      }
    }
    const expanded = expandSlashCommand(text, this.ext.commands) ?? text
    await this.agent.send(expanded, { files, images })
  }

  /** Stops the chat shown in the window; other chats keep going. */
  stop() {
    if (!this.activeId) return
    this.cancelPending(this.activeId)
    this.agent?.stop()
  }

  respond(sessionId: string, callId: string, answer: PermissionAnswer) {
    const key = `${sessionId}:${callId}`
    const p = this.pending.get(key)
    this.pending.delete(key)
    p?.resolve(answer)
    if (p) this.pushState()
  }

  setModel(ref: ModelRef): AppState {
    this.agent?.setModel(ref)
    this.registry.models(ref.providerId).catch(() => {})
    const recent = pushRecent(this.settings.models.recent, ref)
    this.settings = { ...this.settings, models: { ...this.settings.models, recent } }
    this.saveSettings()
    return this.state()
  }

  setMode(mode: PermissionMode): AppState {
    this.mode = mode
    for (const r of this.agents.values()) r.permissions.setMode(mode)
    return this.state()
  }

  async compact(): Promise<boolean> {
    if (!this.agent || this.agent.running) return false
    return this.agent.compact()
  }

  // ---------- usage ----------

  usageCsv(): string {
    return this.usage.toCsv()
  }

  clearUsage(): AppState {
    this.usage.clear()
    return this.state()
  }

  // ---------- state ----------

  private sessionView(): SessionView | null {
    if (!this.agent) return null
    const s = this.agent.session
    return { meta: s.meta, messages: s.messages, todos: s.todos, displays: s.displays ?? {}, denied: s.denied ?? [] }
  }

  // ---------- memory ----------

  private memoryInfo(): MemoryInfo {
    const cwd = this.workspace ?? ''
    return {
      global: this.memory.list('global', cwd),
      project: this.workspace ? this.memory.list('project', this.workspace) : [],
      globalFile: this.memory.file('global', cwd),
      projectFile: this.workspace ? this.memory.file('project', this.workspace) : null,
    }
  }

  removeMemory(scope: 'project' | 'global', fact: string): AppState {
    if (scope === 'global' || this.workspace) this.memory.delete(scope, this.workspace ?? '', fact)
    return this.state()
  }

  clearMemory(scope: 'project' | 'global'): AppState {
    if (scope === 'global' || this.workspace) this.memory.clear(scope, this.workspace ?? '')
    return this.state()
  }

  /** Chats for every open folder, from one pass over the store. */
  private sessionLists(): Pick<AppState, 'sessions' | 'folders'> {
    const byFolder = new Map<string, AppState['sessions']>()
    for (const meta of this.store.list()) {
      const cwd = meta.cwd.normalize('NFC')
      byFolder.set(cwd, [...(byFolder.get(cwd) ?? []), meta])
    }
    return {
      sessions: this.workspace ? (byFolder.get(this.workspace) ?? []) : [],
      folders: this.settings.app.openWorkspaces.map((p) => ({ path: p, sessions: byFolder.get(p) ?? [] })),
    }
  }

  state(): AppState {
    const keys: Record<string, boolean> = {}
    const ready: Record<string, boolean> = {}
    for (const p of this.settings.providers) {
      keys[p.id] = this.secrets.has(p.id)
      ready[p.id] = providerReady(p, keys[p.id])
    }
    return {
      version: this.version,
      platform: process.platform,
      settings: this.settings,
      keys,
      ready,
      keyStorage: this.secrets.storage,
      providerPresets: PROVIDER_PRESETS,
      workspace: this.workspace,
      session: this.sessionView(),
      ...this.sessionLists(),
      usage: this.usage.summary(this.agent?.session.meta.id),
      mode: this.mode,
      running: this.agent?.running ?? false,
      runningSessions: [...this.agents.entries()].filter(([, r]) => r.agent.running).map(([id]) => id),
      awaitingSessions: [...new Set([...this.pending.values()].map((p) => p.sessionId))],
      extensions: this.extensionsInfo(),
      memory: this.memoryInfo(),
      mcp: {
        servers: this.mcp.status(),
        tokens: Object.fromEntries(this.settings.mcp.servers.map((s) => [s.id, this.secrets.has(mcpSecretId(s.id))])),
      },
      paths: this.paths,
    }
  }

  pushState() {
    this.send({ type: 'state', state: this.state() })
  }
}
