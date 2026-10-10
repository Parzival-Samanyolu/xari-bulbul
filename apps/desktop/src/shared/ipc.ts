// Contract between the Electron main process and the renderer. Type-only imports from core.
import type {
  AgentEvent,
  ChatMessage,
  McpServerStatus,
  ModelInfo,
  ModelRef,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  SessionMeta,
  Settings,
  TodoItem,
  ToolDisplay,
  UsageSummary,
} from '@harness/core'

export type {
  AgentEvent,
  ChatMessage,
  McpServerStatus,
  ModelInfo,
  ModelRef,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  SessionMeta,
  Settings,
  TodoItem,
  ToolDisplay,
  UsageSummary,
}

export interface SessionView {
  meta: SessionMeta
  messages: ChatMessage[]
  todos: TodoItem[]
  displays: Record<string, ToolDisplay>
  denied: string[]
}

export interface CommandInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
}

export interface ToolInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project' | 'mcp'
  readOnly: boolean
  kind: string
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

export interface AppState {
  version: string
  platform: NodeJS.Platform
  settings: Settings
  keys: Record<string, boolean>
  /** Enabled and either has a key or doesn't need one. */
  ready: Record<string, boolean>
  keyStorage: 'os' | 'basic'
  providerPresets: { id: string; name: string; baseUrl: string; requiresKey: boolean }[]
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
  /** Chats waiting for you to approve a tool. */
  awaitingSessions: string[]
  extensions: ExtensionsInfo
  /** Connection state of each configured MCP server, and which have a stored token. */
  mcp: { servers: McpServerStatus[]; tokens: Record<string, boolean> }
  /** Saved memories for the open folder and for every folder. */
  memory: MemoryInfo
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

/** A file on disk (`path`) or a pasted image (`data`, base64). Main reads and validates it. */
export interface AttachmentInput {
  name: string
  path?: string
  mediaType?: string
  data?: string
  size?: number
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
    reset(): Promise<AppState>
    export(): Promise<boolean>
    import(): Promise<AppState | null>
  }
  keys: {
    set(providerId: string, key: string | null): Promise<AppState>
  }
  providers: {
    test(providerId: string): Promise<ProviderTestResult>
  }
  models: {
    list(providerId: string, refresh?: boolean): Promise<ModelInfo[]>
  }
  workspace: {
    pick(): Promise<AppState>
    set(path: string): Promise<AppState>
    /** Removes a folder from the sidebar; its chats stay on disk. */
    close(path: string): Promise<AppState>
  }
  sessions: {
    open(id: string): Promise<AppState>
    /** New chat in `cwd`, or in the current folder. */
    create(cwd?: string): Promise<AppState>
    remove(id: string): Promise<AppState>
    removeAll(): Promise<AppState>
  }
  agent: {
    send(text: string, attachments?: AttachmentInput[]): Promise<void>
    stop(): Promise<void>
    setModel(ref: ModelRef): Promise<AppState>
    setMode(mode: PermissionMode): Promise<AppState>
    compact(): Promise<boolean>
    respond(sessionId: string, callId: string, answer: PermissionAnswer): Promise<void>
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
  memory: {
    remove(scope: 'project' | 'global', fact: string): Promise<AppState>
    clear(scope: 'project' | 'global'): Promise<AppState>
  }
  extensions: {
    reload(): Promise<AppState>
    openDir(which: 'user' | 'project'): Promise<void>
  }
  app: {
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<void>
    checkForUpdates(): Promise<void>
    installUpdate(): Promise<void>
  }
  onEvent(cb: (e: UiEvent) => void): () => void
}

export const IPC_EVENT = 'harness:event'
