import { compactionSplit, estimateTokens, summarize } from '../context/compact.js'
import { buildSystemPrompt } from '../context/system-prompt.js'
import type { MemoryStore } from '../memory/store.js'
import type { Permissions, PermissionAnswer } from '../permissions/permissions.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { ProviderError, type ChatRequest } from '../providers/types.js'
import { newSession, titleFrom, type Session } from '../sessions/store.js'
import { modelKey, type Settings } from '../settings/schema.js'
import { FORGET_TOOL, REMEMBER_TOOL } from '../tools/memory.js'
import { TASK_TOOL } from '../tools/task.js'
import type { SubagentInput, Tool, ToolContext, ToolResult } from '../tools/types.js'
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
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
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

export interface AgentOptions {
  session: Session
  registry: ProviderRegistry
  tools: Tool[]
  settings: Settings
  usage: UsageTracker
  permissions: Permissions
  askPermission: (req: PermissionRequest) => Promise<PermissionAnswer>
  onEvent: (e: AgentEvent) => void
  /** Called whenever the session changes and should be persisted. */
  onSave?: (session: Session) => void
  /** Where saved facts live; memory is off without it. */
  memory?: MemoryStore
  /** Set for subagents: what they were asked to do, and whose usage/budget they count against. */
  subagent?: { description: string; parentSessionId: string }
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

  constructor(private readonly o: AgentOptions) {
    this.session = o.session
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

  updateSettings(settings: Settings, tools?: Tool[]): void {
    this.settings = settings
    if (tools) this.tools = tools
    this.o.permissions.update({ ...settings.permissions, mode: this.o.permissions.mode })
  }

  stop(): void {
    this.abort?.abort(new Error('Interrupted by user'))
  }

  private emit(e: AgentEvent) {
    this.o.onEvent(e)
  }

  private save() {
    this.o.onSave?.(this.session)
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
    return this.tools.filter((t) => !disabled.has(t.name) && (!plan || t.readOnly))
  }

  private get memoryOn(): boolean {
    return !!this.o.memory && this.settings.memory.enabled
  }

  private contextLength(): number {
    const ref = this.model
    const override = this.settings.models.overrides[modelKey(ref)]?.contextLength
    return (
      override ??
      this.registry.cachedModel(ref.providerId, ref.modelId)?.contextLength ??
      this.settings.models.defaultContextLength
    )
  }

  private requestParams(): Pick<ChatRequest, 'temperature' | 'maxTokens' | 'reasoningEffort'> {
    const m = this.settings.models
    const o = m.overrides[modelKey(this.model)] ?? {}
    return {
      temperature: o.temperature ?? m.temperature ?? undefined,
      maxTokens: o.maxTokens ?? m.maxTokens ?? undefined,
      reasoningEffort: o.reasoningEffort ?? m.reasoningEffort ?? undefined,
    }
  }

  private systemPrompt(tools: Tool[]): string {
    return buildSystemPrompt({
      cwd: this.session.meta.cwd,
      mode: this.o.permissions.mode,
      model: this.model.modelId,
      instructionFiles: this.settings.agent.projectInstructionFiles,
      customInstructions: this.settings.agent.customInstructions,
      override: this.settings.agent.systemPromptOverride,
      toolNames: tools.map((t) => t.name),
      subagent: this.o.subagent,
      memory: this.memoryOn ? { global: this.memory('global'), project: this.memory('project') } : undefined,
    })
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

  /** Send a user message and run the agent until it finishes, is stopped, or hits a limit. */
  async send(text: string, attach: { files?: FileAttachment[]; images?: ImageAttachment[] } = {}): Promise<TurnEndReason> {
    if (this.abort) throw new Error('Agent is already running')
    const abort = (this.abort = new AbortController())
    this.emit({ type: 'turn_start' })
    const files = attach.files?.length ? attach.files : undefined
    const images = attach.images?.length ? attach.images : undefined
    if (this.session.messages.length === 0 && this.session.meta.title === 'New chat') {
      this.session.meta.title = titleFrom(text || [...(files ?? []), ...(images ?? [])].map((f) => f.name).join(', '))
    }
    if (images && this.registry.cachedModel(this.model.providerId, this.model.modelId)?.supportsImages === false) {
      this.emit({ type: 'notice', level: 'warn', text: `${this.model.modelId} doesn't accept images, so the request may fail. Pick a vision model with ⌘/Ctrl+K.` })
    }
    this.push({ role: 'user', content: text, ...(files ? { files } : {}), ...(images ? { images } : {}) })

    let reason: TurnEndReason = 'max_steps'
    this.failedCalls = []
    let reviewed = false
    try {
      for (let step = 0; step < this.settings.agent.maxStepsPerTurn; step++) {
        const budget = checkBudget(this.o.usage.summary(this.usageId), this.settings.usage)
        if (!budget.ok) {
          const msg = `${budget.which === 'session' ? 'Session' : 'Daily'} budget reached ($${budget.spent.toFixed(4)} of $${budget.limit.toFixed(2)}).`
          if (this.settings.usage.budgetAction === 'stop') {
            this.emit({ type: 'notice', level: 'warn', text: `${msg} Stopping. Raise the limit in Settings → Usage.` })
            reason = 'budget'
            break
          }
          if (step === 0) this.emit({ type: 'notice', level: 'warn', text: msg })
        }

        await this.maybeCompact(abort.signal)
        const toolCalls = await this.step(abort.signal)
        if (!toolCalls.length) {
          const review = reviewed ? null : this.reviewPrompt()
          if (review) {
            // One nudge per turn: finish the rest, or say plainly what was skipped.
            reviewed = true
            this.push({ role: 'user', content: review, synthetic: 'review' })
            continue
          }
          reason = 'done'
          break
        }
        for (let i = 0; i < toolCalls.length; ) {
          if (abort.signal.aborted) {
            // Every tool call must get a result or the next request is invalid.
            for (const c of toolCalls.slice(i)) this.interrupted(c)
            break
          }
          if (toolCalls[i].name === TASK_TOOL) {
            // Consecutive subagent calls run in parallel.
            let j = i
            while (j < toolCalls.length && toolCalls[j].name === TASK_TOOL) j++
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
          text: `Stopped after ${this.settings.agent.maxStepsPerTurn} steps (Settings → Agent → Max steps). Send "continue" to keep going.`,
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
    return reason
  }

  private unfinishedTodos(): TodoItem[] {
    return (this.session.todos ?? []).filter((t) => t.status !== 'completed')
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

  /** One model request. Appends the assistant message and returns its tool calls. */
  private async step(signal: AbortSignal): Promise<ToolCall[]> {
    const ref = { ...this.model }
    const provider = this.registry.get(ref.providerId)
    const tools = this.activeTools()
    const info = this.registry.cachedModel(ref.providerId, ref.modelId)
    if (info && !info.supportsTools) {
      this.emit({ type: 'notice', level: 'warn', text: `${ref.modelId} doesn't advertise tool support; it may not be able to act.` })
    }

    let content = ''
    let reasoning = ''
    let calls: ToolCall[] = []
    let usage: Usage | undefined
    const retries = this.settings.agent.requestRetries
    for (let attempt = 0; ; attempt++) {
      content = ''
      reasoning = ''
      calls = []
      usage = undefined
      try {
        for await (const ev of provider.chat({
          model: ref.modelId,
          messages: [{ role: 'system', content: this.systemPrompt(tools) }, ...this.session.messages],
          tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
          signal,
          ...this.requestParams(),
        })) {
          if (ev.type === 'text') {
            content += ev.delta
            this.emit(ev)
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta
            this.emit(ev)
          } else if (ev.type === 'tool_call') calls.push(ev.call)
          else if (ev.type === 'usage') usage = ev.usage
        }
        break
      } catch (err) {
        // A reply that broke off midway (overloaded upstream, common on free models) is retried from scratch.
        if (err instanceof ProviderError && err.retryable && !signal.aborted && attempt < retries) {
          this.emit({ type: 'stream_reset' })
          this.emit({ type: 'notice', level: 'info', text: `${err.message} Retrying (${attempt + 1}/${retries})…` })
          await sleep(1000 * 2 ** attempt, signal)
          continue
        }
        // Keep whatever was streamed before the interruption.
        if (content.trim()) this.push({ role: 'assistant', content: content + '\n\n[interrupted]' })
        throw err
      }
    }

    this.push({ role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}), ...(reasoning ? { reasoning } : {}) })
    if (usage) {
      const record = this.recordUsage(ref, usage)
      this.session.lastPromptTokens = usage.promptTokens + usage.completionTokens
      this.emit({
        type: 'usage',
        record,
        summary: this.o.usage.summary(this.usageId),
        contextTokens: this.session.lastPromptTokens,
        contextLength: this.contextLength(),
      })
    }
    return calls
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
      memory: this.memoryOn ? this.o.memory!.scoped(this.session.meta.cwd) : undefined,
      runSubagent: this.o.subagent ? undefined : (input) => this.runSubagent(callId, input, signal),
    }
  }

  /** Subagents count toward their parent chat's usage and budget. */
  private get usageId(): string {
    return this.o.subagent?.parentSessionId ?? this.session.meta.id
  }

  private interrupted(c: ToolCall) {
    this.push({ role: 'tool', toolCallId: c.id, name: c.name, content: 'Interrupted by user before running.' })
  }

  private async runParallel(calls: ToolCall[], signal: AbortSignal) {
    const queue = [...calls]
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        if (signal.aborted) this.interrupted(c)
        else await this.runTool(c, signal)
      }
    }
    const n = Math.min(this.settings.agent.subagents.maxParallel, calls.length)
    await Promise.all(Array.from({ length: n }, worker))
  }

  /** Runs a delegated task in a fresh, unsaved session and returns its final report. */
  private async runSubagent(callId: string, input: SubagentInput, signal: AbortSignal): Promise<ToolResult> {
    const cfg = this.settings.agent.subagents
    const readOnly = input.type === 'explore' || !cfg.allowWrite || this.o.permissions.mode === 'plan'
    const tools = this.tools.filter((t) => t.name !== TASK_TOOL && t.name !== 'todo_write' && (!readOnly || t.readOnly))
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
      memory: this.o.memory,
      subagent: { description: input.description, parentSessionId: this.session.meta.id },
      // Approvals surface in the parent's task card; ids are prefixed to stay unique.
      askPermission: (req) =>
        this.o.askPermission({ ...req, callId: `${callId}/${req.callId}`, reason: `Subagent "${input.description}": ${req.reason}` }),
      onEvent: (e) => {
        if (e.type === 'tool_start' && e.name !== 'todo_write') progress(`→ ${e.name} ${e.subject}\n`)
        else if (e.type === 'tool_end' && e.result.isError) progress(`  ${e.denied ? 'denied' : 'failed'}: ${e.result.content.split('\n')[0].slice(0, 160)}\n`)
        else if (e.type === 'notice') progress(`  ${e.text}\n`)
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
    }
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<void> {
    // Reset after approval so durations measure execution, not time spent waiting for the user.
    let started = Date.now()
    let label = ''
    const finish = (result: ToolResult, denied = false) => {
      // Only failures of real work count (not malformed calls), and a later success of the same call clears them.
      if (label) {
        const key = `${call.name} ${label.slice(0, 120)}`
        if (result.isError && !denied) this.failedCalls.push(key)
        else if (!result.isError) this.failedCalls = this.failedCalls.filter((f) => f !== key)
      }
      if (result.display) (this.session.displays ??= {})[call.id] = result.display
      if (denied) (this.session.denied ??= []).push(call.id)
      this.emit({ type: 'tool_end', callId: call.id, name: call.name, result, durationMs: Date.now() - started, denied })
      this.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.isError && !denied ? `Error: ${result.content}` : result.content,
      })
    }

    const tool = this.activeTools().find((t) => t.name === call.name)
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
    let input: unknown
    try {
      input = tool.parse(raw)
    } catch (e) {
      this.emit({ type: 'tool_start', callId: call.id, name: call.name, subject: '', input: raw })
      return finish({ content: (e as Error).message, isError: true })
    }
    const subject = tool.subject(input)
    label = subject
    this.emit({ type: 'tool_start', callId: call.id, name: call.name, subject, input })

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
    try {
      finish(await tool.execute(input, this.toolContext(call.id, signal)))
    } catch (e) {
      finish({ content: signal.aborted ? 'Interrupted by user.' : (e as Error).message, isError: true })
    }
  }

  private async maybeCompact(signal: AbortSignal) {
    if (!this.settings.agent.compactionEnabled) return
    const used = this.session.lastPromptTokens ?? estimateTokens(this.session.messages)
    if (used < this.contextLength() * this.settings.agent.compactionThreshold) return
    this.emit({ type: 'notice', level: 'info', text: 'Context is getting full. Summarizing older messages…' })
    await this.compact(signal)
  }

  /** Summarize older history into one message. Safe to call manually (e.g. a /compact command). */
  async compact(signal?: AbortSignal): Promise<boolean> {
    const split = compactionSplit(this.session.messages)
    if (split <= 0) return false
    const ref = this.settings.models.compaction ?? this.model
    const provider = this.registry.get(ref.providerId)
    const old = this.session.messages.slice(0, split)
    const { summary, usage } = await summarize(provider, ref.modelId, old, signal)
    if (usage) this.recordUsage(ref, usage)
    if (!summary) return false
    this.session.messages = [
      { role: 'user', content: `[Summary of the earlier conversation]\n\n${summary}` },
      { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' },
      ...this.session.messages.slice(split),
    ]
    this.session.lastPromptTokens = undefined
    this.emit({ type: 'compacted', removedMessages: split })
    this.save()
    return true
  }
}
