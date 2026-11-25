import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  Agent,
  ChatGptAuth,
  CHATGPT_PROVIDER_ID,
  KeyStore,
  MemoryStore,
  McpManager,
  Permissions,
  ProviderRegistry,
  SessionStore,
  UsageTracker,
  USER_EXT_DIR,
  accountKeyId,
  accountOrder,
  activePlugins,
  assembleTools,
  detectSecretBackend,
  expandSlashCommand,
  loadExtensions,
  loadSettingsFile,
  newSession,
  readInstalled,
  resolveDataDir,
  skillCommands,
  type AgentEvent,
  type AgentOptions,
  type LoadedExtensions,
  type ModelInfo,
  type ModelRef,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type SessionMeta,
  type Settings,
  type SlashCommand,
  type Tool,
  type UsageTracker as Usage,
} from '@harness/core'
import { cliLanguage, tFor, type Lang, type MessageKey, type T } from './i18n/index.js'

/** Commands the interface handles itself, same list as the desktop app (descriptions in English; slashCommands() translates them). */
export const BUILTIN_COMMANDS: SlashInfo[] = [
  { name: 'compact', description: 'Summarize older messages to free up context', source: 'builtin' },
  { name: 'clear', description: 'Start a new chat', source: 'builtin' },
  { name: 'model', description: 'Open the model switcher', source: 'builtin' },
  { name: 'mode', description: 'Cycle the permission mode', source: 'builtin' },
]

export interface SlashInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
  /** Set for a command that runs a skill. */
  skill?: string
}

export interface HostOptions {
  /** The folder to work in. Default: the process's. */
  cwd?: string
  /** Defaults to `process.env`; tests pass their own (HARNESS_DATA_DIR, API keys). */
  env?: NodeJS.ProcessEnv
  version?: string
  /** `--mode`: overrides the permission mode from settings. */
  mode?: PermissionMode
  /** `--max-steps`: overrides `agent.maxStepsPerTurn`. */
  maxSteps?: number
  /** Skip connecting MCP servers (tests). */
  noMcp?: boolean
}

export interface AgentHooks {
  askPermission: (req: PermissionRequest) => Promise<PermissionAnswer>
  askUser?: (req: QuestionRequest) => Promise<string>
  onEvent: (e: AgentEvent) => void
  /** Defaults to the host's mode. */
  mode?: PermissionMode
}

export interface Host {
  readonly settings: Settings
  readonly dataDir: string
  readonly cwd: string
  readonly usage: Usage
  /** Where API keys come from: the OS keychain, or a plain file when there is none. */
  readonly secretStorage: 'keychain' | 'libsecret' | 'file'
  /** The interface language: the desktop's `appearance.language`, else XARI_LANG, else the system locale. */
  readonly lang: Lang
  /** Messages in `lang`. */
  readonly t: T
  /** A new, unsaved chat in the host's folder (saved after its first message). */
  newSession(model?: ModelRef): Session
  /** A saved chat by id; also loads the extensions of its folder. */
  loadSession(id: string): Promise<Session | null>
  /** The most recent chat in `cwd` (default: the host's), for `--continue`. */
  latestSession(cwd?: string): Promise<Session | null>
  /** Saved chats in `cwd` (default: the host's; '' = every folder), newest first. */
  listSessions(cwd?: string): SessionMeta[]
  /** The agent for a chat, wired like the desktop's: tools incl. MCP and extensions, memory, skills, session search. */
  createAgent(session: Session, hooks: AgentHooks): Agent
  /** Everything runHeadless needs to build its own Agent. */
  agentOptions(session: Session, mode?: PermissionMode): Omit<AgentOptions, 'askPermission' | 'onEvent'>
  /** Changes the permission mode of an agent made by createAgent. */
  setMode(agent: Agent, mode: PermissionMode): void
  modeOf(agent: Agent): PermissionMode
  /** Models of every ready provider (cached). A provider that fails to list is skipped. */
  models(providerId?: string): Promise<ModelInfo[]>
  /** `provider/model`, `provider:model` or a bare model id (favorites and recents first, then the default provider). */
  resolveModel(text: string): ModelRef
  /** The model a new chat starts with (settings default). */
  defaultModel(): ModelRef
  /** Built-in commands, then the folder's commands and one per skill. */
  slashCommands(): SlashInfo[]
  /** `/review x` → the command's prompt; text that isn't a custom command comes back unchanged. */
  expandPrompt(text: string, cwd?: string): string
  /** One line to show when the provider has no key the CLI can read, else undefined. */
  keyHint(providerId: string): string | undefined
  /** Waits (at most `ms`) for the configured MCP servers to finish connecting. */
  waitForMcp(ms: number): Promise<void>
  /** Problems found loading extensions, for the UI to show. */
  extensionErrors(): { file: string; error: string }[]
  dispose(): Promise<void>
}

const EMPTY: LoadedExtensions = { tools: [], commands: [], skills: [], errors: [] }

/** Whether the desktop app seems to be running; it owns the ChatGPT refresh token then. */
function desktopRunning(): boolean {
  if (process.platform === 'win32') return false
  try {
    return execFileSync('pgrep', ['-f', 'Xari Bulbul'], { stdio: 'pipe' }).toString().trim() !== ''
  } catch {
    return false
  }
}

export async function createHost(opts: HostOptions = {}): Promise<Host> {
  const env = opts.env ?? process.env
  const dataDir = resolveDataDir(env)
  const cwd = path.resolve(opts.cwd ?? process.cwd()).normalize('NFC')
  const loaded = loadSettingsFile(dataDir)
  // --max-steps and --mode apply to this run only; nothing is written back to settings.json.
  const settings: Settings = {
    ...loaded,
    agent: { ...loaded.agent, ...(opts.maxSteps ? { maxStepsPerTurn: opts.maxSteps } : {}) },
  }
  const defaultMode = opts.mode ?? settings.permissions.mode
  const lang = cliLanguage(settings.appearance.language, env)
  const t = tFor(lang)

  const keys = new KeyStore(detectSecretBackend(dataDir), env)
  // "Continue with ChatGPT": works when the desktop stored its sign-in in the keychain. While the
  // desktop is open the CLI only borrows the access token, since refresh tokens rotate.
  const chatgpt = new ChatGptAuth({
    dataDir,
    secrets: { get: (id) => keys.get(id), set: (id, v) => keys.set(id, v) },
    appName: 'Xari Bulbul',
    readOnly: desktopRunning(),
  })
  const registry = new ProviderRegistry(settings.providers, (id) => keys.get(id), {
    retries: settings.agent.requestRetries,
    fillContext: true,
    tokenFor: (id) => (id === CHATGPT_PROVIDER_ID && chatgpt.status().signedIn ? () => chatgpt.accessToken() : undefined),
  })
  const usage = new UsageTracker(path.join(dataDir, 'usage.jsonl'))
  const store = new SessionStore(path.join(dataDir, 'sessions'))
  const memory = new MemoryStore(path.join(dataDir, 'memory'), settings.memory.maxChars)
  const plugins = readInstalled(dataDir)

  // Extensions per folder: yours, the project's (code only if enabled in settings) and active plugins.
  const extensions = new Map<string, LoadedExtensions>()
  const loadFor = async (dir: string): Promise<LoadedExtensions> => {
    const key = dir.normalize('NFC')
    let ext = extensions.get(key)
    if (!ext) {
      ext = await loadExtensions(key, {
        user: settings.tools.loadUserExtensions,
        project: settings.tools.loadProjectExtensions,
        plugins: activePlugins(plugins, key, USER_EXT_DIR),
      }).catch((e) => ({ ...EMPTY, errors: [{ file: key, error: (e as Error).message }] }))
      extensions.set(key, ext)
    }
    return ext
  }
  const extOf = (dir: string) => extensions.get(dir.normalize('NFC')) ?? EMPTY

  const live = new Map<Agent, Permissions>()

  // MCP servers connect in the background; agents pick their tools up as they arrive.
  const mcp = new McpManager({
    clientVersion: opts.version ?? 'cli',
    secret: (id) => keys.get(`mcp:${id}`),
    onChange: () => {
      for (const [agent] of live) agent.updateSettings(settings, toolsFor(agent.session.meta.cwd))
    },
  })
  const toolsFor = (dir: string) => assembleTools(extOf(dir).tools, mcp.tools()).tools
  let mcpSync: Promise<void> = Promise.resolve()
  if (!opts.noMcp && settings.mcp.servers.length) mcpSync = mcp.sync(settings.mcp.servers).catch(() => {})

  const commandsOf = (dir: string): SlashCommand[] => {
    const ext = extOf(dir)
    const off = new Set(settings.tools.disabledSkills)
    const taken = [...BUILTIN_COMMANDS.map((c) => c.name), ...ext.commands.map((c) => c.name)]
    return [...ext.commands, ...skillCommands(ext.skills.filter((s) => !off.has(s.name)), taken)]
  }

  const missingKey = (providerId: string): boolean => {
    const config = settings.providers.find((p) => p.id === providerId)
    if (!config || !config.enabled || config.auth !== 'key' || !config.requiresKey) return false
    return !accountOrder(config).some((a) => keys.has(accountKeyId(config.id, a.id)))
  }

  const host: Host = {
    settings,
    dataDir,
    cwd,
    usage,
    secretStorage: keys.storage,
    lang,
    t,

    newSession(model) {
      return newSession(cwd, model ?? host.defaultModel())
    },
    async loadSession(id) {
      const s = store.load(id)
      if (s) await loadFor(s.meta.cwd)
      return s
    },
    async latestSession(dir = cwd) {
      const meta = store.list({ cwd: dir })[0]
      return meta ? host.loadSession(meta.id) : null
    },
    listSessions: (dir = cwd) => store.list({ cwd: dir }),

    agentOptions(session, mode = defaultMode) {
      const dir = session.meta.cwd
      return {
        session,
        registry,
        tools: toolsFor(dir),
        settings,
        usage,
        permissions: new Permissions({ ...settings.permissions, mode }, dir),
        memory,
        skills: extOf(dir).skills,
        sessions: { list: (o) => store.list(o?.cwd ? { cwd: o.cwd } : undefined), load: (id) => store.load(id) },
        secret: (id) => keys.get(id),
        onSave: (s) => {
          if (s.messages.length) store.save(s)
        },
      }
    },
    createAgent(session, hooks) {
      const o = host.agentOptions(session, hooks.mode)
      const agent = new Agent({ ...o, askPermission: hooks.askPermission, askUser: hooks.askUser, onEvent: hooks.onEvent })
      live.set(agent, o.permissions)
      return agent
    },
    setMode(agent, mode) {
      live.get(agent)?.setMode(mode)
    },
    modeOf: (agent) => live.get(agent)?.mode ?? defaultMode,

    async models(providerId) {
      const ids = providerId ? [providerId] : registry.list().map((p) => p.id)
      const lists = await Promise.all(ids.map((id) => registry.models(id).catch(() => [] as ModelInfo[])))
      return lists.flat()
    },
    defaultModel: () => settings.models.default,
    resolveModel(text) {
      const t = text.trim()
      const ids = settings.providers.map((p) => p.id).sort((a, b) => b.length - a.length)
      // A provider id followed by `/` or `:`; model ids may contain both (openai/gpt-oss-120b, qwen3:8b).
      for (const id of ids) {
        if ((t.startsWith(id + '/') || t.startsWith(id + ':')) && t.length > id.length + 1) return { providerId: id, modelId: t.slice(id.length + 1) }
      }
      const known = [settings.models.default, ...settings.models.favorites, ...settings.models.recent].find((m) => m.modelId === t)
      return known ?? { providerId: settings.models.default.providerId, modelId: t }
    },

    slashCommands() {
      const custom = commandsOf(cwd).map((c) => ({ name: c.name, description: c.description, source: c.source, skill: c.skill }))
      return [...BUILTIN_COMMANDS.map((c) => ({ ...c, description: t(`slash.${c.name}` as MessageKey) })), ...custom]
    },
    expandPrompt: (text, dir = cwd) => expandSlashCommand(text, commandsOf(dir)) ?? text,

    keyHint(providerId) {
      if (!missingKey(providerId)) return undefined
      const name = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'
      // The desktop keeps keys in Electron safeStorage when there is no keychain; only the desktop can decrypt that.
      const desktopFile = fs.existsSync(path.join(dataDir, 'secrets.json'))
      const why = keys.storage === 'file' && desktopFile ? t('key.desktopEncrypted') : t('key.notFound', { provider: providerId })
      return `${why} ${t(process.platform === 'linux' ? 'key.setEnvLinux' : 'key.setEnv', { name })}`
    },

    async waitForMcp(ms) {
      await Promise.race([mcpSync, new Promise<void>((r) => setTimeout(r, ms).unref())])
    },
    extensionErrors: () => extOf(cwd).errors,

    async dispose() {
      for (const [agent] of live) agent.dispose()
      live.clear()
      await mcp.close().catch(() => {})
    },
  }
  // Extensions of the host's folder, loaded before the first chat is made.
  await loadFor(cwd)
  return host
}
