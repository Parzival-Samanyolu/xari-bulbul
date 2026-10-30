// Contract between the Electron main process and the renderer. Type-only imports from core.
import type { Fit, HfResult, LlamaRuntimeStatus, MachineInfo, ServerState } from '@harness/core'
export type { Fit, HfResult, LlamaRuntimeStatus, MachineInfo, ServerState }
import type {
  AgentEvent,
  ChatMessage,
  Checkpoint,
  DirListing,
  FileChange,
  FilePreview,
  IMessageStatus,
  LocalWhisperStatus,
  McpServerStatus,
  MemoryFact,
  MixtureInfo,
  ModelInfo,
  ModelRef,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  QuestionRequest,
  SessionMeta,
  Settings,
  TodoItem,
  ToolDisplay,
  UsageSummary,
} from '@harness/core'

export type {
  IMessageStatus,
  AgentEvent,
  ChatMessage,
  Checkpoint,
  DirListing,
  FileChange,
  FilePreview,
  LocalWhisperStatus,
  McpServerStatus,
  MemoryFact,
  MixtureInfo,
  ModelInfo,
  ModelRef,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  QuestionRequest,
  SessionMeta,
  Settings,
  TodoItem,
  ToolDisplay,
  UsageSummary,
}

/** One spoken chunk from an OpenAI-style provider. */
export interface SpeechAudio {
  audio: Uint8Array
  mediaType: 'audio/mpeg'
  /** Play at this rate (1 when the service already applied `voice.tts.rate`). */
  playbackRate: number
}

export interface SessionView {
  meta: SessionMeta
  messages: ChatMessage[]
  todos: TodoItem[]
  displays: Record<string, ToolDisplay>
  denied: string[]
  /** Turns that changed files and can still be reverted. */
  checkpoints: Checkpoint[]
}

export interface CommandInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
  plugin?: string
}

export interface ToolInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project' | 'mcp'
  readOnly: boolean
  kind: string
  plugin?: string
}

export interface SkillInfo {
  name: string
  description: string
  source: 'user' | 'project' | 'claude'
  dir: string
  plugin?: string
}

/** A plugin from the built-in catalog, with its install state on this computer. */
export interface PluginInfo {
  id: string
  name: string
  description: string
  version: string
  /** The reviewed commit the catalog installs. */
  pin: string
  /** The repository's page. */
  sourceUrl: string
  /** The plugin's files on GitHub at the pin. */
  treeUrl: string
  includes: { tools: string[]; commands: string[]; skills: string[]; mcpServers: string[] }
  /** Where its app was found at launch, or null. */
  detected: string | null
  /** Where it would install for each scope; project is null without an open folder. */
  installPaths: { user: string; project: string | null }
  installed: {
    pin: string
    scope: 'user' | 'project'
    /** The project, for scope project. */
    cwd: string | null
    installedAt: number
    enabled: boolean
    dir: string
  } | null
  /** Being installed right now. */
  busy: boolean
}

export interface ExtensionsInfo {
  tools: ToolInfo[]
  commands: CommandInfo[]
  errors: { file: string; error: string }[]
  userDir: string
  projectDir: string | null
}

export interface MemoryInfo {
  global: string[]
  project: string[]
  globalFile: string
  projectFile: string | null
}

export interface ScheduleStatus {
  id: string
  /** ms since epoch, or null if it hasn't run. */
  lastRun: number | null
  /** null when it's off or missing a folder or prompt. */
  nextRun: number | null
  running: boolean
  /** Why the last run couldn't start. */
  error: string | null
}

/** A local speech model download in progress (whisper.cpp first if needed, then the model). */
export interface VoiceDownload {
  step: 'binary' | 'model'
  /** Model id being fetched. */
  model: string
  received: number
  /** 0 when the server didn't say. */
  total: number
}

export interface VoiceState {
  /** What the mic button uses now (from `voice.engine` and what's set up); null hides it. */
  engine: 'local' | 'provider' | null
  /** `models.transcription` is set and its provider is ready. */
  provider: boolean
  /** whisper.cpp and the downloaded models, plus the model local transcription would use. */
  local: LocalWhisperStatus & { model: string | null }
  download: VoiceDownload | null
}

/** A local model, curated or added (Settings › Providers › Local models). */
export interface LocalModelView {
  id: string
  name: string
  description: string
  source: 'curated' | 'hf' | 'file'
  /** Bytes: weights plus image projector. */
  size: number
  /** Context the model would run with on this machine. */
  ctx: number
  /** Most context offered (the model's limit, capped at 32K). */
  maxCtx: number
  vision: boolean
  fit: Fit
  installed: boolean
  /** Bytes of an unfinished download on disk (resumes from there). */
  partial: number
}

/** A runtime or model download in progress. */
export interface LocalDownload {
  /** 'runtime', a model id, or `hf:<repo>/<file>`. */
  target: string
  label: string
  received: number
  total: number
}

export interface LocalStatus {
  runtime: LlamaRuntimeStatus
  machine: MachineInfo
  models: LocalModelView[]
  server: ServerState
  download: LocalDownload | null
  /** `<data>/llama`. */
  dir: string
}

/** Feature use the renderer reports for share info (main turns these into counters). */
export type TrackEvent =
  | { type: 'settings_page'; page: string }
  | { type: 'onboarding'; outcome: 'finished' | 'skipped'; step: string }

/** An uncaught error in the page; main scrubs it before it's queued. */
export interface RendererError {
  kind: 'error' | 'rejection' | 'crash'
  message: string
  stack?: string
}

export interface AppState {
  version: string
  platform: NodeJS.Platform
  settings: Settings
  /** Share info can't send in this build or session (XB_TELEMETRY=0 or an empty XB_TELEMETRY_URL). */
  shareInfoOff: boolean
  keys: Record<string, boolean>
  /** Enabled and either has a key or doesn't need one. */
  ready: Record<string, boolean>
  keyStorage: 'os' | 'basic'
  providerPresets: { id: string; name: string; baseUrl: string; requiresKey: boolean }[]
  /** Ids of providers that ship with the app and can't be removed. */
  builtinProviders: string[]
  /** Folder of the chat on screen. */
  workspace: string | null
  session: SessionView | null
  /** Chats in `workspace`, newest first. */
  sessions: SessionMeta[]
  /** Every folder open in the sidebar, with its chats. */
  folders: { path: string; sessions: SessionMeta[] }[]
  usage: UsageSummary
  mode: PermissionMode
  /** Whether the chat shown in the window is working. */
  running: boolean
  /** Every chat with a turn in progress, in any folder. */
  runningSessions: string[]
  /** Chats waiting for you to approve a tool or answer a question. */
  awaitingSessions: string[]
  /** Open ask_user questions, in every chat. */
  questions: { sessionId: string; request: QuestionRequest }[]
  extensions: ExtensionsInfo
  /** Skills for the folder on screen: yours, the project's and Claude Code's. */
  skills: SkillInfo[]
  /** The plugin catalog, with what's installed and which apps were found. */
  plugins: PluginInfo[]
  /** Connection state of each configured MCP server, and which have a stored token. */
  mcp: { servers: McpServerStatus[]; tokens: Record<string, boolean> }
  /** Saved memories for the open folder and for every folder. */
  memory: MemoryInfo
  /** Run times of each schedule in settings. */
  schedules: ScheduleStatus[]
  /** The browser the browser tools drive (from tools.browser.path or detection), or null if none was found. */
  browser: string | null
  /** A kept browser profile (saved site logins) exists in the data folder. */
  browserLogins: boolean
  /** How the mic button transcribes; null hides it. */
  voice: VoiceState
  /** Bots with a picture as their avatar: bot id → data URL. */
  botAvatars: Record<string, string>
  /** The iMessage gateway (macOS): listening, missing Full Disk Access, Automation blocked… */
  imessage: IMessageStatus
  paths: { data: string; sessions: string; usage: string }
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'available' | 'downloading' | 'ready'; version?: string; percent?: number }
  | { state: 'error'; message: string }
  /** A new version exists but this build can't install it itself (ad-hoc signed macOS builds). */
  | { state: 'manual'; version: string; url: string }

export type UiEvent =
  | { type: 'agent'; sessionId: string; event: AgentEvent }
  | { type: 'permission'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_cancelled'; sessionId: string; callId: string }
  | { type: 'state'; state: AppState }
  | { type: 'update'; status: UpdateStatus }
  | { type: 'voice_download'; download: VoiceDownload }
  /** Local models: a fresh status (runtime, models, server) and download progress. */
  | { type: 'local'; status: LocalStatus }
  | { type: 'local_download'; download: LocalDownload }
  /** Output of a terminal opened with `term.open`. */
  | { type: 'term_data'; id: string; data: string }
  /** The terminal's shell ended (null: it was killed). */
  | { type: 'term_exit'; id: string; code: number | null }

/** A file on disk (`path`) or a pasted image (`data`, base64). Main reads and validates it. */
export interface AttachmentInput {
  name: string
  path?: string
  mediaType?: string
  data?: string
  size?: number
}

/** An endpoint to try before it's saved (Settings › Providers › Custom endpoints). */
export interface EndpointProbeInput {
  /** The provider id; a saved key for it is used when `key` is blank. */
  id?: string
  name?: string
  baseUrl: string
  api: 'auto' | 'openai' | 'anthropic'
  key?: string
  /** Also send a 5-token request to this model. */
  model?: string
}

export interface EndpointProbe {
  ok: boolean
  message: string
  /** The protocol that answered (what auto-detect picked). */
  api?: 'openai' | 'anthropic'
  models: string[]
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  models?: number
}

export interface HarnessApi {
  getState(): Promise<AppState>
  settings: {
    set(settings: Settings): Promise<AppState>
    /** Defaults for everything; keys, chats and this machine's folders stay. */
    reset(): Promise<AppState>
    /** Saves settings to a file, without keys or folder paths. */
    export(): Promise<boolean>
    /** Validates a file and applies it; rejects with the invalid fields named (nothing changes). Null when cancelled. */
    import(): Promise<AppState | null>
  }
  keys: {
    set(providerId: string, key: string | null): Promise<AppState>
  }
  providers: {
    test(providerId: string): Promise<ProviderTestResult>
    /** Tries an endpoint that isn't saved yet. */
    probe(input: EndpointProbeInput): Promise<EndpointProbe>
  }
  browser: {
    /** Closes running browsers and deletes the kept profile with its site logins. */
    clearLogins(): Promise<AppState>
  }
  models: {
    list(providerId: string, refresh?: boolean): Promise<ModelInfo[]>
  }
  workspace: {
    pick(): Promise<AppState>
    set(path: string): Promise<AppState>
    /** Removes a folder from the sidebar; its chats stay on disk. */
    close(path: string): Promise<AppState>
    /** Sets the sidebar order of open folders. */
    reorder(paths: string[]): Promise<AppState>
  }
  sessions: {
    open(id: string): Promise<AppState>
    /** New chat in `cwd`, or in the current folder; with `botId`, a chat with that bot (it must be turned on). */
    create(cwd?: string, botId?: string): Promise<AppState>
    remove(id: string): Promise<AppState>
    removeAll(): Promise<AppState>
  }
  agent: {
    send(text: string, attachments?: AttachmentInput[]): Promise<void>
    stop(): Promise<void>
    setModel(ref: ModelRef): Promise<AppState>
    setMode(mode: PermissionMode): Promise<AppState>
    /** Mixture of Agents on or off for the chat on screen. */
    setMoa(on: boolean): Promise<AppState>
    compact(): Promise<boolean>
    respond(sessionId: string, callId: string, answer: PermissionAnswer): Promise<void>
    /** Answers an ask_user question ('' dismisses it). */
    answer(sessionId: string, callId: string, text: string): Promise<AppState>
    /** Runs the failed request of the chat on screen again. */
    retry(): Promise<void>
    /** Restores the files a turn changed (or just `file`), in the chat on screen. */
    revert(at: number, file?: string): Promise<AppState>
    /** Replaces an earlier message of the chat on screen and runs from there. */
    editMessage(index: number, text: string, revert: boolean): Promise<void>
  }
  fs: {
    /** One directory of an open folder (folders first; ignored and noisy entries skipped). Refuses paths outside open folders. */
    tree(dir: string): Promise<DirListing>
    /** The start of a file in an open folder, for a read-only preview. */
    read(path: string): Promise<FilePreview>
  }
  session: {
    /** Files the chat changed, diffed against what's on disk now. */
    diff(id: string): Promise<FileChange[]>
  }
  term: {
    /** Starts a shell in `cwd` (an open folder); returns the terminal's id. */
    open(cwd: string, cols: number, rows: number): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
  }
  files: {
    /** Native file picker for attachments. */
    pick(): Promise<AttachmentInput[]>
    /** Absolute path of a dropped File (Electron removed File.path). Empty if it has none. */
    pathFor(file: File): string
  }
  usage: {
    exportCsv(): Promise<boolean>
    clear(): Promise<AppState>
  }
  mcp: {
    restart(id: string): Promise<AppState>
    setToken(id: string, token: string | null): Promise<AppState>
  }
  plugins: {
    list(): Promise<PluginInfo[]>
    /** Downloads the reviewed files, checks each one's sha256 and turns the plugin on. Also updates to a new pin. */
    install(id: string, scope: 'user' | 'project'): Promise<AppState>
    /** Deletes the plugin's folder and its MCP servers. */
    remove(id: string): Promise<AppState>
    setEnabled(id: string, on: boolean): Promise<AppState>
  }
  memory: {
    remove(scope: 'project' | 'global', fact: string): Promise<AppState>
    clear(scope: 'project' | 'global'): Promise<AppState>
    /** Reverts what the memory review did after a turn in `sessionId`'s folder. */
    undo(sessionId: string, added: MemoryFact[], removed: MemoryFact[]): Promise<AppState>
  }
  extensions: {
    reload(): Promise<AppState>
    openDir(which: 'user' | 'project'): Promise<void>
  }
  skills: {
    /** Deletes the skill's folder. */
    remove(dir: string): Promise<AppState>
  }
  schedules: {
    /** Starts the schedule in a new chat now, unless its last run is still going. */
    runNow(id: string): Promise<AppState>
    /** Folder picker that only returns the path (doesn't open the folder). */
    pickFolder(): Promise<string | null>
  }
  imessage: {
    /** Texts "Xarı Bülbül is connected." to the first allowed sender. Throws with the reason when it can't. */
    test(): Promise<AppState>
    /** Reads chat.db again now (after granting Full Disk Access). */
    check(): Promise<AppState>
    /** Opens System Settings at Full Disk Access or Automation. */
    openPrivacy(pane: 'disk' | 'automation'): Promise<void>
    /** Folder picker that only returns the path. */
    pickFolder(): Promise<string | null>
  }
  bots: {
    /** Picks an image and makes it the bot's avatar (copied into the data folder). Null when cancelled. */
    pickAvatar(botId: string): Promise<AppState | null>
  }
  voice: {
    /** Asks the OS for microphone access (macOS); true when recording may start. */
    prepare(): Promise<boolean>
    /** Turns a recording into text: WAV for the local engine, the recorder's format for a provider. */
    transcribe(audio: Uint8Array, mediaType: string): Promise<string>
    /** Downloads whisper.cpp (where a build is published and none is installed) and the `voice.localModel` model. Progress arrives as `voice_download` events. */
    download(): Promise<AppState>
    cancelDownload(): Promise<AppState>
    /** Deletes a downloaded model, or the downloaded whisper.cpp ('binary'). */
    remove(what: string): Promise<AppState>
  }
  tts: {
    /** One chunk of text → MP3 through the `voice.tts.openai` provider (the system voice plays in the page). */
    synthesize(text: string): Promise<SpeechAudio>
  }
  local: {
    status(): Promise<LocalStatus>
    /** Downloads the pinned llama.cpp build. Progress arrives as `local_download` events. */
    installRuntime(): Promise<LocalStatus>
    removeRuntime(): Promise<LocalStatus>
    /** Downloads a curated model (resuming a partial one). */
    download(id: string): Promise<LocalStatus>
    /** Downloads a Hugging Face search result's picked quant. */
    downloadHf(result: HfResult): Promise<LocalStatus>
    cancelDownload(): Promise<LocalStatus>
    /** Deletes a model's downloaded files; an added file is only forgotten. */
    remove(id: string): Promise<LocalStatus>
    /** GGUF repos on Hugging Face, each with a quant sized to this machine. */
    search(query: string): Promise<HfResult[]>
    /** Picks a .gguf file and adds it; null when cancelled. */
    addFile(): Promise<LocalStatus | null>
    /** Makes the model the default for new chats and the chat on screen, and starts loading it. */
    use(id: string): Promise<AppState>
    /** Stops the running llama-server. */
    stop(): Promise<LocalStatus>
  }
  app: {
    /** Counts a feature use for share info; nothing is sent while it's off. */
    track(e: TrackEvent): Promise<void>
    /** Reports an uncaught error in the page for share info. */
    reportError(e: RendererError): Promise<void>
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<void>
    checkForUpdates(): Promise<void>
    installUpdate(): Promise<void>
  }
  onEvent(cb: (e: UiEvent) => void): () => void
}

export const IPC_EVENT = 'harness:event'
