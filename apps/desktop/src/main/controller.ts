import fs from 'node:fs'
import path from 'node:path'
import {
  Agent,
  activeBot,
  botThreads,
  chatBot,
  chatDefaults,
  chatPreview,
  isBotChat,
  latestBotThread,
  shownBots,
  McpManager,
  MemoryStore,
  type MemoryFact,
  Permissions,
  ProviderRegistry,
  SAVE_SKILL_TOOL,
  SEARCH_KEY_ID,
  findBrowser,
  IMessageGateway,
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
  LOCAL_PROVIDER_ID,
  upsertLocalProvider,
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
  openaiSpeech,
  speechModelTakesSpeed,
  WHISPER_MODELS,
  whisperModelPath,
  pushRecent,
  parseSettings,
  saveSettingsFile,
  exportSettings,
  importSettings,
  resetSettings,
  guessProviderApi,
  ProviderConfigSchema,
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
  type TelemetrySink,
  type Tool,
  type WhisperModelId,
  settingsPath,
} from '@harness/core'
import type { AppState, AttachmentInput, BotRow, EndpointProbe, EndpointProbeInput, ExtensionsInfo, MemoryInfo, PluginInfo, ProviderTestResult, SessionView, UiEvent, SpeechAudio, VoiceDownload, VoiceState } from '../shared/ipc'
import { LocalModels } from './local-models'
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
  /** Which `app.notify` switch decides whether it's shown. */
  kind: keyof Settings['app']['notify']
  title: string
  body: string
}

const DAY_MS = 86_400_000

const BOT_IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_AVATAR_BYTES = 1_000_000

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
  private readonly imessage: IMessageGateway
  private catchUpTimer: NodeJS.Timeout | null = null
  private voiceDownload: { ac: AbortController; progress: VoiceDownload } | null = null
  /** Local models (llama.cpp): runtime, downloads and the running llama-server. */
  readonly local: LocalModels
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
  /** Bot image avatars read so far: path → data URL ('' when unreadable). */
  private avatarCache = new Map<string, string>()
  /** Bots that finished replying while another chat was on screen. */
  private unreadBots = new Set<string>()
  readonly paths: AppState['paths']

  constructor(
    private readonly dataDir: string,
    private readonly version: string,
    private readonly send: (e: UiEvent) => void,
    private readonly notify: (n: BackgroundNotice) => void = () => {},
    private readonly opts: { telemetry?: TelemetrySink; shareInfoOff?: boolean } = {},
  ) {
    this.paths = {
      data: dataDir,
      sessions: path.join(dataDir, 'sessions'),
      usage: path.join(dataDir, 'usage.jsonl'),
    }
    this.settings = this.loadSettings()
    this.mode = this.settings.permissions.mode
    this.secrets = new SecretStore(path.join(dataDir, 'secrets.json'))
    this.markExistingInstallOnboarded()
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
    this.imessage = new IMessageGateway({
      stateFile: path.join(dataDir, 'gateways.json'),
      config: () => this.settings.gateways.imessage,
      run: (sender, text) => this.runGatewayMessage(sender, text),
      onChange: () => this.pushState(),
    })

    this.local = new LocalModels({
      dataDir,
      send,
      providers: () => this.settings.providers,
      setProviders: (providers, rebuild) => {
        this.settings = { ...this.settings, providers }
        this.saveSettings()
        if (rebuild) this.buildRegistry()
        this.pushState()
      },
      retries: () => this.settings.agent.requestRetries,
    })
    // A llama-server must not outlive the app, even when quitting skips dispose().
    process.once('exit', () => this.local.server.killNow())
    this.buildRegistry()
  }

  /** Share-info counter (a no-op unless main passed a client and the user allows it). */
  private count(name: string, props?: Record<string, string | number | boolean>) {
    try {
      this.opts.telemetry?.count(name, props)
    } catch {
      /* never let share info break a feature */
    }
  }

  /**
   * First-run setup is for new installs. A settings file from before it existed (no
   * `app.onboarded`) that shows the app was used (a saved key, chats, folders, a custom provider
   * or a layout choice) counts as onboarded, so existing users never see it.
   */
  private markExistingInstallOnboarded() {
    if (this.settings.app.onboarded) return
    let raw: { app?: Record<string, unknown> } | null = null
    try {
      raw = JSON.parse(fs.readFileSync(settingsPath(this.dataDir), 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || (raw.app && 'onboarded' in raw.app)) return
    const s = this.settings
    const used =
      s.app.layoutChosen ||
      s.app.openWorkspaces.length > 0 ||
      s.app.recentWorkspaces.length > 0 ||
      s.providers.some((p) => !BUILTIN_PROVIDERS.some((b) => b.id === p.id) || this.secrets.has(p.id)) ||
      (fs.existsSync(this.paths.sessions) && fs.readdirSync(this.paths.sessions).some((f) => f.endsWith('.json')))
    // Saved either way, so the check runs once: a new user who quits halfway through setup still sees it next time.
    this.settings = { ...s, app: { ...s.app, onboarded: used } }
    this.saveSettings()
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

  /** `prune: false` skips deleting old chats when the retention setting changed (import, reset). */
  async setSettings(next: unknown, opts: { prune?: boolean } = {}): Promise<AppState> {
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
    if (JSON.stringify(prev.gateways) !== JSON.stringify(this.settings.gateways)) this.imessage.sync()
    if (opts.prune !== false && prev.sessions.retentionDays !== this.settings.sessions.retentionDays) this.pruneSessions()
    if (JSON.stringify(prev.bots) !== JSON.stringify(this.settings.bots)) this.cleanBotImages()
    for (const r of this.agents.values()) {
      r.agent.updateSettings(this.settings)
      // A bot chat follows its bot's mode when that changes (the bot turned off or on, its mode edited).
      const id = r.agent.session.meta.botId
      const before = activeBot(prev, id)?.mode
      const after = activeBot(this.settings, id)?.mode
      // Gateway chats follow the gateway's mode instead.
      if (r.agent.session.meta.gateway) {
        if (prev.gateways.imessage.mode !== this.settings.gateways.imessage.mode) r.permissions.setMode(this.settings.gateways.imessage.mode)
      } else if (id && before !== after) r.permissions.setMode(after ?? this.mode)
    }
    return this.state()
  }

  /** Defaults for everything; keys, chats, this machine's folders and plugin MCP servers stay. */
  async resetSettings(): Promise<AppState> {
    return this.setSettings(resetSettings(this.settings), { prune: false })
  }

  /** Settings for a file: no keys (they never live in settings), folders or secret-looking MCP values. */
  exportSettings(): Record<string, unknown> {
    return exportSettings(this.settings)
  }

  /** Applies an imported file only if every field is valid; otherwise throws with the problems listed. */
  async importSettings(raw: unknown): Promise<AppState> {
    const r = importSettings(raw, this.settings)
    if (!r.ok) throw new Error(`That file isn't valid settings, so nothing was changed. ${r.errors.join(' · ')}`)
    return this.setSettings(r.settings, { prune: false })
  }

  // ---------- retention ----------

  /** Deletes chats older than `sessions.retentionDays`, except open, running or waiting ones. */
  pruneSessions(now = Date.now()): number {
    const days = this.settings.sessions.retentionDays
    if (!days) return 0
    const gone = this.store.prune(now - days * DAY_MS, (id) => this.agents.has(id) || this.awaiting(id))
    for (const id of gone) this.index?.delete(id)
    if (gone.length) this.pushState()
    return gone.length
  }

  // ---------- browser logins ----------

  private get browserProfileDir(): string {
    return path.join(this.dataDir, 'browser-profile')
  }

  /** Closes every chat's browser and deletes the kept profile (cookies, saved site logins). */
  clearBrowserLogins(): AppState {
    for (const r of this.agents.values()) r.agent.closeBrowserNow()
    fs.rmSync(this.browserProfileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return this.state()
  }

  // ---------- providers / keys ----------

  private buildRegistry() {
    const snapshot = this.registry?.cacheSnapshot()
    this.registry = new ProviderRegistry(this.settings.providers, (id) => this.secrets.get(id), {
      retries: this.settings.agent.requestRetries,
      fillContext: true,
    })
    if (snapshot) this.registry.restoreCache(snapshot)
    this.local?.register(this.registry)
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

  /**
   * Tries an endpoint that isn't saved yet: lists its models and, when a model is given, sends a
   * 5-token request. With api 'auto' the protocol the URL suggests is tried first, then the other.
   */
  async probeEndpoint(input: EndpointProbeInput): Promise<EndpointProbe> {
    if (!/^https?:\/\/\S+$/.test(input?.baseUrl?.trim() ?? '')) return { ok: false, message: 'Enter an http:// or https:// URL.', models: [] }
    const id = input.id?.trim() || 'probe'
    // A blank key falls back to the one already saved for this id (editing an endpoint).
    const key = input.key?.trim() || this.secrets.get(id)
    const order: ('openai' | 'anthropic')[] = input.api === 'auto' ? (guessProviderApi(input.baseUrl) === 'anthropic' ? ['anthropic', 'openai'] : ['openai', 'anthropic']) : [input.api]
    let last = ''
    for (const api of order) {
      const config = ProviderConfigSchema.parse({ id, name: input.name?.trim() || id, baseUrl: input.baseUrl.trim(), requiresKey: false, api })
      const registry = new ProviderRegistry([config], () => key, { retries: 0 })
      try {
        const models = (await registry.models(id, { refresh: true })).map((m) => m.id)
        if (input.model?.trim()) {
          for await (const _ of registry.get(id).chat({ model: input.model.trim(), maxTokens: 5, messages: [{ role: 'user', content: 'Say OK' }] })) {
            /* drain */
          }
          return { ok: true, api, models, message: `Connected. ${models.length} models listed; a test request to ${input.model.trim()} worked.` }
        }
        return { ok: true, api, models, message: models.length ? `Connected. ${models.length} models listed.` : 'Connected, but the endpoint lists no models. Type the model id.' }
      } catch (e) {
        last = (e as Error).message
      }
    }
    return { ok: false, message: last || 'No answer from that URL.', models: [] }
  }

  // ---------- voice ----------

  private voiceState(): VoiceState {
    const ref = this.settings.models.transcription
    const config = ref && this.settings.providers.find((p) => p.id === ref.providerId)
    const provider = !!(ref?.modelId.trim() && canTranscribe(config || undefined) && this.isReady(ref.providerId))
    const status = localWhisperStatus(this.dataDir)
    const model = pickWhisperModel(status, this.settings.voice.localModel)
    return {
      engine: this.settings.voice.enabled ? chooseVoiceEngine(this.settings.voice.engine, { local: !!(status.binary && model), provider }) : null,
      provider,
      local: { ...status, model },
      download: this.voiceDownload?.progress ?? null,
    }
  }

  /** Recording bytes from the composer's mic button → text. Local transcription takes a 16 kHz WAV the renderer made. */
  async transcribe(audio: Uint8Array, mediaType: string): Promise<string> {
    if (!(audio instanceof Uint8Array)) throw new Error('No recording received.')
    const voice = this.voiceState()
    if (!this.settings.voice.enabled) throw new Error('Voice input is turned off in Settings › Voice.')
    this.count('feature.voice_input', { engine: voice.engine === 'local' ? 'local' : 'provider' })
    if (voice.engine === 'local') {
      if (!/^audio\/(x-)?wav\b/.test(mediaType)) throw new Error('Local transcription needs a WAV recording.')
      return runWhisperCli({ bin: voice.local.binary!.path, model: whisperModelPath(this.dataDir, voice.local.model as WhisperModelId), wav: audio, language: this.settings.voice.language.trim(), signal: AbortSignal.timeout(300_000) })
    }
    const ref = this.settings.models.transcription
    const config = ref && this.settings.providers.find((p) => p.id === ref.providerId)
    if (!ref?.modelId.trim() || !config) throw new Error('Choose a transcription model in Settings › Voice › Speech to text, or download a local speech model.')
    if (!canTranscribe(config)) throw new Error(`${config.name} has no transcription endpoint.`)
    if (!this.isReady(ref.providerId)) throw new Error(`Add a ${config.name} API key in Settings › Providers › API keys.`)
    const language = this.settings.voice.language.trim() || undefined
    return transcribe({ provider: config, apiKey: this.secrets.get(ref.providerId), model: ref.modelId.trim(), audio, mediaType, language }, { signal: AbortSignal.timeout(120_000) })
  }

  // ---------- text to speech ----------

  /**
   * One chunk of a reply → MP3 through an OpenAI-style provider (the system voice plays in the
   * renderer). `playbackRate` is what the renderer should play it at: 1 when the service
   * already applied `voice.tts.rate`.
   */
  async synthesizeSpeech(text: string): Promise<SpeechAudio> {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to say.')
    const tts = this.settings.voice.tts
    const input = text.slice(0, 2000)
    if (tts.provider !== 'openai') throw new Error('Choose OpenAI under Settings › Voice › Text to speech.')
    const providerId = tts.openai.providerId
    const config = this.settings.providers.find((p) => p.id === providerId)
    if (!config || config.api !== 'openai') throw new Error('Choose a provider for speech in Settings › Voice › Text to speech.')
    if (!this.isReady(providerId)) throw new Error(`Add a ${config.name} API key in Settings › Providers › API keys.`)
    const audio = await openaiSpeech(
      { provider: config, apiKey: this.secrets.get(providerId), model: tts.openai.model, voice: tts.voice, text: input, rate: tts.rate },
      { signal: AbortSignal.timeout(60_000) },
    )
    return { audio, mediaType: 'audio/mpeg', playbackRate: speechModelTakesSpeed(tts.openai.model) ? 1 : tts.rate }
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
      // Catalog ids only (checked above), never a path.
      this.count('feature.plugin_installed', { id })
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
    this.imessage.dispose()
    this.voiceDownload?.ac.abort()
    this.cancelPending()
    this.terminals.dispose()
    for (const r of this.agents.values()) r.agent.stop()
    const deadline = Date.now() + 1500
    while ([...this.agents.values()].some((r) => r.agent.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    for (const r of this.agents.values()) r.agent.dispose()
    await Promise.all([this.mcp.close(), this.local.dispose()])
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
    this.count('feature.schedule_run')
    await running.agent.send(expandSlashCommand(s.prompt, ext.commands) ?? s.prompt)
  }

  // ---------- gateways ----------

  /** Starts the iMessage gateway if it's on (macOS only). */
  startGateways() {
    this.imessage.sync()
  }

  async imessageTest(): Promise<AppState> {
    await this.imessage.sendTest()
    return this.state()
  }

  /** Reads chat.db again now, e.g. right after Full Disk Access was granted. */
  async imessageCheck(): Promise<AppState> {
    this.imessage.sync()
    await this.imessage.poll()
    return this.state()
  }

  /**
   * Runs a text in the sender's chat (reused while it exists, else a new one in the gateway's
   * folder and bot), in the background like a schedule. Resolves with the reply to text back.
   */
  private async runGatewayMessage(sender: string, text: string): Promise<string | null> {
    const cfg = this.settings.gateways.imessage
    const tag = `imessage:${sender}`
    let running = [...this.agents.values()].find((r) => r.agent.session.meta.gateway === tag)
    if (!running) {
      const meta = this.sessionMetas().find((m) => m.gateway === tag && !this.removed.has(m.id))
      const saved = meta ? this.store.load(meta.id) : null
      if (saved) {
        running = this.createAgent(saved, await this.toolsFor(saved.meta.cwd.normalize('NFC')))
        this.agents.set(saved.meta.id, running)
      }
    }
    if (!running) {
      const cwd = path.resolve(cfg.cwd).normalize('NFC')
      if (!cfg.cwd.trim() || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return `The folder for iMessage chats is missing. Choose one in Xarı Bülbül › Settings › Gateways.`
      const bot = cfg.botId ? activeBot(this.settings, cfg.botId) : undefined
      const { model } = chatDefaults(this.settings, bot?.id, { model: this.settings.models.default, mode: this.mode })
      const session = newSession(cwd, model, { botId: bot?.id })
      session.meta.title = `💬 iMessage · ${sender}`
      session.meta.gateway = tag
      // Show the folder in the sidebar so the chat is visible.
      if (!this.settings.app.openWorkspaces.includes(cwd)) {
        this.settings = { ...this.settings, app: { ...this.settings.app, openWorkspaces: [...this.settings.app.openWorkspaces, cwd] } }
        this.saveSettings()
      }
      running = this.createAgent(session, await this.toolsFor(cwd))
      this.agents.set(session.meta.id, running)
    }
    this.prune()
    const agent = running.agent
    const { providerId } = agent.model
    const config = this.settings.providers.find((p) => p.id === providerId)
    if (!config?.enabled || !this.isReady(providerId)) return `The chat's model can't be reached (${config?.name ?? providerId} is off or has no API key). Open Xarı Bülbül to fix it.`
    // A turn you started in the app for this chat finishes first.
    while (agent.running) await new Promise((r) => setTimeout(r, 500))
    if (this.removed.has(agent.session.meta.id)) return null
    this.registry.models(providerId).catch(() => {})
    const from = agent.session.messages.length
    const reason = await agent.send(text)
    const reply = agent.session.messages
      .slice(from)
      .filter((m) => m.role === 'assistant' && m.content.trim() && !m.content.endsWith('[interrupted]'))
      .at(-1)?.content
    if (reason === 'done') return reply ?? null
    const why = ({ error: 'stopped with an error', aborted: 'was stopped', max_steps: 'hit the step limit', budget: 'hit the budget limit' } as const)[reason]
    return `${reply ? `${reply}\n\n` : ''}(The turn ${why}. Open Xarı Bülbül to see it.)`
  }

  /** The tools and skills a chat in `cwd` gets: that folder's extensions plus MCP tools. */
  private async toolsFor(cwd: string): Promise<{ tools: Tool[]; skills: LoadedExtensions['skills'] }> {
    if (cwd === this.workspace) return { tools: this.tools, skills: this.ext.skills }
    const ext = await this.loadExtensionsFor(cwd)
    return { tools: assembleTools(ext.tools, this.mcp.tools()).tools, skills: ext.skills }
  }

  /** A gateway chat waiting on an approval or question texts its sender once. */
  private gatewayAttention(agent: Agent, subject: string) {
    const tag = agent.session.meta.gateway
    if (tag?.startsWith('imessage:')) void this.imessage.needsAttention(tag.slice('imessage:'.length), subject.trim().slice(0, 200))
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
  async setWorkspace(dir: string, opts: { resume?: boolean } = {}): Promise<AppState> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`)
    const cwd = await this.enterFolder(dir)
    // Bot chats live in the Bots tab; a folder resumes its latest plain chat.
    const latest = opts.resume === false ? undefined : this.store.list({ cwd }).find((m) => !this.inBotsTab(m))
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
    if (start) await this.setWorkspace(start, { resume: app.resumeLastChat }).catch(() => {})
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
    // A bot's chats start in the bot's mode; gateway chats in the gateway's.
    const mode = session.meta.gateway ? this.settings.gateways.imessage.mode : (activeBot(this.settings, session.meta.botId)?.mode ?? this.mode)
    const permissions = new Permissions({ ...this.settings.permissions, mode }, session.meta.cwd)
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
      browserProfileDir: this.browserProfileDir,
      onSave: (s) => {
        if (!s.messages.length || this.removed.has(id)) return
        // The Bots tab shows a line of each bot chat's last message.
        if (s.meta.botId) s.meta.preview = chatPreview(s.messages)
        this.store.save(s)
        this.index?.set(id, { ...s.meta })
      },
      onEvent: (event) => this.onAgentEvent(id, event),
      askPermission: (request) =>
        new Promise<PermissionAnswer>((resolve) => {
          // Call ids are only unique within a chat (providers reuse ids like "call_0").
          this.pending.set(`${id}:${request.callId}`, { sessionId: id, resolve })
          this.send({ type: 'permission', sessionId: id, request })
          if (id !== this.activeId) this.notify({ sessionId: id, kind: 'approval', title: agent.session.meta.title, body: `Needs approval: ${request.tool} ${request.subject}`.trim() })
          this.gatewayAttention(agent, `${request.tool} ${request.subject}`)
          this.pushState()
        }),
      askUser: (request) =>
        new Promise<string>((resolve) => {
          this.questions.set(`${id}:${request.callId}`, { sessionId: id, request, resolve })
          if (id !== this.activeId) this.notify({ sessionId: id, kind: 'question', title: agent.session.meta.title, body: `Has a question: ${request.question}` })
          this.gatewayAttention(agent, `a question: ${request.question}`)
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
    // Share info gets the tool's kind only: MCP and extension tool names can carry the user's own names.
    if (event.type === 'tool_start') {
      const tool = this.tools.find((t) => t.name === event.name)
      this.count('feature.tool', { kind: tool?.source === 'mcp' ? 'mcp' : tool?.source && tool.source !== 'builtin' ? 'extension' : (tool?.kind ?? 'other') })
    }
    if (event.type === 'turn_end') {
      this.cancelPending(sessionId)
      if (sessionId !== this.activeId) {
        const session = this.agents.get(sessionId)?.agent.session
        const body = ({ done: 'Finished.', error: 'Stopped with an error.', aborted: 'Stopped.', max_steps: 'Hit the step limit.', budget: 'Hit the budget limit.' })[event.reason]
        const kind = event.reason === 'done' ? 'finished' : 'failed'
        const bot = session && !session.meta.gateway ? activeBot(this.settings, session.meta.botId) : undefined
        if (bot) {
          // A bot's reply: an unread dot on its row, and a notification with the reply unless muted.
          if (event.reason !== 'aborted') this.unreadBots.add(bot.id)
          if (!bot.muted && !this.settings.botOptions.muted) this.notify({ sessionId, kind, title: bot.name, body: (event.reason === 'done' && chatPreview(session!.messages, 160)) || body })
        } else this.notify({ sessionId, kind, title: session?.meta.title ?? 'Chat', body })
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
    const botId = this.agent!.session.meta.botId
    if (botId) this.unreadBots.delete(botId)
    return this.state()
  }

  // ---------- bot chats ----------

  /** A chat that belongs in the Bots tab (not the Sessions list). Gateway chats stay with the sessions. */
  private inBotsTab(meta: SessionMeta): boolean {
    return !meta.gateway && isBotChat(this.settings, meta)
  }

  /** Bot chats: the saved ones plus fresh ones not saved yet (a new conversation before its first message). */
  private botMetas(): SessionMeta[] {
    const saved = this.sessionMetas().filter((m) => m.botId && !m.gateway)
    const ids = new Set(saved.map((m) => m.id))
    const fresh = [...this.agents.values()].map((r) => r.agent.session.meta).filter((m) => m.botId && !m.gateway && !ids.has(m.id) && !this.removed.has(m.id))
    return [...saved, ...fresh]
  }

  /** Opens a bot's ongoing chat (its most recent), or starts its first. */
  async openBot(botId: string): Promise<AppState> {
    if (!chatBot(this.settings, botId)) throw new Error('That bot no longer exists.')
    const latest = latestBotThread(this.botMetas(), botId)
    if (latest) return this.openSession(latest.id)
    return this.newBotThread(botId)
  }

  /** A fresh chat with a bot, in its own folder when it has one, else the folder on screen. */
  async newBotThread(botId: string): Promise<AppState> {
    const bot = activeBot(this.settings, botId)
    if (!bot) throw new Error(chatBot(this.settings, botId) ? 'That bot is turned off. Turn it on to start a chat.' : 'That bot no longer exists.')
    const dir = bot.cwd && fs.existsSync(bot.cwd) ? bot.cwd : this.workspace
    if (!dir) throw new Error('Open a folder first: bots work in a folder.')
    this.unreadBots.delete(botId)
    return this.createSession(dir, botId)
  }

  private botRows(): BotRow[] {
    const bots = shownBots(this.settings)
    if (!bots.length) return []
    const metas = this.botMetas()
    const running = new Set([...this.agents.entries()].filter(([, r]) => r.agent.running).map(([id]) => id))
    const awaiting = new Set([...this.pending.values(), ...this.questions.values()].map((p) => p.sessionId))
    return bots.map((b) => {
      const threads = botThreads(metas, b.id)
      return {
        id: b.id,
        threads: threads.map((m) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt, preview: m.preview ?? '' })),
        unread: this.unreadBots.has(b.id),
        running: threads.some((m) => running.has(m.id)),
        awaiting: threads.some((m) => awaiting.has(m.id)),
      }
    })
  }

  /** A new chat in `cwd` (or the current folder), with `botId`'s persona, model and mode when given. */
  async createSession(cwd?: string, botId?: string): Promise<AppState> {
    const dir = cwd ?? this.workspace
    if (!dir) throw new Error('Open a folder first.')
    const bot = botId ? activeBot(this.settings, botId) : undefined
    if (botId && !bot) throw new Error('That bot is turned off. Turn it on in Settings › Bots.')
    const { model } = chatDefaults(this.settings, botId, { model: this.plainModel(), mode: this.mode })
    this.activate(newSession(await this.enterFolder(dir), model, { botId: bot?.id }))
    return this.state()
  }

  /** A new plain chat keeps the model of the chat on screen, unless that one's model came from its bot. */
  private plainModel(): ModelRef {
    const a = this.agent
    return a && !activeBot(this.settings, a.session.meta.botId)?.model ? a.model : this.settings.models.default
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
    const model = this.plainModel()
    this.discard(id)
    this.store.delete(id)
    if (this.activeId === id) {
      this.activeId = null
      if (this.workspace) this.activate(newSession(this.workspace, model))
    }
    return this.state()
  }

  removeAllSessions(): AppState {
    const model = this.plainModel()
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
    if (!config.enabled) throw new Error(`${config.name} is turned off. Turn it on in Settings › Providers › API keys, or pick another model.`)
    if (!this.isReady(providerId)) throw new Error(`${config.name} needs an API key. Add one in Settings › Providers › API keys.`)
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
    this.count('feature.chat_sent', { bot: !!activeBot(this.settings, this.agent!.session.meta.botId) })
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

  /** Mixture of Agents for the chat on screen; new chats follow `moa.enabled`. */
  setMoa(on: boolean): AppState {
    this.agent?.setMoa(!!on)
    return this.state()
  }

  /** Makes a downloaded local model the default for new chats and the chat on screen, and starts loading it. */
  useLocalModel(id: string): AppState {
    if (!this.local.hasModel(id)) throw new Error(`${id} isn't downloaded.`)
    const ref = { providerId: LOCAL_PROVIDER_ID, modelId: id }
    if (!this.settings.providers.some((p) => p.id === LOCAL_PROVIDER_ID)) {
      this.settings = { ...this.settings, providers: upsertLocalProvider(this.settings.providers) }
      this.buildRegistry()
    }
    this.settings = { ...this.settings, models: { ...this.settings.models, default: ref } }
    this.count('feature.local_model')
    // Loading takes a while; chats wait for it through the provider.
    this.local.ensure(id).catch(() => {})
    return this.setModel(ref)
  }

  /**
   * Changes the mode of the chat on screen. In a plain chat it's the mode for every chat whose bot
   * doesn't set one; a bot with its own mode keeps the change to that chat.
   */
  setMode(mode: PermissionMode): AppState {
    const shown = this.activeId ? this.agents.get(this.activeId) : undefined
    if (shown && (this.botMode(shown.agent) || shown.agent.session.meta.gateway)) {
      shown.permissions.setMode(mode)
      return this.state()
    }
    this.mode = mode
    for (const r of this.agents.values()) if (!this.botMode(r.agent) && !r.agent.session.meta.gateway) r.permissions.setMode(mode)
    return this.state()
  }

  private botMode(agent: Agent): PermissionMode | undefined {
    return activeBot(this.settings, agent.session.meta.botId)?.mode
  }

  // ---------- bots ----------

  private get botImageDir(): string {
    return path.join(this.dataDir, 'bots')
  }

  /** Copies a picture into `<data>/bots/` for a bot's avatar; the bot dialog saves the path. */
  importBotAvatar(file: string): { path: string; url: string } {
    const ext = path.extname(file).toLowerCase()
    if (!BOT_IMAGE_TYPES[ext]) throw new Error('Choose a PNG, JPEG, GIF or WebP image.')
    if (fs.statSync(file).size > MAX_AVATAR_BYTES) throw new Error('Choose an image under 1 MB.')
    const dir = this.botImageDir
    fs.mkdirSync(dir, { recursive: true })
    // A new name each time, so the renderer never shows a cached old picture.
    const target = path.join(dir, `avatar-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${ext}`)
    fs.copyFileSync(file, target)
    return { path: target, url: this.avatarUrl(target) }
  }

  /** Deletes pictures no bot uses any more. Only day-old ones, so a picture picked in an open dialog stays. */
  private cleanBotImages() {
    const dir = this.botImageDir
    const used = new Set(this.settings.bots.map((b) => (b.avatar.kind === 'image' ? b.avatar.image : undefined)).filter(Boolean))
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        if (!used.has(file) && BOT_IMAGE_TYPES[path.extname(name).toLowerCase()] && Date.now() - fs.statSync(file).mtimeMs > DAY_MS) fs.rmSync(file, { force: true })
      } catch {
        /* gone already */
      }
    }
  }

  /** A picture as a data URL (the renderer can't read files). Cached by path; '' when unreadable. */
  private avatarUrl(file: string): string {
    let url = this.avatarCache.get(file)
    if (url === undefined) {
      try {
        const type = BOT_IMAGE_TYPES[path.extname(file).toLowerCase()]
        const data = fs.readFileSync(file)
        url = type && data.length <= MAX_AVATAR_BYTES ? `data:${type};base64,${data.toString('base64')}` : ''
      } catch {
        url = ''
      }
      this.avatarCache.set(file, url)
    }
    return url
  }

  /** Picture avatars by bot id. */
  private botAvatars(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const b of this.settings.bots) {
      const url = b.avatar.kind === 'image' && b.avatar.image ? this.avatarUrl(b.avatar.image) : ''
      if (url) out[b.id] = url
    }
    return out
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
      if (this.inBotsTab(meta)) continue
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
      shareInfoOff: !!this.opts.shareInfoOff,
      keys,
      ready,
      keyStorage: this.secrets.storage,
      providerPresets: PROVIDER_PRESETS,
      builtinProviders: BUILTIN_PROVIDERS.map((p) => p.id),
      workspace: this.workspace,
      session: this.sessionView(),
      ...this.sessionLists(),
      usage: this.usage.summary(this.agent?.session.meta.id),
      // The chat on screen may run in its bot's mode.
      mode: (this.activeId && this.agents.get(this.activeId)?.permissions.mode) || this.mode,
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
      browserLogins: fs.existsSync(this.browserProfileDir),
      voice: this.voiceState(),
      mcp: {
        servers: this.mcp.status(),
        tokens: Object.fromEntries(this.settings.mcp.servers.map((s) => [s.id, this.secrets.has(mcpSecretId(s.id))])),
      },
      botAvatars: this.botAvatars(),
      bots: this.botRows(),
      imessage: this.imessage.status(),
      paths: this.paths,
    }
  }

  pushState() {
    this.send({ type: 'state', state: this.state() })
  }
}
