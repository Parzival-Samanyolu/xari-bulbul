import fs from 'node:fs'
import path from 'node:path'
import {
  Agent,
  McpManager,
  MemoryStore,
  type MemoryFact,
  Permissions,
  ProviderRegistry,
  SAVE_SKILL_TOOL,
  SEARCH_KEY_ID,
  findBrowser,
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
  ProviderError,
  BUILTIN_PROVIDERS,
  canTranscribe,
  checkpointChanges,
  listDir,
  readPreview,
  rootFor,
  chooseVoiceEngine,
  installWhisperBinary,
  installWhisperModel,
  localWhisperStatus,
  pickWhisperModel,
  providerReady,
  removeWhisper,
  runWhisperCli,
  transcribe,
  WHISPER_MODELS,
  whisperModelPath,
  pushRecent,
  parseSettings,
  saveSettingsFile,
  projectExtDir,
  PLUGIN_CATALOG,
  activePlugins,
  detectPlugins,
  installPlugin,
  mergePluginServers,
  pluginDir,
  pluginMcpServers,
  pluginRoot,
  pluginTreeUrl,
  readInstalled,
  uninstallPlugin,
  writeInstalled,
  type InstalledPlugin,
  type PluginScope,
  type AgentEvent,
  type DirListing,
  type FileAttachment,
  type FileChange,
  type FilePreview,
  type ImageAttachment,
  type LoadedExtensions,
  type ModelRef,
  type PermissionAnswer,
  type PermissionMode,
  type QuestionRequest,
  type Schedule,
  type Session,
  type SessionMeta,
  type Settings,
  type Tool,
  type WhisperModelId,
} from '@harness/core'
import type { AppState, AttachmentInput, ExtensionsInfo, MemoryInfo, PluginInfo, ProviderTestResult, SessionView, UiEvent, VoiceDownload, VoiceState } from '../shared/ipc'
import { Scheduler } from './scheduler'
import { SecretStore } from './secrets'
import { Terminals } from './terminals'

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
  private readonly scheduler: Scheduler
  private catchUpTimer: NodeJS.Timeout | null = null
  private voiceDownload: { ac: AbortController; progress: VoiceDownload } | null = null
  private ext: LoadedExtensions = { tools: [], commands: [], skills: [], errors: [] }
  /** Plugins from the catalog that are installed (`<dataDir>/plugins.json`). */
  private plugins: InstalledPlugin[]
  /** Catalog plugins whose app was found at launch: id → the path that matched. */
  private readonly detected: Record<string, string>
  /** The plugin being installed or removed. */
  private pluginBusy: string | null = null
  private readonly terminals: Terminals
  private tools: Tool[] = builtinTools()
  private workspace: string | null = null
  private agents = new Map<string, Running>()
  private activeId: string | null = null
  /** Chats deleted while their agent was still winding down; never save them again. */
  private removed = new Set<string>()
  private mode: PermissionMode
  private pending = new Map<string, { sessionId: string; resolve: (a: PermissionAnswer) => void }>()
  /** Open ask_user questions, keyed like approvals. */
  private questions = new Map<string, { sessionId: string; request: QuestionRequest; resolve: (text: string) => void }>()
  /** Every saved chat's metadata, read from disk once and then kept current, so state pushes don't re-read every file. */
  private index: Map<string, SessionMeta> | null = null
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
    this.terminals = new Terminals(send)
    this.plugins = readInstalled(dataDir)
    // Stat only: nothing is started to look for apps.
    this.detected = detectPlugins(PLUGIN_CATALOG)
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
    this.scheduler = new Scheduler(
      path.join(dataDir, 'schedules.json'),
      () => this.settings.schedules,
      (s) => this.runScheduled(s),
      () => this.pushState(),
    )
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
    if (JSON.stringify(prev.schedules) !== JSON.stringify(this.settings.schedules)) this.scheduler.arm()
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
      fillContext: true,
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
      // Anthropic and OpenAI refuse to list models without a valid key, so the list proves it
      // and the test costs nothing.
      if (config.api === 'anthropic' || /^https:\/\/api\.openai\.com\//.test(config.baseUrl)) {
        return { ok: true, message: `Connected. Key accepted; ${models.length} models available. No paid request was sent.`, models: models.length }
      }
      // Elsewhere the model list is often public; a tiny completion proves the key works, on a free model when there is one.
      const model = this.settings.models.favorites.find((f) => f.providerId === providerId)?.modelId ??
        (this.settings.models.default.providerId === providerId
          ? this.settings.models.default.modelId
          : (models.find((m) => m.free) ?? models[0])?.id)
      if (!model) return { ok: true, message: `Connected, but no models listed.`, models: 0 }
      const provider = this.registry.get(providerId)
      try {
        for await (const _ of provider.chat({ model, maxTokens: 5, messages: [{ role: 'user', content: 'Say OK' }] })) {
          /* drain */
        }
      } catch (e) {
        // A 404 for the model comes after the key was checked, so the key works; the model just isn't served.
        if (!(e instanceof ProviderError && e.status === 404)) throw e
        return { ok: true, message: `Connected. Key accepted; ${models.length} models listed. ${model} isn't served, so it's hidden now.`, models: models.length }
      }
      return { ok: true, message: `Connected. ${models.length} models available; test request to ${model} succeeded.`, models: models.length }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }

  // ---------- voice ----------

  private voiceState(): VoiceState {
    const ref = this.settings.models.transcription
    const config = ref && this.settings.providers.find((p) => p.id === ref.providerId)
    const provider = !!(ref?.modelId.trim() && canTranscribe(config || undefined) && this.isReady(ref.providerId))
    const status = localWhisperStatus(this.dataDir)
    const model = pickWhisperModel(status, this.settings.voice.localModel)
    return {
      engine: chooseVoiceEngine(this.settings.voice.engine, { local: !!(status.binary && model), provider }),
      provider,
      local: { ...status, model },
      download: this.voiceDownload?.progress ?? null,
    }
  }

  /** Recording bytes from the composer's mic button → text. Local transcription takes a 16 kHz WAV the renderer made. */
  async transcribe(audio: Uint8Array, mediaType: string): Promise<string> {
    if (!(audio instanceof Uint8Array)) throw new Error('No recording received.')
    const voice = this.voiceState()
    if (voice.engine === 'local') {
      if (!/^audio\/(x-)?wav\b/.test(mediaType)) throw new Error('Local transcription needs a WAV recording.')
      return runWhisperCli({ bin: voice.local.binary!.path, model: whisperModelPath(this.dataDir, voice.local.model as WhisperModelId), wav: audio, signal: AbortSignal.timeout(300_000) })
    }
    const ref = this.settings.models.transcription
    const config = ref && this.settings.providers.find((p) => p.id === ref.providerId)
    if (!ref?.modelId.trim() || !config) throw new Error('Choose a transcription model in Settings → Models, or download a local speech model.')
    if (!canTranscribe(config)) throw new Error(`${config.name} has no transcription endpoint.`)
    if (!this.isReady(ref.providerId)) throw new Error(`Add a ${config.name} API key in Settings → Providers & Keys.`)
    return transcribe({ provider: config, apiKey: this.secrets.get(ref.providerId), model: ref.modelId.trim(), audio, mediaType }, { signal: AbortSignal.timeout(120_000) })
  }

  /** Fetches whisper.cpp (if this platform has a published build and none is installed) and the chosen model. */
  async downloadWhisper(): Promise<AppState> {
    if (this.voiceDownload) throw new Error('A speech model download is already running.')
    const model = this.settings.voice.localModel
    const ac = new AbortController()
    const status = localWhisperStatus(this.dataDir)
    const needBinary = !status.binary && status.canDownloadBinary
    const needModel = !status.models.find((m) => m.id === model)?.installed
    if (!needBinary && !needModel) return this.state()
    const modelSize = WHISPER_MODELS.find((m) => m.id === model)?.size ?? 0
    const progress: VoiceDownload = needBinary ? { step: 'binary', model, received: 0, total: status.binarySize ?? 0 } : { step: 'model', model, received: 0, total: modelSize }
    this.voiceDownload = { ac, progress }
    let last = 0
    const onProgress = (received: number, total: number) => {
      progress.received = received
      progress.total = total
      const now = Date.now()
      if (now - last < 200 && received !== total) return
      last = now
      this.send({ type: 'voice_download', download: { ...progress } })
    }
    this.pushState()
    try {
      if (needBinary) await installWhisperBinary(this.dataDir, { signal: ac.signal, onProgress })
      if (needModel) {
        Object.assign(progress, { step: 'model', received: 0, total: modelSize })
        this.send({ type: 'voice_download', download: { ...progress } })
        await installWhisperModel(this.dataDir, model, { signal: ac.signal, onProgress })
      }
    } catch (e) {
      if (!ac.signal.aborted) throw e
    } finally {
      this.voiceDownload = null
      this.pushState()
    }
    return this.state()
  }

  cancelWhisperDownload(): AppState {
    this.voiceDownload?.ac.abort()
    return this.state()
  }

  removeWhisper(what: string): AppState {
    if (this.voiceDownload) throw new Error('Wait for the download to finish or cancel it first.')
    if (what !== 'binary' && !WHISPER_MODELS.some((m) => m.id === what)) throw new Error(`Unknown speech model: ${what}`)
    removeWhisper(this.dataDir, what as 'binary' | WhisperModelId)
    return this.state()
  }

  // ---------- extensions ----------

  async reloadExtensions(): Promise<AppState> {
    this.ext = this.workspace ? await this.loadExtensionsFor(this.workspace) : { tools: [], commands: [], skills: [], errors: [] }
    for (const name of assembleTools(this.ext.tools).conflicts) {
      this.ext.errors.push({ file: name, error: `Tool "${name}" conflicts with a built-in tool and was skipped.` })
    }
    this.applyTools()
    return this.state()
  }

  /** A folder's extensions: yours, its project's and the turned-on plugins that apply there. */
  private loadExtensionsFor(cwd: string): Promise<LoadedExtensions> {
    return loadExtensions(cwd, {
      user: this.settings.tools.loadUserExtensions,
      project: this.settings.tools.loadProjectExtensions,
      plugins: activePlugins(this.plugins, cwd, USER_EXT_DIR),
    })
  }

  /** Built-in tools, then this folder's extensions, then MCP tools; later duplicates are skipped. */
  private applyTools() {
    this.tools = assembleTools(this.ext.tools, this.mcp.tools()).tools
    for (const r of this.agents.values()) {
      // Extensions belong to a folder; chats in other folders keep theirs but get current MCP tools.
      if (r.agent.session.meta.cwd.normalize('NFC') === this.workspace) {
        r.agent.updateSettings(this.settings, this.tools)
        r.agent.setSkills(this.ext.skills)
      } else r.agent.updateSettings(this.settings, [...r.agent.availableTools.filter((t) => t.source !== 'mcp'), ...this.mcp.tools()])
    }
  }

  // ---------- plugins ----------

  private pluginInfo(): PluginInfo[] {
    return PLUGIN_CATALOG.map((p) => {
      const rec = this.plugins.find((r) => r.id === p.id)
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        pin: p.pin,
        sourceUrl: `https://github.com/${p.repo}`,
        treeUrl: pluginTreeUrl(p),
        includes: p.includes,
        detected: this.detected[p.id] ?? null,
        installPaths: { user: pluginDir(USER_EXT_DIR, p.id), project: this.workspace ? pluginDir(projectExtDir(this.workspace), p.id) : null },
        installed: rec
          ? {
              pin: rec.pin,
              scope: rec.scope,
              cwd: rec.cwd ?? null,
              installedAt: rec.installedAt,
              enabled: rec.enabled,
              dir: pluginDir(pluginRoot(rec.scope, { userDir: USER_EXT_DIR, cwd: rec.cwd }), p.id),
            }
          : null,
        busy: this.pluginBusy === p.id,
      }
    })
  }

  listPlugins(): PluginInfo[] {
    return this.pluginInfo()
  }

  /** Installs (or updates to the catalog's pin) a plugin, turns it on and loads it. */
  async installPlugin(id: string, scope: PluginScope): Promise<AppState> {
    const entry = PLUGIN_CATALOG.find((p) => p.id === id)
    if (!entry) throw new Error(`Unknown plugin: ${id}`)
    if (scope !== 'user' && scope !== 'project') throw new Error(`Unknown scope: ${scope}`)
    if (this.pluginBusy) throw new Error('Another plugin is being installed. Try again in a moment.')
    const cwd = scope === 'project' ? this.workspace : null
    const root = pluginRoot(scope, { userDir: USER_EXT_DIR, cwd })
    const previous = this.plugins.find((p) => p.id === id)
    this.pluginBusy = id
    this.pushState()
    try {
      const files = await installPlugin(entry, { root, linkBase: cwd ?? root, signal: AbortSignal.timeout(120_000) })
      // Moving to the other scope leaves no copy behind.
      if (previous && (previous.scope !== scope || previous.cwd !== (cwd ?? undefined))) this.deletePluginFiles(previous)
      const record: InstalledPlugin = { id, pin: entry.pin, scope, ...(cwd ? { cwd } : {}), installedAt: Date.now(), enabled: true, files }
      this.plugins = [...this.plugins.filter((p) => p.id !== id), record]
      writeInstalled(this.dataDir, this.plugins)
    } finally {
      this.pluginBusy = null
    }
    return this.pluginsChanged(id)
  }

  /** Deletes a plugin's folder and its MCP servers. */
  async removePlugin(id: string): Promise<AppState> {
    const rec = this.plugins.find((p) => p.id === id)
    if (!rec) return this.state()
    this.deletePluginFiles(rec)
    this.plugins = this.plugins.filter((p) => p.id !== id)
    writeInstalled(this.dataDir, this.plugins)
    return this.pluginsChanged(id)
  }

  async setPluginEnabled(id: string, on: boolean): Promise<AppState> {
    const rec = this.plugins.find((p) => p.id === id)
    if (!rec) throw new Error('That plugin is not installed.')
    this.plugins = this.plugins.map((p) => (p.id === id ? { ...p, enabled: !!on } : p))
    writeInstalled(this.dataDir, this.plugins)
    return this.pluginsChanged(id)
  }

  private deletePluginFiles(rec: InstalledPlugin) {
    try {
      const root = pluginRoot(rec.scope, { userDir: USER_EXT_DIR, cwd: rec.cwd })
      uninstallPlugin(root, rec.id, rec.scope === 'project' && rec.cwd ? rec.cwd : root)
    } catch {
      // The project folder is gone; nothing left to delete.
    }
  }

  /** Puts the plugin's MCP servers in settings while it's installed and on, then reloads tools and servers. */
  private async pluginsChanged(id: string): Promise<AppState> {
    const rec = this.plugins.find((p) => p.id === id)
    const dir = rec && pluginDir(pluginRoot(rec.scope, { userDir: USER_EXT_DIR, cwd: rec.cwd }), id)
    const servers = mergePluginServers(this.settings.mcp.servers, id, rec?.enabled && dir ? pluginMcpServers(dir, id) : [])
    if (JSON.stringify(servers) !== JSON.stringify(this.settings.mcp.servers)) {
      this.settings = { ...this.settings, mcp: { ...this.settings.mcp, servers } }
      this.saveSettings()
      for (const r of this.agents.values()) r.agent.updateSettings(this.settings)
    }
    void this.mcp.sync(this.settings.mcp.servers)
    await this.reloadExtensions()
    this.pushState()
    return this.state()
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

  /** Stops running chats (so partial replies are saved) and MCP servers. */
  async dispose() {
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer)
    this.scheduler.dispose()
    this.voiceDownload?.ac.abort()
    this.cancelPending()
    this.terminals.dispose()
    for (const r of this.agents.values()) r.agent.stop()
    const deadline = Date.now() + 1500
    while ([...this.agents.values()].some((r) => r.agent.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    for (const r of this.agents.values()) r.agent.dispose()
    await this.mcp.close()
  }

  // ---------- schedules ----------

  /** Arms the schedule timer; after MCP servers had a moment to connect, catches up runs missed while closed. */
  startSchedules() {
    this.scheduler.arm()
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null
      this.scheduler.catchUp()
    }, 5000)
  }

  runScheduleNow(id: string): AppState {
    this.scheduler.runNow(id)
    return this.state()
  }

  /** Runs a schedule's prompt in a new chat in its folder, in the background (the chat on screen stays). */
  private async runScheduled(s: Schedule): Promise<void> {
    const cwd = path.resolve(s.cwd).normalize('NFC')
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Folder not found: ${cwd}`)
    // Another folder's chat gets that folder's extensions, like it would when opened.
    const ext =
      cwd === this.workspace
        ? this.ext
        : await this.loadExtensionsFor(cwd)
    const tools = cwd === this.workspace ? this.tools : assembleTools(ext.tools, this.mcp.tools()).tools
    const session = newSession(cwd, s.model ?? this.settings.models.default)
    session.meta.title = `⏰ ${s.name.trim() || 'Schedule'}`
    // Show the folder in the sidebar so the new chat is visible.
    if (!this.settings.app.openWorkspaces.includes(cwd)) {
      this.settings = { ...this.settings, app: { ...this.settings.app, openWorkspaces: [...this.settings.app.openWorkspaces, cwd] } }
      this.saveSettings()
    }
    this.prune()
    const running = this.createAgent(session, { tools, skills: ext.skills })
    this.agents.set(session.meta.id, running)
    this.registry.models(session.meta.model.providerId).catch(() => {})
    await running.agent.send(expandSlashCommand(s.prompt, ext.commands) ?? s.prompt)
  }

  private extensionsInfo(): ExtensionsInfo {
    return {
      tools: this.tools.map((t) => ({ name: t.name, description: t.description, source: t.source ?? 'builtin', readOnly: t.readOnly, kind: t.kind, plugin: t.plugin })),
      commands: [...BUILTIN_COMMANDS, ...this.ext.commands.map((c) => ({ name: c.name, description: c.description, source: c.source, plugin: c.plugin }))],
      errors: this.ext.errors,
      userDir: USER_EXT_DIR,
      projectDir: this.workspace ? projectExtDir(this.workspace) : null,
    }
  }

  /** Deletes a skill folder, if it is one the loader found (Claude Code's own skills are left alone). */
  async removeSkill(dir: string): Promise<AppState> {
    const skill = this.ext.skills.find((s) => s.dir === dir)
    if (skill && skill.source !== 'claude' && !skill.plugin) fs.rmSync(skill.dir, { recursive: true, force: true })
    return this.reloadExtensions()
  }

  extensionDir(which: 'user' | 'project'): string | null {
    const dir = which === 'user' ? USER_EXT_DIR : this.workspace && projectExtDir(this.workspace)
    if (!dir) return null
    for (const sub of ['tools', 'commands', 'skills']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
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

  /** Reorders the sidebar's folders. Unknown paths are ignored; open folders left out keep their place at the end. */
  reorderWorkspaces(paths: string[]): AppState {
    const open = this.settings.app.openWorkspaces
    const wanted = paths.map((p) => p.normalize('NFC')).filter((p, i, all) => open.includes(p) && all.indexOf(p) === i)
    this.settings = { ...this.settings, app: { ...this.settings.app, openWorkspaces: [...wanted, ...open.filter((p) => !wanted.includes(p))] } }
    this.saveSettings()
    return this.state()
  }

  /** Removes a folder from the sidebar. Its chats stay on disk, and running ones finish. */
  async closeWorkspace(dir: string): Promise<AppState> {
    const cwd = dir.normalize('NFC')
    const open = this.settings.app.openWorkspaces.filter((w) => w !== cwd)
    this.settings = { ...this.settings, app: { ...this.settings.app, openWorkspaces: open } }
    this.saveSettings()
    this.terminals.killFolder(cwd)
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

  private createAgent(session: Session, own?: { tools: Tool[]; skills: LoadedExtensions['skills'] }): Running {
    const id = session.meta.id
    const permissions = new Permissions({ ...this.settings.permissions, mode: this.mode }, session.meta.cwd)
    const agent = new Agent({
      session,
      registry: this.registry,
      tools: own?.tools ?? this.tools,
      settings: this.settings,
      usage: this.usage,
      permissions,
      memory: this.memory,
      skills: own?.skills ?? this.ext.skills,
      sessions: { list: (opts) => this.sessionMetas(opts?.cwd), load: (sid) => this.store.load(sid) },
      secret: (id) => this.secrets.get(id),
      onSave: (s) => {
        if (!s.messages.length || this.removed.has(id)) return
        this.store.save(s)
        this.index?.set(id, { ...s.meta })
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
      askUser: (request) =>
        new Promise<string>((resolve) => {
          this.questions.set(`${id}:${request.callId}`, { sessionId: id, request, resolve })
          if (id !== this.activeId) this.notify({ sessionId: id, title: agent.session.meta.title, body: `Has a question: ${request.question}` })
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
    for (const p of [...this.pending.values(), ...this.questions.values()]) if (p.sessionId === sessionId) return true
    return false
  }

  private onAgentEvent(sessionId: string, event: AgentEvent) {
    if (this.removed.has(sessionId)) return
    this.send({ type: 'agent', sessionId, event })
    // A saved skill shows up in Settings and in the folder's other chats.
    if (event.type === 'tool_end' && event.name === SAVE_SKILL_TOOL && !event.result.isError) void this.reloadExtensions().then(() => this.pushState())
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
    if (event.type === 'compacted' || event.type === 'title' || event.type === 'memory') this.pushState()
  }

  private cancelPending(sessionId?: string) {
    for (const [key, p] of this.pending) {
      if (sessionId && p.sessionId !== sessionId) continue
      this.pending.delete(key)
      p.resolve({ type: 'deny', feedback: 'Cancelled.' })
      this.send({ type: 'permission_cancelled', sessionId: p.sessionId, callId: key.slice(p.sessionId.length + 1) })
    }
    for (const [key, q] of this.questions) {
      if (sessionId && q.sessionId !== sessionId) continue
      this.questions.delete(key)
      q.resolve('')
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
    this.index?.delete(id)
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
    this.index = null
    this.activeId = null
    if (this.workspace) this.activate(newSession(this.workspace, model))
    return this.state()
  }

  // ---------- agent ----------

  /** The chat on screen, after checking its provider can take a request. */
  private readyAgent(): Agent {
    if (!this.agent) throw new Error('Open a folder first.')
    // Check before the prompt is posted, so a missing key never leaves an orphaned message.
    const { providerId } = this.agent.model
    const config = this.settings.providers.find((p) => p.id === providerId)
    if (!config) throw new Error(`The provider "${providerId}" no longer exists. Pick another model (⌘/Ctrl+K).`)
    if (!config.enabled) throw new Error(`${config.name} is turned off. Turn it on in Settings → Providers & Keys, or pick another model.`)
    if (!this.isReady(providerId)) throw new Error(`${config.name} needs an API key. Add one in Settings → Providers & Keys.`)
    return this.agent
  }

  async retry(): Promise<void> {
    await this.readyAgent().retry()
  }

  async editMessage(index: number, text: string, revert: boolean): Promise<void> {
    const agent = this.readyAgent()
    await agent.editAndResend(index, expandSlashCommand(text, this.ext.commands) ?? text, { revert })
  }

  revert(at: number, file?: string): AppState {
    this.agent?.revert(at, file)
    return this.state()
  }

  answer(sessionId: string, callId: string, text: string): AppState {
    const key = `${sessionId}:${callId}`
    const q = this.questions.get(key)
    this.questions.delete(key)
    q?.resolve(text)
    return this.state()
  }

  async sendMessage(text: string, attachments: AttachmentInput[] = []): Promise<void> {
    this.readyAgent()
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
    await this.agent!.send(expanded, { files, images })
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

  // ---------- files, changes, terminals (Elite layout panels) ----------

  /** The open folder that contains `p`; anything outside the open folders is refused. */
  private openRoot(p: unknown): string {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Expected an absolute path.')
    const root = rootFor(this.settings.app.openWorkspaces, p.normalize('NFC'))
    if (!root) throw new Error('That path is outside the open folders.')
    return root
  }

  listDir(dir: string): Promise<DirListing> {
    return listDir(this.openRoot(dir), path.resolve(dir).normalize('NFC'))
  }

  readFile(file: string): Promise<FilePreview> {
    this.openRoot(file)
    return readPreview(path.resolve(file))
  }

  sessionDiff(id: string): FileChange[] {
    const session = this.agents.get(id)?.agent.session ?? this.store.load(id)
    if (!session) throw new Error('Session not found')
    return checkpointChanges(session.checkpoints ?? [], session.meta.cwd)
  }

  termOpen(cwd: string, cols: number, rows: number): string {
    this.openRoot(cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`Not a folder: ${cwd}`)
    return this.terminals.open(cwd.normalize('NFC'), cols, rows)
  }

  termWrite(id: string, data: string) {
    if (typeof data === 'string') this.terminals.write(id, data)
  }

  termResize(id: string, cols: number, rows: number) {
    this.terminals.resize(id, cols, rows)
  }

  termKill(id: string) {
    this.terminals.kill(id)
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
    return { meta: s.meta, messages: s.messages, todos: s.todos, displays: s.displays ?? {}, denied: s.denied ?? [], checkpoints: s.checkpoints ?? [] }
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

  undoMemory(sessionId: string, added: MemoryFact[], removed: MemoryFact[]): AppState {
    const cwd = this.agents.get(sessionId)?.agent.session.meta.cwd ?? this.store.load(sessionId)?.meta.cwd
    if (!cwd) return this.state()
    for (const f of added) this.memory.delete(f.scope, cwd, f.fact)
    for (const f of removed) {
      try {
        this.memory.add(f.scope, cwd, f.fact)
      } catch {
        // Memory filled up since; the fact stays removed.
      }
    }
    return this.state()
  }

  clearMemory(scope: 'project' | 'global'): AppState {
    if (scope === 'global' || this.workspace) this.memory.clear(scope, this.workspace ?? '')
    return this.state()
  }

  /** Saved chats newest first, from the index instead of re-reading every file; only `cwd`'s when given. */
  private sessionMetas(cwd?: string): SessionMeta[] {
    this.index ??= new Map(this.store.list().map((m) => [m.id, m]))
    const want = cwd?.normalize('NFC')
    return [...this.index.values()].filter((m) => !want || m.cwd.normalize('NFC') === want).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Chats for every open folder, from one pass over the store. */
  private sessionLists(): Pick<AppState, 'sessions' | 'folders'> {
    const byFolder = new Map<string, AppState['sessions']>()
    for (const meta of this.sessionMetas()) {
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
    // Web search keys live next to API keys.
    for (const id of Object.values(SEARCH_KEY_ID)) keys[id] = this.secrets.has(id)
    return {
      version: this.version,
      platform: process.platform,
      settings: this.settings,
      keys,
      ready,
      keyStorage: this.secrets.storage,
      providerPresets: PROVIDER_PRESETS,
      builtinProviders: BUILTIN_PROVIDERS.map((p) => p.id),
      workspace: this.workspace,
      session: this.sessionView(),
      ...this.sessionLists(),
      usage: this.usage.summary(this.agent?.session.meta.id),
      mode: this.mode,
      running: this.agent?.running ?? false,
      runningSessions: [...this.agents.entries()].filter(([, r]) => r.agent.running).map(([id]) => id),
      awaitingSessions: [...new Set([...this.pending.values(), ...this.questions.values()].map((p) => p.sessionId))],
      questions: [...this.questions.values()].map(({ sessionId, request }) => ({ sessionId, request })),
      extensions: this.extensionsInfo(),
      skills: this.ext.skills.map((s) => ({ name: s.name, description: s.description, source: s.source, dir: s.dir, plugin: s.plugin })),
      plugins: this.pluginInfo(),
      memory: this.memoryInfo(),
      schedules: this.scheduler.status(),
      browser: findBrowser(this.settings.tools.browser.path),
      voice: this.voiceState(),
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
