import fs from 'node:fs'
import path from 'node:path'
import { compactionSplit, estimateTokens, summarize } from '../context/compact.js'
import { buildSystemPrompt, gatherEnvironment, type PromptEnvironment } from '../context/system-prompt.js'
import { Reminders } from './reminders.js'
import { runHooks, type HookOutcome } from './hooks.js'
import { applyReview, reviewExchange, type MemoryFact } from '../memory/review.js'
import type { MemoryStore } from '../memory/store.js'
import type { Permissions, PermissionAnswer } from '../permissions/permissions.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { isContextOverflow } from '../providers/http.js'
import { ProviderError, type ChatRequest, type Provider } from '../providers/types.js'
import { failoverKind, failureLabel, fallbackChain, ProviderUnavailableError, shortModelName } from './fallback.js'
import { moaOn } from '../moa/config.js'
import { aggregatorMessages, collectText, mixtureTranscript, proposerMessages, runProposers } from '../moa/mixture.js'
import { newSession, titleFrom, type Checkpoint, type Session } from '../sessions/store.js'
import { generateTitle } from '../sessions/title.js'
import { modelKey, type Bot, type Settings } from '../settings/schema.js'
import { activeBot, filterBotSkills, filterBotTools } from '../bots/bots.js'
import { FORGET_TOOL, REMEMBER_TOOL } from '../tools/memory.js'
import { SAVE_SKILL_TOOL, SKILL_TOOL } from '../tools/skills.js'
import { SESSION_SEARCH_TOOL } from '../tools/session-search.js'
import { USER_EXT_DIR, projectExtDir, type Skill } from '../extensions/loader.js'
import { JobRegistry } from '../tools/jobs.js'
import { BROWSER_READ_TOOL, BROWSER_TOOL, BrowserHost, findBrowser, type BrowserAccess } from '../tools/browser.js'
import { SEARCH_KEY_ID, type WebSearchConfig } from '../tools/web-search.js'
import { TASK_TOOL } from '../tools/task.js'
import { ASK_USER_TOOL } from '../tools/ask-user.js'
import type { SessionAccess, SubagentInput, Tool, ToolContext, ToolResult, UserQuestion } from '../tools/types.js'
import type { ChatMessage, FileAttachment, ImageAttachment, ModelRef, TodoItem, ToolCall, Usage } from '../types.js'
import { checkBudget, computeCost, type UsageRecord, type UsageSummary, type UsageTracker } from '../usage/tracker.js'

export type TurnEndReason = 'done' | 'aborted' | 'max_steps' | 'error' | 'budget'

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /** The current reply is being retried; discard any partial streamed text. */
  | { type: 'stream_reset' }
  /** A message was appended to history. */
  | { type: 'message'; message: ChatMessage; index: number }
  | { type: 'tool_start'; callId: string; name: string; subject: string; input: unknown }
  | { type: 'tool_progress'; callId: string; text: string }
  | { type: 'tool_end'; callId: string; name: string; result: ToolResult; durationMs: number; denied?: boolean }
  | { type: 'usage'; record: UsageRecord; summary: UsageSummary; contextTokens: number; contextLength: number }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'compacted'; removedMessages: number }
  /** The title model renamed the chat. */
  | { type: 'title'; title: string }
  /** The memory review saved or removed facts after the turn. */
  | { type: 'memory'; added: MemoryFact[]; removed: MemoryFact[] }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  /** The model failed after its retries and the same step ran on a fallback model. `text` is the notice to show. */
  | { type: 'fallback'; from: ModelRef; to: ModelRef; reason: string; text: string }
  /** Mixture of Agents is writing the final reply: the proposers are answering, or the aggregator is combining. */
  | { type: 'mixing'; phase: 'proposing' | 'combining'; models: ModelRef[] }
  | { type: 'error'; message: string }
  | { type: 'turn_end'; reason: TurnEndReason }

export interface PermissionRequest {
  callId: string
  tool: string
  kind: Tool['kind']
  subject: string
  input: unknown
  reason: string
  suggestedRule: string
}

export interface QuestionRequest extends UserQuestion {
  callId: string
}

/** A final answer held back so Mixture of Agents can use it as a draft. */
interface Draft {
  ref: ModelRef
  content: string
  reasoning: string
  extra?: Record<string, unknown>
}

/** Files larger than this aren't kept for undo. */
const MAX_CHECKPOINT_BYTES = 2_000_000

export interface AgentOptions {
  session: Session
  registry: ProviderRegistry
  tools: Tool[]
  settings: Settings
  usage: UsageTracker
  permissions: Permissions
  askPermission: (req: PermissionRequest) => Promise<PermissionAnswer>
  /** Shows an ask_user question and resolves with the answer ('' if dismissed). Without it the tool is hidden. */
  askUser?: (req: QuestionRequest) => Promise<string>
  onEvent: (e: AgentEvent) => void
  /** Called whenever the session changes and should be persisted. */
  onSave?: (session: Session) => void
  /** Where saved facts live; memory is off without it. */
  memory?: MemoryStore
  /** Skills (SKILL.md folders) the agent can load; the skill tools are hidden without it. */
  skills?: Skill[]
  /** Where save_skill writes user skills; `~/.harness/skills` by default. */
  userSkillsDir?: string
  /** Saved chats session_search reads (a SessionStore); the tool is hidden without it. */
  sessions?: Omit<SessionAccess, 'exclude'>
  /** Set for subagents: what they were asked to do, and whose usage/budget they count against. */
  subagent?: { description: string; parentSessionId: string }
  /** Background shell jobs; subagents share their parent's. */
  jobs?: JobRegistry
  /** Looks up stored secrets (web search keys). */
  secret?: (id: string) => string | undefined
  /** Browser profile kept between chats when `tools.browser.keepLogins` is on. Without it every browser gets a throwaway profile. */
  browserProfileDir?: string
}

/** A tiny counting semaphore: `await acquire()` returns the release function. */
function semaphore(n: number): () => Promise<() => void> {
  let free = n
  const waiting: (() => void)[] = []
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else free++
  }
  return () =>
    new Promise((resolve) => {
      if (free > 0) {
        free--
        resolve(release)
      } else waiting.push(() => resolve(release))
    })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

export class Agent {
  readonly session: Session
  private settings: Settings
  private tools: Tool[]
  private abort: AbortController | null = null
  private readFiles = new Set<string>()
  private registry: ProviderRegistry
  /** Tool calls that failed (not denied, not retried successfully) this turn, for the end-of-turn review. */
  private failedCalls: string[] = []
  readonly jobs: JobRegistry
  private env: PromptEnvironment | undefined
  private readonly reminders = new Reminders()
  /** Index of the user message that started the running turn (where its checkpoint attaches). */
  private turnAt = -1
  private warnedNoTools = false
  private saveFailed = false
  private skills: Skill[] | undefined
  /** Launched on the first browser call, closed on stop/dispose. */
  private browser: BrowserHost | null = null
  /** Models that failed this turn in a way retrying won't fix (not found, no key); left out until the next turn. */
  private skipped = new Set<string>()

  constructor(private readonly o: AgentOptions) {
    this.session = o.session
    this.skills = o.skills
    this.jobs = o.jobs ?? new JobRegistry()
    this.settings = o.settings
    this.tools = o.tools
    this.registry = o.registry
  }

  /** Swap providers (e.g. after API keys change) without losing session state. */
  setRegistry(registry: ProviderRegistry): void {
    this.registry = registry
  }

  get running(): boolean {
    return this.abort !== null
  }

  get model(): ModelRef {
    return this.session.meta.model
  }

  setModel(ref: ModelRef): void {
    this.session.meta.model = ref
    this.save()
  }

  /** Whether this chat's final answers are mixed from several models (and that's configured). */
  get mixing(): boolean {
    return !this.o.subagent && moaOn(this.settings, this.session.meta)
  }

  /** Turns Mixture of Agents on or off for this chat (the composer toggle). */
  setMoa(on: boolean): void {
    this.session.meta.moa = on
    this.save()
  }

  /** Every tool this agent can offer (before mode and settings filters). */
  get availableTools(): Tool[] {
    return this.tools
  }

  updateSettings(settings: Settings, tools?: Tool[]): void {
    const b = settings.tools.browser
    // A different browser or window mode takes effect on the next browser call.
    if (this.browser && (!b.enabled || b.path !== this.browser.options.path || b.headless !== this.browser.options.headless || this.profileDir(b) !== this.browser.options.profileDir)) this.closeBrowser()
    this.settings = settings
    if (tools) this.tools = tools
    this.o.permissions.update({ ...settings.permissions, mode: this.o.permissions.mode })
  }

  /** Replaces the skill list after the folder's extensions reload. */
  setSkills(skills: Skill[]): void {
    if (this.skills) this.skills = skills
  }

  stop(): void {
    this.abort?.abort(new Error('Interrupted by user'))
    this.closeBrowser()
  }

  private closeBrowser() {
    this.browser?.close()
    this.browser = null
  }

  /** Stops the running turn and any background jobs. Call when the chat is closed. */
  dispose(): void {
    this.stop()
    if (!this.o.jobs) this.jobs.dispose()
  }

  private emit(e: AgentEvent) {
    this.o.onEvent(e)
  }

  /** Persists the session. A failed write (full disk, permissions) warns once instead of ending the turn. */
  private save() {
    try {
      this.o.onSave?.(this.session)
      this.saveFailed = false
    } catch (err) {
      if (this.saveFailed) return
      this.saveFailed = true
      this.emit({ type: 'notice', level: 'warn', text: `Couldn't save this chat: ${(err as Error).message}` })
    }
  }

  private push(message: ChatMessage) {
    this.session.messages.push(message)
    this.save() // persist first so listeners that re-read sessions see it
    this.emit({ type: 'message', message, index: this.session.messages.length - 1 })
  }

  private activeTools(): Tool[] {
    const disabled = new Set(this.settings.tools.disabled)
    const plan = this.o.permissions.mode === 'plan'
    // Subagents never get the task tool, so delegation is one level deep.
    if (!this.settings.agent.subagents.enabled || this.o.subagent) disabled.add(TASK_TOOL)
    // Subagents read memory but only the main agent saves to it.
    if (!this.memoryOn || this.o.subagent) disabled.add(REMEMBER_TOOL).add(FORGET_TOOL)
    // Same for skills: subagents load them, only the main agent saves new ones.
    if (!this.skills) disabled.add(SKILL_TOOL)
    if (!this.skills || this.o.subagent) disabled.add(SAVE_SKILL_TOOL)
    if (!this.o.sessions) disabled.add(SESSION_SEARCH_TOOL)
    if (!this.browserOn) disabled.add(BROWSER_TOOL).add(BROWSER_READ_TOOL)
    // Questions need someone to answer them.
    if (!this.o.askUser || this.o.subagent) disabled.add(ASK_USER_TOOL)
    return filterBotTools(this.tools, this.bot).filter((t) => !disabled.has(t.name) && (!plan || t.readOnly))
  }

  /** The chat's bot while bots are on and it's turned on; subagents never take on the persona. */
  get bot(): Bot | undefined {
    return this.o.subagent ? undefined : activeBot(this.settings, this.session.meta.botId)
  }

  /** The skills this chat may load: the bot's list, if it has one. */
  private get allowedSkills(): Skill[] | undefined {
    return this.skills && filterBotSkills(this.skills, this.bot)
  }

  /** The memory tools and prompt see: the folder's, plus the bot's own when it keeps one. */
  private memoryAccess() {
    const bot = this.bot
    return this.o.memory!.scoped(this.session.meta.cwd, bot?.memory === 'own' ? bot.id : undefined)
  }

  private get browserOn(): boolean {
    const b = this.settings.tools.browser
    return b.enabled && !!findBrowser(b.path)
  }

  private profileDir(b: Settings['tools']['browser']): string | undefined {
    return b.keepLogins ? this.o.browserProfileDir : undefined
  }

  /** Closes this chat's browser, e.g. before its saved profile is deleted. */
  closeBrowserNow(): void {
    this.closeBrowser()
  }

  private browserAccess(): BrowserAccess | undefined {
    if (!this.browserOn) return undefined
    const b = this.settings.tools.browser
    const host = () => (this.browser ??= new BrowserHost({ path: b.path, headless: b.headless, profileDir: this.profileDir(b) }))
    return {
      page: (signal) => host().getPage(signal),
      running: !!this.browser?.running,
      vision: this.registry.cachedModel(this.model.providerId, this.model.modelId)?.supportsImages !== false,
    }
  }

  private get memoryOn(): boolean {
    return !!this.o.memory && this.settings.memory.enabled && this.bot?.memory !== 'off'
  }

  private modelInfoTried = new Set<string>()

  /**
   * The context window and price come from the model list; fetch it once if nothing has yet. Also
   * for the fallbacks (to compare context sizes) and the mixture models (for their cost).
   */
  private async loadModelInfo(): Promise<void> {
    const refs = [this.model, ...this.settings.models.fallbacks]
    if (this.mixing) refs.push(...this.settings.moa.proposers, this.settings.moa.aggregator!)
    const providers = new Set<string>()
    for (const ref of refs) {
      const key = modelKey(ref)
      if (this.modelInfoTried.has(key) || !this.registry.has(ref.providerId) || this.registry.cachedModel(ref.providerId, ref.modelId)) continue
      this.modelInfoTried.add(key)
      providers.add(ref.providerId)
    }
    if (!providers.size) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, 5000)))
    await Promise.race([Promise.all([...providers].map((id) => this.registry.models(id).catch(() => undefined))), timeout])
    clearTimeout(timer)
  }

  private contextLength(ref: ModelRef = this.model): number {
    const override = this.settings.models.overrides[modelKey(ref)]?.contextLength
    return (
      override ??
      this.registry.cachedModel(ref.providerId, ref.modelId)?.contextLength ??
      this.settings.models.defaultContextLength
    )
  }

  private requestParams(ref: ModelRef = this.model): Pick<ChatRequest, 'temperature' | 'maxTokens' | 'reasoningEffort' | 'replayReasoning' | 'speed'> {
    const m = this.settings.models
    const o = m.overrides[modelKey(ref)] ?? {}
    return {
      temperature: o.temperature ?? m.temperature ?? undefined,
      maxTokens: o.maxTokens ?? m.maxTokens ?? undefined,
      // The model's own setting (the thinking picker) wins over the bot's, which wins over the default.
      reasoningEffort: o.reasoningEffort ?? this.bot?.thinking ?? m.reasoningEffort ?? undefined,
      replayReasoning: o.replayReasoning,
      speed: this.o.permissions.mode === 'plan' && this.settings.agent.batchInPlanMode ? 'batch' : o.speed === 'standard' ? undefined : o.speed,
    }
  }

  private systemPrompt(tools: Tool[], ref: ModelRef = this.model): string {
    return buildSystemPrompt({
      cwd: this.session.meta.cwd,
      mode: this.o.permissions.mode,
      model: ref.modelId,
      instructionFiles: this.settings.agent.projectInstructionFiles,
      customInstructions: this.settings.agent.customInstructions,
      override: this.settings.agent.systemPromptOverride,
      toolNames: tools.map((t) => t.name),
      subagent: this.o.subagent,
      contextLength: this.contextLength(ref),
      env: this.env,
      lean: this.leanPrompt(ref),
      memory: this.memoryOn ? this.promptMemory() : undefined,
      bot: this.bot && { name: this.bot.name, persona: this.bot.persona },
      profile: this.settings.profile,
      skills: this.allowedSkills?.map((s) => ({ name: s.name, description: s.description })),
    })
  }

  private promptMemory(): { global: string[]; project: string[]; bot?: string[] } {
    const own = this.bot?.memory === 'own'
    return { global: this.memory('global'), project: this.memory('project'), ...(own ? { bot: this.memoryAccess().list('bot') } : {}) }
  }

  /** Small and free models follow a short prompt better than the full one. */
  private leanPrompt(ref: ModelRef = this.model): boolean {
    const style = this.settings.models.overrides[modelKey(ref)]?.promptStyle ?? this.settings.agent.promptStyle
    if (style !== 'auto') return style === 'lean'
    const id = ref.modelId
    return id === 'openrouter/free' || id.endsWith(':free') || !!this.registry.cachedModel(ref.providerId, id)?.free
  }

  private memory(scope: 'global' | 'project'): string[] {
    return this.o.memory?.list(scope, this.session.meta.cwd) ?? []
  }

  private recordUsage(ref: ModelRef, usage: Usage): UsageRecord {
    const info = this.registry.cachedModel(ref.providerId, ref.modelId)
    const record: UsageRecord = {
      ts: Date.now(),
      sessionId: this.usageId,
      providerId: ref.providerId,
      modelId: ref.modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens ?? 0,
      cost: computeCost(usage, info?.pricing),
    }
    this.o.usage.record(record)
    return record
  }

  /** Records a side request's usage (a mixture model) and shows the new totals; the chat's context figure stays. */
  private reportUsage(ref: ModelRef, usage: Usage) {
    const record = this.recordUsage(ref, usage)
    this.emit({ type: 'usage', record, summary: this.o.usage.summary(this.usageId), contextTokens: this.session.lastPromptTokens ?? 0, contextLength: this.contextLength() })
  }

  private modelName(ref: ModelRef): string {
    return shortModelName(ref, this.registry.has(ref.providerId) ? this.registry.cachedModel(ref.providerId, ref.modelId)?.name : undefined)
  }

  private provider(ref: ModelRef): Provider {
    if (!this.registry.has(ref.providerId)) throw new ProviderUnavailableError(ref.providerId)
    return this.registry.get(ref.providerId)
  }

  /**
   * Runs a background request (title, memory review, summary) on `primary`, moving down the
   * fallback list when it fails in a way another model can fix.
   */
  private async withFallback<T>(primary: ModelRef, fn: (provider: Provider, ref: ModelRef) => Promise<T>): Promise<T> {
    let last: unknown
    for (const ref of fallbackChain(primary, this.settings.models.fallbacks, new Set())) {
      try {
        return await fn(this.provider(ref), ref)
      } catch (err) {
        last = err
        const kind = failoverKind(err)
        if (kind !== 'next' && kind !== 'skip') throw err
      }
    }
    throw last
  }

  /** Send a user message and run the agent until it finishes, is stopped, or hits a limit. */
  async send(text: string, attach: { files?: FileAttachment[]; images?: ImageAttachment[] } = {}): Promise<TurnEndReason> {
    if (this.abort) throw new Error('Agent is already running')
    const abort = (this.abort = new AbortController())
    this.emit({ type: 'turn_start' })
    const files = attach.files?.length ? attach.files : undefined
    const images = attach.images?.length ? attach.images : undefined
    if (this.session.messages.length === 0 && this.session.meta.title === 'New chat') {
      this.session.meta.title = titleFrom(text || [...(files ?? []), ...(images ?? [])].map((f) => f.name).join(', '))
      if (text.trim() && !this.o.subagent) void this.autoTitle(text, this.session.meta.title)
    }
    if (images && this.registry.cachedModel(this.model.providerId, this.model.modelId)?.supportsImages === false) {
      this.emit({ type: 'notice', level: 'warn', text: `${this.model.modelId} doesn't accept images, so the request may fail. Pick a vision model with ⌘/Ctrl+K.` })
    }
    const note = this.session.pendingNote
    this.session.pendingNote = undefined
    this.push({ role: 'user', content: text, ...(files ? { files } : {}), ...(images ? { images } : {}), ...(note ? { note } : {}) })
    this.turnAt = this.session.messages.length - 1
    return this.run(abort)
  }

  /**
   * Runs the last request again after it failed: drops a reply that broke off and continues from
   * the last user message or tool result, without adding a message.
   */
  async retry(): Promise<TurnEndReason> {
    if (this.abort) throw new Error('Agent is already running')
    const last = this.session.messages.at(-1)
    if (last?.role === 'assistant' && !last.toolCalls?.length && last.content.endsWith('[interrupted]')) this.session.messages.pop()
    const end = this.session.messages.at(-1)
    if (!end || end.role === 'assistant') throw new Error('Nothing to retry: the last request finished.')
    const abort = (this.abort = new AbortController())
    this.emit({ type: 'turn_start' })
    this.turnAt = this.session.messages.findLastIndex((m) => m.role === 'user' && !m.synthetic)
    this.save()
    return this.run(abort)
  }

  /**
   * Replaces the user message at `index` with `text` and runs from there; later messages are
   * dropped. With `revert`, files changed by the dropped turns are restored first.
   */
  async editAndResend(index: number, text: string, opts: { revert?: boolean } = {}): Promise<TurnEndReason> {
    if (this.abort) throw new Error('Agent is already running')
    const m = this.session.messages[index]
    if (m?.role !== 'user' || m.synthetic) throw new Error('Only your own messages can be edited.')
    const dropped = (this.session.checkpoints ?? []).filter((c) => c.at >= index)
    if (opts.revert) for (const c of [...dropped].sort((a, b) => b.at - a.at)) this.restore(c.files)
    this.session.checkpoints = (this.session.checkpoints ?? []).filter((c) => c.at < index)
    this.session.messages = this.session.messages.slice(0, index)
    this.session.lastPromptTokens = undefined
    this.save()
    return this.send(text, { files: m.files, images: m.images })
  }

  /** Turns that changed files, with the files they changed. */
  get checkpoints(): Checkpoint[] {
    return this.session.checkpoints ?? []
  }

  /**
   * Puts the files a turn changed back the way they were before it (or just `file`). The model is
   * told with the next message. Returns the paths restored.
   */
  revert(at: number, file?: string): string[] {
    if (this.abort) throw new Error('Wait for the turn to finish, or stop it, before reverting.')
    const cp = this.checkpoints.find((c) => c.at === at)
    if (!cp) return []
    const files = file ? (file in cp.files ? { [file]: cp.files[file] } : {}) : cp.files
    const restored = this.restore(files)
    for (const f of Object.keys(files)) delete cp.files[f]
    if (!Object.keys(cp.files).length) this.session.checkpoints = this.checkpoints.filter((c) => c !== cp)
    if (restored.length) {
      const list = restored.map((f) => `- ${f}`).join('\n')
      const note = `The user reverted your changes to these files; they are back to how they were before that turn:\n${list}\nRe-read them before editing.`
      this.session.pendingNote = [this.session.pendingNote, note].filter(Boolean).join('\n\n')
      for (const f of restored) this.readFiles.delete(f)
    }
    this.save()
    return restored
  }

  private restore(files: Record<string, string | null>): string[] {
    const done: string[] = []
    for (const [file, content] of Object.entries(files)) {
      try {
        if (content === null) fs.rmSync(file, { force: true })
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content)
        }
        done.push(file)
      } catch (err) {
        this.emit({ type: 'notice', level: 'warn', text: `Couldn't restore ${file}: ${(err as Error).message}` })
      }
    }
    return done
  }

  /** Keeps a file's content from before the running turn first touched it. */
  private checkpoint(abs: string, before: string | null) {
    if (this.o.subagent || this.turnAt < 0) return
    if (before !== null && Buffer.byteLength(before) > MAX_CHECKPOINT_BYTES) return
    const list = (this.session.checkpoints ??= [])
    let cp = list.find((c) => c.at === this.turnAt)
    if (!cp) list.push((cp = { at: this.turnAt, files: {} }))
    if (!(abs in cp.files)) cp.files[abs] = before
  }

  private async run(abort: AbortController): Promise<TurnEndReason> {
    let reason: TurnEndReason = 'max_steps'
    this.warnedNoTools = false
    this.env = gatherEnvironment(this.session.meta.cwd, { shell: this.settings.agent.shell })
    this.reminders.startTurn(this.o.permissions.mode)
    this.failedCalls = []
    this.skipped = new Set()
    await this.loadModelInfo()
    let reviewed = false
    try {
      for (let step = 0; step < this.settings.agent.maxStepsPerTurn; step++) {
        const budget = checkBudget(this.o.usage.summary(this.usageId), this.settings.usage)
        if (!budget.ok) {
          const msg = `${budget.which === 'session' ? 'Session' : 'Daily'} budget reached ($${budget.spent.toFixed(4)} of $${budget.limit.toFixed(2)}).`
          if (this.settings.usage.budgetAction === 'stop') {
            this.emit({ type: 'notice', level: 'warn', text: `${msg} Stopping. Raise the limit in Settings › Usage.` })
            reason = 'budget'
            break
          }
          if (step === 0) this.emit({ type: 'notice', level: 'warn', text: msg })
        }

        await this.maybeCompact(abort.signal)
        this.injectReminders()
        // With Mixture of Agents on, a final answer is held back and becomes the mixture's draft.
        const { calls: toolCalls, draft } = await this.step(abort.signal, this.mixing)
        if (!toolCalls.length) {
          const review = reviewed ? null : this.reviewPrompt()
          if (review) {
            if (draft) this.pushDraft(draft)
            // One nudge per turn: finish the rest, or say plainly what was skipped.
            reviewed = true
            this.push({ role: 'user', content: review, synthetic: 'review' })
            continue
          }
          if (draft) await this.finishMixed(draft, abort.signal)
          reason = 'done'
          break
        }
        for (let i = 0; i < toolCalls.length; ) {
          if (abort.signal.aborted) {
            // Every tool call must get a result or the next request is invalid.
            for (const c of toolCalls.slice(i)) this.interrupted(c)
            break
          }
          // Consecutive read-only calls (reads, searches, subagents) run in parallel.
          let j = i
          while (j < toolCalls.length && this.parallelSafe(toolCalls[j])) j++
          if (j - i > 1) {
            await this.runParallel(toolCalls.slice(i, j), abort.signal)
            i = j
          } else await this.runTool(toolCalls[i++], abort.signal)
        }
        if (abort.signal.aborted) {
          reason = 'aborted'
          break
        }
      }
      const open = this.unfinishedTodos()
      if (reason === 'done' && open.length) {
        const total = this.session.todos?.length ?? 0
        this.emit({ type: 'notice', level: 'warn', text: `${open.length} of ${total} checklist items not completed: ${open.map((t) => t.content).join('; ')}` })
      }
      if (reason === 'max_steps') {
        this.emit({
          type: 'notice',
          level: 'warn',
          text: `Stopped after ${this.settings.agent.maxStepsPerTurn} steps (Settings › Advanced › Agent limits). Send "continue" to keep going.`,
        })
      }
    } catch (err) {
      if (abort.signal.aborted) reason = 'aborted'
      else {
        reason = 'error'
        this.emit({ type: 'error', message: (err as Error).message })
      }
    } finally {
      this.abort = null
      this.save()
      this.emit({ type: 'turn_end', reason })
    }
    // Runs after the turn has ended, so it never holds it up.
    if (reason === 'done' && this.memoryOn && this.settings.memory.autoReview && !this.o.subagent) void this.reviewMemory()
    return reason
  }

  private unfinishedTodos(): TodoItem[] {
    return (this.session.todos ?? []).filter((t) => t.status !== 'completed')
  }

  /**
   * Adds a hidden `<system-reminder>` note before the next request when something changed that the
   * model should know: open todos going stale, files edited outside the agent, mode switches, budget
   * or context running out. Only after tool results, so a user message is never followed by another.
   */
  private injectReminders() {
    const last = this.session.messages.at(-1)
    if (last?.role !== 'tool') return
    const budget = this.settings.usage
    const summary = this.o.usage.summary(this.usageId)
    const notes = this.reminders.collect({
      mode: this.o.permissions.mode,
      todos: this.session.todos ?? [],
      hasTodoTool: this.activeTools().some((t) => t.name === 'todo_write'),
      budget: [
        budget.sessionBudgetUsd != null ? { label: 'chat', spent: summary.session.cost, limit: budget.sessionBudgetUsd } : null,
        budget.dailyBudgetUsd != null ? { label: 'daily', spent: summary.today.cost, limit: budget.dailyBudgetUsd } : null,
      ].filter((b) => b !== null),
      context: { used: this.session.lastPromptTokens ?? 0, length: this.contextLength() },
    })
    if (!notes.length) return
    const content = notes.map((n) => `<system-reminder>\n${n}\n</system-reminder>`).join('\n')
    this.push({ role: 'user', content, synthetic: 'reminder' })
  }

  /** What the model should account for before ending the turn, or null if nothing. */
  private reviewPrompt(): string | null {
    const open = this.unfinishedTodos()
    const failed = [...new Set(this.failedCalls)]
    if (!open.length && !failed.length) return null
    const parts = ['[Automatic check before you finish]']
    if (open.length) parts.push(`These checklist items are not completed:\n${open.map((t) => `- ${t.content} (${t.status})`).join('\n')}`)
    if (failed.length) parts.push(`These tool calls failed:\n${failed.map((f) => `- ${f}`).join('\n')}`)
    parts.push(
      'Finish what you still can. For anything you cannot do, say so plainly in your final reply: which step, why, and what you did instead. Do not claim everything is done. Update the checklist to match.',
    )
    return parts.join('\n\n')
  }

  /**
   * One model step: the chat's model, then each fallback in order when it fails in a way another
   * model can fix. Appends the assistant message and returns its tool calls. With `hold`, a final
   * answer (no tool calls) isn't streamed or appended but returned as a draft.
   */
  private async step(signal: AbortSignal, hold = false): Promise<{ calls: ToolCall[]; draft?: Draft }> {
    const tools = this.activeTools()
    const main = { ...this.model }
    const chain = fallbackChain(main, this.settings.models.fallbacks, this.skipped)
    if (!chain.length) chain.push(main)
    const failed: string[] = []
    for (let i = 0; ; i++) {
      const ref = chain[i]
      const partial = { content: '' }
      try {
        const out = await this.request(ref, tools, signal, hold, partial)
        const { content, reasoning, calls, usage, extra } = out
        const draft = hold && !calls.length ? { ref, content, reasoning, extra } : undefined
        if (!draft) this.push({ role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}), ...(reasoning ? { reasoning } : {}), ...(extra ? { extra } : {}) })
        if (usage) {
          // Usage counts against the model that actually answered.
          const record = this.recordUsage(ref, usage)
          this.session.lastPromptTokens = usage.promptTokens + usage.completionTokens
          this.emit({ type: 'usage', record, summary: this.o.usage.summary(this.usageId), contextTokens: this.session.lastPromptTokens, contextLength: this.contextLength(ref) })
        }
        return { calls, draft }
      } catch (err) {
        const kind = failoverKind(err, signal)
        // Not found, no key, not connected: no point trying it again this turn.
        if (kind === 'skip') this.skipped.add(modelKey(ref))
        const next = kind ? chain.findIndex((c, j) => j > i && (kind !== 'context' || this.contextLength(c) > this.contextLength(ref))) : -1
        if (next < 0) {
          // Keep whatever was streamed before the interruption.
          if (partial.content.trim() && !hold) this.push({ role: 'assistant', content: partial.content + '\n\n[interrupted]' })
          if (!failed.length || !(err instanceof Error)) throw err
          const note = ` Fallback models tried first: ${failed.join(', ')}.`
          throw err instanceof ProviderError ? new ProviderError(err.message + note, err.status, err.retryable) : new Error(err.message + note)
        }
        const why = failureLabel(err)
        failed.push(`${this.modelName(ref)} (${why})`)
        const to = chain[next]
        this.emit({ type: 'stream_reset' })
        this.emit({ type: 'fallback', from: ref, to, reason: why, text: `${this.modelName(ref)} failed (${why}). Continued on ${this.modelName(to)}.` })
        i = next - 1
      }
    }
  }

  /** One request to one model, with retries for replies that broke off and one summary on overflow. */
  private async request(ref: ModelRef, tools: Tool[], signal: AbortSignal, hold: boolean, partial: { content: string }) {
    const provider = this.provider(ref)
    const info = this.registry.cachedModel(ref.providerId, ref.modelId)
    if (info && !info.supportsTools && !this.warnedNoTools) {
      this.warnedNoTools = true
      this.emit({ type: 'notice', level: 'warn', text: `${ref.modelId} doesn't advertise tool support; it may not be able to act.` })
    }

    let content = ''
    let reasoning = ''
    let calls: ToolCall[] = []
    let usage: Usage | undefined
    let extra: Record<string, unknown> | undefined
    const retries = this.settings.agent.requestRetries
    let compactedForOverflow = false
    for (let attempt = 0; ; attempt++) {
      content = ''
      reasoning = ''
      calls = []
      usage = undefined
      extra = undefined
      partial.content = ''
      try {
        for await (const ev of provider.chat({
          model: ref.modelId,
          messages: [{ role: 'system', content: this.systemPrompt(tools, ref) }, ...this.session.messages],
          tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
          signal,
          stallMs: this.settings.agent.stallTimeoutSec * 1000,
          ...this.requestParams(ref),
        })) {
          if (ev.type === 'text') {
            content += ev.delta
            partial.content = content
            // A held answer may be replaced by the mixture, so it isn't shown while it streams.
            if (!hold) this.emit(ev)
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta
            this.emit(ev)
          } else if (ev.type === 'tool_call') calls.push(ev.call)
          else if (ev.type === 'usage') usage = ev.usage
          else if (ev.type === 'extra') extra = ev.extra
          else if (ev.type === 'status') this.emit({ type: 'notice', level: 'info', text: ev.text })
        }
        return { content, reasoning, calls, usage, extra }
      } catch (err) {
        // A reply that broke off midway (overloaded upstream, common on free models) is retried from scratch.
        if (err instanceof ProviderError && err.retryable && !signal.aborted && attempt < retries) {
          this.emit({ type: 'stream_reset' })
          this.emit({ type: 'notice', level: 'info', text: `${err.message} Retrying (${attempt + 1}/${retries})…` })
          await sleep(1000 * 2 ** attempt, signal)
          continue
        }
        // Too long for the model: summarize older history once and try again.
        if (isContextOverflow(err) && !compactedForOverflow && !signal.aborted) {
          compactedForOverflow = true
          this.emit({ type: 'stream_reset' })
          this.emit({ type: 'notice', level: 'info', text: 'The conversation no longer fits the model. Summarizing older messages and retrying…' })
          if (await this.compact(signal)) continue
        }
        throw err
      }
    }
  }

  private pushDraft(d: Draft) {
    this.push({ role: 'assistant', content: d.content, ...(d.reasoning ? { reasoning: d.reasoning } : {}), ...(d.extra ? { extra: d.extra } : {}) })
  }

  /**
   * Mixture of Agents: the proposers answer the conversation in parallel (text only), then the
   * aggregator writes the reply from their answers and the chat model's draft. If no proposer
   * answers, or the aggregator fails, the draft is the reply.
   */
  private async finishMixed(draft: Draft, signal: AbortSignal): Promise<void> {
    const cfg = this.settings.moa
    const aggregator = cfg.aggregator!
    const budget = checkBudget(this.o.usage.summary(this.usageId), this.settings.usage)
    if (!budget.ok && this.settings.usage.budgetAction === 'stop') {
      this.pushDraft(draft)
      this.emit({ type: 'notice', level: 'info', text: 'Budget reached, so this reply was not mixed from other models.' })
      return
    }
    const transcript = mixtureTranscript(this.session.messages)
    const lang = this.settings.profile.language
    this.emit({ type: 'mixing', phase: 'proposing', models: cfg.proposers })
    const proposals = await runProposers(cfg.proposers, async (ref) => {
      const { text, usage } = await collectText(this.provider(ref), ref.modelId, proposerMessages(transcript, lang), signal)
      if (usage) this.reportUsage(ref, usage)
      return text
    })
    if (signal.aborted) {
      this.pushDraft(draft)
      throw signal.reason ?? new Error('Interrupted by user')
    }
    const answered = proposals.filter((p) => p.content)
    if (!answered.length) {
      this.pushDraft(draft)
      this.emit({ type: 'notice', level: 'warn', text: "None of the mixture models answered, so this is the chat model's own reply." })
      return
    }
    const withDraft = !!draft.content.trim()
    const answers = [
      ...(withDraft ? [{ label: `the agent's draft, ${this.modelName(draft.ref)}`, content: draft.content }] : []),
      ...answered.map((p) => ({ label: this.modelName(p.model), content: p.content! })),
    ]
    this.emit({ type: 'mixing', phase: 'combining', models: [aggregator] })
    let streamed = false
    try {
      const { text, usage } = await collectText(this.provider(aggregator), aggregator.modelId, aggregatorMessages(transcript, answers, lang), signal, (delta) => {
        streamed = true
        this.emit({ type: 'text', delta })
      })
      if (usage) this.reportUsage(aggregator, usage)
      if (!text) throw new Error('empty reply')
      this.push({
        role: 'assistant',
        content: text,
        moa: { aggregator, proposals, ...(withDraft ? { draft: { model: draft.ref, content: draft.content } } : {}) },
      })
    } catch (err) {
      if (streamed) this.emit({ type: 'stream_reset' })
      this.pushDraft(draft)
      if (signal.aborted) throw err
      this.emit({ type: 'notice', level: 'warn', text: `${this.modelName(aggregator)} couldn't combine the answers (${failureLabel(err)}), so this is the chat model's own reply.` })
    }
  }

  private sessionAccess(): SessionAccess | undefined {
    const store = this.o.sessions
    if (!store) return undefined
    // A subagent's own chat is never saved; it leaves out its parent's instead.
    return { list: (opts) => store.list(opts), load: (id) => store.load(id), exclude: this.o.subagent?.parentSessionId ?? this.session.meta.id }
  }

  private toolContext(callId: string, signal: AbortSignal): ToolContext {
    return {
      cwd: this.session.meta.cwd,
      signal,
      readFiles: this.readFiles,
      toolOutputMaxChars: this.settings.agent.toolOutputMaxChars,
      bashTimeoutSec: this.settings.agent.bashTimeoutSec,
      shell: this.settings.agent.shell,
      setTodos: (todos) => {
        this.session.todos = todos
        this.emit({ type: 'todos', todos })
      },
      progress: (text) => this.emit({ type: 'tool_progress', callId, text }),
      memory: this.memoryOn ? this.memoryAccess() : undefined,
      jobs: this.jobs,
      browser: this.browserAccess(),
      skills: this.skills && {
        list: this.allowedSkills ?? [],
        dirs: {
          user: this.o.userSkillsDir ?? path.join(USER_EXT_DIR, 'skills'),
          project: path.join(projectExtDir(this.session.meta.cwd), 'skills'),
        },
        added: (skill) => {
          // A project skill keeps winning over a user skill with the same name, as in the loader.
          const shadowed = this.skills?.some((s) => s.name === skill.name && s.source === 'project' && skill.source !== 'project')
          if (shadowed) return
          this.skills = [...(this.skills ?? []).filter((s) => s.name !== skill.name), skill].sort((a, b) => a.name.localeCompare(b.name))
        },
      },
      sessions: this.sessionAccess(),
      webSearch: this.webSearchConfig(),
      runSubagent: this.o.subagent ? undefined : (input) => this.runSubagent(callId, input, signal),
      askUser: this.o.askUser && !this.o.subagent ? (q) => this.o.askUser!({ ...q, callId }) : undefined,
      checkpoint: (abs, before) => this.checkpoint(abs, before),
      checkAfterEdit: this.settings.tools.checkAfterEdit,
      checkTimeoutSec: this.settings.tools.checkTimeoutSec,
    }
  }

  private webSearchConfig(): WebSearchConfig {
    const ws = this.settings.tools.webSearch
    const keyId = SEARCH_KEY_ID[ws.backend]
    const keys = { brave: this.o.secret?.('brave'), tavily: this.o.secret?.('tavily') }
    return { backend: ws.backend, searxngUrl: ws.searxngUrl, key: keyId ? this.o.secret?.(keyId) : undefined, keys }
  }

  /** Subagents count toward their parent chat's usage and budget. */
  private get usageId(): string {
    return this.o.subagent?.parentSessionId ?? this.session.meta.id
  }

  private interrupted(c: ToolCall) {
    this.push({ role: 'tool', toolCallId: c.id, name: c.name, content: 'Interrupted by user before running.' })
  }

  /** Read-only tools never ask, never change anything, so they can run side by side. */
  private parallelSafe(call: ToolCall): boolean {
    return !!this.activeTools().find((t) => t.name === call.name)?.readOnly
  }

  /**
   * Runs calls concurrently (at most 8 at once, subagents limited to `subagents.maxParallel`),
   * but adds their results to history in the order the model asked for them.
   */
  private async runParallel(calls: ToolCall[], signal: AbortSignal) {
    const taskSlots = semaphore(this.settings.agent.subagents.maxParallel)
    const anySlots = semaphore(8)
    let prev: Promise<void> = Promise.resolve()
    await Promise.all(
      calls.map((c) => {
        const before = prev
        let done!: () => void
        prev = new Promise<void>((r) => (done = r))
        return (async () => {
          const releaseAny = await anySlots()
          const releaseTask = c.name === TASK_TOOL ? await taskSlots() : () => {}
          try {
            if (signal.aborted) {
              await before
              this.interrupted(c)
            } else await this.runTool(c, signal, before)
          } finally {
            releaseTask()
            releaseAny()
            done()
          }
        })()
      }),
    )
  }

  /** Runs a delegated task in a fresh, unsaved session and returns its final report. */
  private async runSubagent(callId: string, input: SubagentInput, signal: AbortSignal): Promise<ToolResult> {
    const cfg = this.settings.agent.subagents
    const readOnly = input.type === 'explore' || !cfg.allowWrite || this.o.permissions.mode === 'plan'
    // A bot's tool limits hold for the helpers it starts too.
    const tools = filterBotTools(this.tools, this.bot).filter((t) => t.name !== TASK_TOOL && t.name !== 'todo_write' && (!readOnly || t.readOnly))
    const model = cfg.model ?? this.model
    const progress = (text: string) => this.emit({ type: 'tool_progress', callId, text })
    let error = ''
    const child = new Agent({
      session: newSession(this.session.meta.cwd, model),
      registry: this.registry,
      tools,
      settings: { ...this.settings, agent: { ...this.settings.agent, maxStepsPerTurn: cfg.maxSteps } },
      usage: this.o.usage,
      permissions: this.o.permissions,
      // A bot with memory off keeps its helpers out of it too.
      memory: this.memoryOn ? this.o.memory : undefined,
      skills: this.allowedSkills,
      sessions: this.o.sessions,
      subagent: { description: input.description, parentSessionId: this.session.meta.id },
      jobs: this.jobs,
      secret: this.o.secret,
      // Approvals surface in the parent's task card; ids are prefixed to stay unique.
      askPermission: (req) =>
        this.o.askPermission({ ...req, callId: `${callId}/${req.callId}`, reason: `Subagent "${input.description}": ${req.reason}` }),
      onEvent: (e) => {
        if (e.type === 'tool_start' && e.name !== 'todo_write') progress(`→ ${e.name} ${e.subject}\n`)
        else if (e.type === 'tool_end' && e.result.isError) progress(`  ${e.denied ? 'denied' : 'failed'}: ${e.result.content.split('\n')[0].slice(0, 160)}\n`)
        else if (e.type === 'notice' || e.type === 'fallback') progress(`  ${e.text}\n`)
        else if (e.type === 'error') (error = e.message), progress(`  error: ${e.message}\n`)
        else if (e.type === 'usage') {
          // Keep the parent's usage display current while the subagent spends tokens.
          this.emit({ ...e, contextTokens: this.session.lastPromptTokens ?? 0, contextLength: this.contextLength() })
        }
      },
    })
    progress(`Subagent (${readOnly ? 'read-only' : 'can edit'}, ${model.modelId})\n`)
    const onAbort = () => child.stop()
    signal.addEventListener('abort', onAbort)
    try {
      const reason = await child.send(input.prompt)
      const report = [...child.session.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content.trim() ?? ''
      if (reason === 'aborted') return { content: 'Subagent interrupted by user.', isError: true }
      if (reason === 'error') return { content: `Subagent failed: ${error || 'unknown error'}${report ? `\n\nPartial report:\n${report}` : ''}`, isError: true }
      const note = reason === 'max_steps' ? `\n\n[Subagent hit its ${cfg.maxSteps}-step limit; the report may be incomplete.]` : reason === 'budget' ? '\n\n[Stopped by the budget limit.]' : ''
      return { content: (report || 'The subagent finished without a report.') + note }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Closes the subagent's own browser, if it opened one; the shared jobs keep running.
      child.dispose()
    }
  }

  /** `before` resolves when earlier calls of a parallel batch are in history, keeping results in order. */
  private async runTool(call: ToolCall, signal: AbortSignal, before?: Promise<void>): Promise<void> {
    // Reset after approval so durations measure execution, not time spent waiting for the user.
    let started = Date.now()
    let label = ''
    let input: unknown
    const tool = this.activeTools().find((t) => t.name === call.name)
    const finish = async (result: ToolResult, denied = false) => {
      const durationMs = Date.now() - started
      await before
      // Only failures of real work count (not malformed calls), and a later success of the same call clears them.
      if (label) {
        const key = `${call.name} ${label.slice(0, 120)}`
        if (result.isError && !denied) this.failedCalls.push(key)
        else if (!result.isError) this.failedCalls = this.failedCalls.filter((f) => f !== key)
      }
      if (!result.isError) this.reminders.afterTool(call.name, tool?.kind, input, this.session.meta.cwd)
      if (result.display) (this.session.displays ??= {})[call.id] = result.display
      if (denied) (this.session.denied ??= []).push(call.id)
      this.emit({ type: 'tool_end', callId: call.id, name: call.name, result, durationMs, denied })
      this.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.isError && !denied ? `Error: ${result.content}` : result.content,
        ...(result.images?.length && !result.isError ? { images: result.images } : {}),
      })
    }

    let raw: unknown
    try {
      raw = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    } catch {
      this.emit({ type: 'tool_start', callId: call.id, name: call.name, subject: '', input: call.arguments })
      return finish({ content: `Arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, isError: true })
    }
    if (!tool) {
      this.emit({ type: 'tool_start', callId: call.id, name: call.name, subject: '', input: raw })
      return finish({ content: `Unknown or unavailable tool "${call.name}".`, isError: true })
    }
    try {
      input = tool.parse(raw)
    } catch (e) {
      this.emit({ type: 'tool_start', callId: call.id, name: call.name, subject: '', input: raw })
      return finish({ content: (e as Error).message, isError: true })
    }
    const subject = tool.subject(input)
    label = subject
    this.emit({ type: 'tool_start', callId: call.id, name: call.name, subject, input })

    const pre = await this.hooks('pre', tool, subject, input, signal)
    if (pre?.block) return finish({ content: `Blocked by a hook: ${pre.block}`, isError: true }, true)

    const verdict = this.o.permissions.check(tool, subject)
    if (verdict.decision === 'deny') return finish({ content: `Permission denied: ${verdict.reason}`, isError: true }, true)
    if (verdict.decision === 'ask') {
      const answer = await this.o.askPermission({
        callId: call.id,
        tool: tool.name,
        kind: tool.kind,
        subject,
        input,
        reason: verdict.reason,
        suggestedRule: this.o.permissions.suggestRule(tool, subject),
      })
      if (signal.aborted) return finish({ content: 'Interrupted by user.', isError: true }, true)
      if (answer.type === 'deny') {
        const fb = answer.feedback?.trim()
        return finish(
          { content: `The user denied this action.${fb ? ` Their feedback: ${fb}` : ' Ask them how to proceed if unclear.'}`, isError: true },
          true,
        )
      }
      if (answer.type === 'allowAlways') this.o.permissions.remember(tool, subject)
    }

    started = Date.now()
    let result: ToolResult
    try {
      result = await tool.execute(input, this.toolContext(call.id, signal))
    } catch (e) {
      result = { content: signal.aborted ? 'Interrupted by user.' : (e as Error).message, isError: true }
    }
    const post = signal.aborted ? null : await this.hooks('post', tool, subject, input, signal, result)
    if (post?.append) result = { ...result, content: `${result.content}\n\n${post.append}` }
    await finish(result)
  }

  /** Runs the user's pre/post tool hooks from settings, reporting failures as notices. */
  private async hooks(
    kind: 'pre' | 'post',
    tool: Tool,
    subject: string,
    input: unknown,
    signal: AbortSignal,
    result?: ToolResult,
  ): Promise<HookOutcome | null> {
    const rules = kind === 'pre' ? this.settings.hooks.preTool : this.settings.hooks.postTool
    if (!rules.some((r) => r.enabled)) return null
    const ctx = { cwd: this.session.meta.cwd, shell: this.settings.agent.shell, signal, maxChars: this.settings.agent.toolOutputMaxChars }
    const outcome = await runHooks(kind, rules, tool, subject, input, ctx, result)
    for (const w of outcome.warnings) this.emit({ type: 'notice', level: 'warn', text: w })
    return outcome
  }

  private async maybeCompact(signal: AbortSignal) {
    if (!this.settings.agent.compactionEnabled) return
    const used = this.session.lastPromptTokens ?? estimateTokens(this.session.messages)
    if (used < this.contextLength() * this.settings.agent.compactionThreshold) return
    this.emit({ type: 'notice', level: 'info', text: 'Context is getting full. Summarizing older messages…' })
    await this.compact(signal)
  }

  /** Names the chat with the title model, unless it's unset or the chat was renamed meanwhile. */
  private async autoTitle(text: string, fallback: string) {
    const ref = this.settings.models.title
    if (!ref) return
    try {
      const { title } = await this.withFallback(ref, async (provider, r) => {
        const out = await generateTitle(provider, r.modelId, text, AbortSignal.timeout(60_000))
        if (out.usage) this.recordUsage(r, out.usage)
        return out
      })
      if (!title || this.session.meta.title !== fallback) return
      this.session.meta.title = title
      this.save()
      this.emit({ type: 'title', title })
    } catch {
      // The first line stays as the title.
    }
  }

  /** Asks the review model whether the turn taught a durable fact, and saves it. Failures are silent. */
  private async reviewMemory() {
    const ref = this.settings.models.memoryReview ?? this.settings.models.title
    if (!ref || !this.o.memory) return
    const messages = this.session.messages
    const user = messages.findLast((m) => m.role === 'user' && !m.synthetic)
    const reply = messages.findLast((m) => m.role === 'assistant' && m.content.trim())
    if (!user || !reply || !user.content.trim()) return
    try {
      const { review } = await this.withFallback(ref, async (provider, r) => {
        const out = await reviewExchange(
          provider,
          r.modelId,
          { global: this.memory('global'), project: this.memory('project'), user: user.content, reply: reply.content },
          AbortSignal.timeout(90_000),
        )
        if (out.usage) this.recordUsage(r, out.usage)
        return out
      })
      // Memory may have been turned off while the review ran.
      if (!review || !this.memoryOn) return
      const { added, removed } = applyReview(this.o.memory.scoped(this.session.meta.cwd), review)
      if (added.length || removed.length) this.emit({ type: 'memory', added, removed })
    } catch {
      // Memory stays as it was.
    }
  }

  /** Summarize older history into one message. Safe to call manually (e.g. a /compact command). */
  async compact(signal?: AbortSignal): Promise<boolean> {
    const split = compactionSplit(this.session.messages)
    if (split <= 0) return false
    const old = this.session.messages.slice(0, split)
    const { summary } = await this.withFallback(this.settings.models.compaction ?? this.model, async (provider, ref) => {
      const window = this.registry.cachedModel(ref.providerId, ref.modelId)?.contextLength ?? this.contextLength()
      // ~4 characters per token; leave room for the prompt and the summary itself.
      const out = await summarize(provider, ref.modelId, old, signal, Math.min(400_000, Math.floor(window * 0.6 * 4)))
      if (out.usage) this.recordUsage(ref, out.usage)
      return out
    })
    if (!summary) return false
    this.session.messages = [
      { role: 'user', content: `[Summary of the earlier conversation]\n\n${summary}` },
      { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' },
      ...this.session.messages.slice(split),
    ]
    this.session.lastPromptTokens = undefined
    // Two messages (summary + acknowledgement) replace the first `split`.
    const shift = (at: number) => (at >= split ? at - split + 2 : -1)
    this.session.checkpoints = this.checkpoints.map((c) => ({ ...c, at: shift(c.at) })).filter((c) => c.at >= 0)
    if (this.turnAt >= 0) this.turnAt = Math.max(0, shift(this.turnAt))
    this.emit({ type: 'compacted', removedMessages: split })
    this.save()
    return true
  }
}
