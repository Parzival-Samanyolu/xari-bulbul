import type { AgentEvent, TurnEndReason } from '../loop/agent.js'
import { failoverKind, failureLabel, fallbackChain, ProviderUnavailableError, shortModelName } from '../loop/fallback.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { ProviderError, type ChatRequest, type Provider } from '../providers/types.js'
import type { Session } from '../sessions/store.js'
import { modelKey, type Bot, type Lobby, type Settings } from '../settings/schema.js'
import type { ChatMessage, ModelRef, Usage } from '../types.js'
import { computeCost, type UsageRecord, type UsageSummary } from '../usage/tracker.js'
import { LOBBY_ALL_ANSWER, LOBBY_CAST, lobbySpeakers } from './bots.js'

// Lobbies: group chats where several bots talk with the user and with each other. Replies are
// chat only (no tools), one bot at a time. The pure helpers below decide who speaks and what
// each bot sees; `LobbyChat` runs the turns.

/** How the user is labeled in the transcript the bots see. */
export const LOBBY_USER = 'You'

/** What a bot replies to stay quiet. */
export const LOBBY_PASS = '[pass]'

/** Lines of the transcript a bot sees: the latest ones, so long lobbies stay cheap. */
export const LOBBY_WINDOW = 60

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `name` as a whole word: not inside a longer word (letters and digits in any script). */
const word = (name: string) => `(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`

/**
 * The bots a message speaks to, in the order they're first named: `@Name`, `@First` (a name's
 * first word) or the full name as a word. Empty when it names nobody, so everyone may answer.
 */
export function addressedBots(text: string, members: Bot[]): Bot[] {
  const hits: { bot: Bot; at: number }[] = []
  for (const bot of members) {
    const name = bot.name.trim()
    if (!name) continue
    const first = name.split(/\s+/)[0]
    const patterns = [word(name), `@${escape(first)}(?![\\p{L}\\p{N}_])`]
    let at = -1
    for (const p of patterns) {
      const m = new RegExp(p, 'iu').exec(text)
      if (m && (at < 0 || m.index < at)) at = m.index
    }
    if (at >= 0) hits.push({ bot, at })
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.bot)
}

/** A speaker's name: the bot's current one, else the name it had when it spoke. */
function speakerName(m: Extract<ChatMessage, { role: 'assistant' }>, bots: Bot[]): string {
  const id = m.speaker?.id
  return bots.find((b) => b.id === id)?.name.trim() || m.speaker?.name || 'Someone'
}

/**
 * The transcript as `self` sees it: its own lines are assistant messages; the user's and the
 * other bots' lines are user messages with `[Name]: ` in front, merged so roles alternate.
 */
export function lobbyTranscript(messages: ChatMessage[], self: Pick<Bot, 'id'>, bots: Bot[], window = LOBBY_WINDOW): ChatMessage[] {
  const out: ChatMessage[] = []
  const add = (role: 'user' | 'assistant', content: string) => {
    const last = out.at(-1)
    if (last && last.role === role) last.content += `\n\n${content}`
    else out.push({ role, content })
  }
  const lines = messages.filter((m) => (m.role === 'user' && !m.synthetic) || (m.role === 'assistant' && m.content.trim()))
  for (const m of lines.slice(-window)) {
    if (m.role === 'user') add('user', `[${LOBBY_USER}]: ${m.content}`)
    else if (m.role === 'assistant') {
      if (m.speaker?.id === self.id) add('assistant', m.content)
      else add('user', `[${speakerName(m, bots)}]: ${m.content}`)
    }
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(The group chat started.)' })
  if (!out.length || out.at(-1)!.role === 'assistant') add('user', '(Nobody has said anything since your last line.)')
  return out
}

/**
 * A bot's reply as it goes into the transcript: without its own name label, cut where it starts
 * writing someone else's lines, and without `[pass]`. Empty means it passed.
 */
export function cleanReply(text: string, self: Pick<Bot, 'name'>, bots: Bot[]): string {
  let s = text.trim()
  const own = escape(self.name.trim() || 'Bot')
  // "[Ali]: …", "Ali: …", "**Ali:** …" at the start.
  s = s.replace(new RegExp(`^(?:\\*\\*)?\\[?${own}\\]?(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*`, 'iu'), '')
  const others = [LOBBY_USER, ...bots.map((b) => b.name.trim()).filter((n) => n && n.toLowerCase() !== self.name.trim().toLowerCase())]
  if (others.length) {
    const label = new RegExp(`^\\s*(?:\\*\\*)?\\[?(?:${others.map(escape).join('|')})\\]?(?:\\*\\*)?\\s*:`, 'imu')
    const m = label.exec(s)
    // A label further down: the bot began writing the others' lines. Keep only its own part.
    if (m && m.index > 0) s = s.slice(0, m.index)
    else if (m) s = ''
  }
  return s
    .replace(/\[\s*pass\s*\]/gi, '')
    .trim()
}

/** True when a reply (as streamed so far) could still turn out to be just `[pass]`. */
function maybePass(text: string): boolean {
  const t = text.trimStart().toLowerCase()
  return t.length < LOBBY_PASS.length ? LOBBY_PASS.startsWith(t) : t.startsWith(LOBBY_PASS) && !t.slice(LOBBY_PASS.length).trim()
}

/** A bot's system prompt in a lobby: its persona, then who's in the room and how to talk there. */
export function lobbySystemPrompt(self: Bot, lobby: Pick<Lobby, 'name'>, members: Bot[], profile?: { name?: string; language?: string }): string {
  const name = self.name.trim() || 'Bot'
  const lines = [
    `# Character: ${name}`,
    `You are "${name}", a character in Xarı Bülbül, an app where the user chats with characters they made. Stay in character: the personality below sets your voice, humor and style. If asked what you are, you are ${name}, a character running on the selected model.`,
  ]
  if (self.persona.trim()) lines.push(`## Personality\n${self.persona.trim()}`)
  const others = members.filter((b) => b.id !== self.id)
  const who = [
    `- ${LOBBY_USER}: the user${profile?.name?.trim() ? ` (${profile.name.trim()})` : ''}`,
    ...others.map((b) => `- ${b.name.trim() || 'Bot'}${b.tagline.trim() ? `: ${b.tagline.trim()}` : ''}`),
  ]
  lines.push(
    `## Group chat "${lobby.name.trim() || 'Lobby'}"
This is a group chat. In the room with you:
${who.join('\n')}

The transcript labels each line with its speaker, like "[${others[0]?.name.trim() || 'Ali'}]: …" and "[${LOBBY_USER}]: …". Your own earlier lines are yours.
- Keep replies short and conversational: 1–4 sentences, unless someone asks for more.
- Speak only as yourself. Never write lines for anyone else, and don't start your reply with your name or a label.
- Address the others by name when you talk to them, and react to what they said.
- If you have nothing to add, reply with exactly ${LOBBY_PASS} and nothing else.
- Group chats end on their own, like real ones. Once the user's message is answered and the banter has run its course, or you'd only repeat yourself or someone else, reply ${LOBBY_PASS}. Don't keep the chat going just to fill the silence, and don't ask new questions only to get another reply.
- There are no tools here: just talk.`,
  )
  if (profile?.language?.trim()) lines.push(`Reply in ${profile.language.trim()}.`)
  return lines.join('\n\n')
}

/** Bot lines since the user last spoke after which the bots are asked to wrap up. */
export const LOBBY_WRAP_UP = 6

/**
 * A note for the bot about to speak, by how long the bots have talked since the user's last line:
 * nothing while it answers the user, then "only if it's new", then "wrap up".
 */
export function windDownNote(messages: ChatMessage[]): string {
  let since = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.synthetic) break
    if (m.role === 'assistant' && m.content.trim()) since++
  }
  const replied = messages.some((m) => m.role === 'user' && !m.synthetic)
  if (!replied || since === 0) return ''
  if (since < LOBBY_WRAP_UP) return `(The group has said ${since} ${since === 1 ? 'line' : 'lines'} since the user's last message. Reply only if you add something new or someone spoke to you directly; otherwise reply ${LOBBY_PASS}.)`
  return `(The group has talked for ${since} lines since the user's last message. Time to wind down: at most one short closing line with no new questions, or ${LOBBY_PASS}.)`
}

/** The bot who spoke last, if the transcript ends with a bot's line. */
export function lastSpeaker(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.synthetic) return undefined
    if (m.role === 'assistant' && m.content.trim()) return m.speaker?.id
  }
  return undefined
}

/**
 * Who takes the next round: everyone in a small lobby. In a big one, up to `LOBBY_CAST` bots: the
 * ones the latest line names (not its own speaker), then whoever has been quiet longest, so the
 * room rotates instead of all of them answering every line.
 */
export function pickCast(messages: ChatMessage[], members: Bot[], size = LOBBY_CAST): Bot[] {
  if (members.length <= LOBBY_ALL_ANSWER) return members
  const lines = messages.filter((m) => (m.role === 'user' && !m.synthetic) || (m.role === 'assistant' && m.content.trim()))
  const last = lines.at(-1)
  const lastBy = last?.role === 'assistant' ? last.speaker?.id : undefined
  const named = last ? addressedBots(last.content, members).filter((b) => b.id !== lastBy) : []
  const spokeAt = new Map<string, number>()
  lines.forEach((m, i) => m.role === 'assistant' && m.speaker?.id && spokeAt.set(m.speaker.id, i))
  const quiet = members
    .map((b, order) => ({ b, at: spokeAt.get(b.id) ?? -1, order }))
    .sort((x, y) => x.at - y.at || x.order - y.order)
    .map((x) => x.b)
    .filter((b) => b.id !== lastBy)
  const cast: Bot[] = []
  for (const b of [...named, ...quiet]) if (cast.length < size && !cast.includes(b)) cast.push(b)
  return cast
}

/** The transcript with `note` added to its last (user) message. */
function withNote(transcript: ChatMessage[], note: string): ChatMessage[] {
  const last = transcript.at(-1)
  if (!note || !last || last.role !== 'user') return transcript
  return [...transcript.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }]
}

// ---------------------------------------------------------------- running a lobby

export interface LobbyChatOptions {
  session: Session
  settings: Settings
  registry: Pick<ProviderRegistry, 'has' | 'get' | 'cachedModel' | 'models'>
  usage: { record(r: UsageRecord): void; summary(sessionId?: string): UsageSummary }
  onEvent: (e: AgentEvent) => void
  /** Called whenever the transcript changes and should be persisted. */
  onSave?: (session: Session) => void
}

type TurnResult = 'spoke' | 'passed' | 'failed' | 'aborted'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })
}

/**
 * One lobby's transcript and its running turns. `send` posts the user's line; the bots it names
 * (or everyone, or in a big lobby a cast of `LOBBY_CAST`) answer in order, then they talk among
 * themselves for up to `maxRounds` rounds, each taken by `pickCast`.
 * A round where everyone passes ends it. `stop` aborts the reply streaming now.
 */
export class LobbyChat {
  private abort: AbortController | null = null
  private current: Promise<TurnEndReason> | null = null
  private settings: Settings
  private registry: LobbyChatOptions['registry']
  /** Models that failed in a way another model can fix (not found, no key) during this run. */
  private skipped = new Set<string>()

  constructor(private readonly o: LobbyChatOptions) {
    this.settings = o.settings
    this.registry = o.registry
  }

  get session(): Session {
    return this.o.session
  }

  get running(): boolean {
    return this.abort !== null
  }

  get lobby(): Lobby | undefined {
    return this.settings.lobbies.find((l) => l.id === this.session.meta.lobbyId)
  }

  /** Members that take part now. */
  get members(): Bot[] {
    const lobby = this.lobby
    return lobby ? lobbySpeakers(this.settings, lobby) : []
  }

  updateSettings(settings: Settings): void {
    this.settings = settings
  }

  setRegistry(registry: LobbyChatOptions['registry']): void {
    this.registry = registry
  }

  stop(): void {
    this.abort?.abort(new Error('Stopped by user'))
  }

  /** Resolves once the run in progress (if any) has ended. */
  async idle(): Promise<void> {
    await this.current?.catch(() => undefined)
  }

  /** Posts the user's line; the bots it names answer first (everyone when it names nobody), then they keep talking. */
  async send(text: string): Promise<TurnEndReason> {
    if (this.abort) throw new Error('The lobby is already talking.')
    const t = text.trim()
    if (!t) throw new Error('Nothing to send.')
    const members = this.members
    if (!members.length) throw new Error('No one in this lobby can talk: add bots or turn them on.')
    const first = addressedBots(t, members)
    return this.start(() => this.push({ role: 'user', content: t }), first.length ? first : null, this.lobby?.maxRounds ?? 3, !first.length)
  }

  /** More rounds of the bots talking among themselves. */
  async keepTalking(): Promise<TurnEndReason> {
    if (this.abort) throw new Error('The lobby is already talking.')
    if (!this.session.messages.length) throw new Error('Say something first.')
    if (!this.members.length) throw new Error('No one in this lobby can talk: add bots or turn them on.')
    return this.start(() => {}, null, Math.max(1, this.lobby?.maxRounds ?? 3), false)
  }

  private start(before: () => void, first: Bot[] | null, rounds: number, answer: boolean): Promise<TurnEndReason> {
    const abort = (this.abort = new AbortController())
    this.skipped.clear()
    this.emit({ type: 'turn_start' })
    if (this.session.meta.title === 'New chat' && this.lobby) this.session.meta.title = this.lobby.name
    before()
    const run = this.run(abort.signal, first, answer ? rounds + 1 : rounds, answer).finally(() => {
      this.abort = null
      this.current = null
    })
    this.current = run
    return run.then((reason) => {
      this.emit({ type: 'speaker', botId: null })
      this.emit({ type: 'turn_end', reason })
      return reason
    })
  }

  private async run(signal: AbortSignal, first: Bot[] | null, rounds: number, answer: boolean): Promise<TurnEndReason> {
    let spoke = 0
    let failed = 0
    const take = async (bot: Bot, answering = false): Promise<TurnResult> => {
      const r = await this.turn(bot, signal, answering)
      if (r === 'spoke') spoke++
      else if (r === 'failed') failed++
      return r
    }
    await this.warmModels()
    if (first) {
      for (const bot of first) {
        if (signal.aborted) return 'aborted'
        await take(bot, true)
      }
    }
    // With no one named, the first round is the answer to the user (no one has a last line yet).
    for (let round = 0; round < rounds; round++) {
      let any = false
      for (const bot of pickCast(this.session.messages, this.members)) {
        if (signal.aborted) return 'aborted'
        // Nothing new since its own last line: nothing to react to.
        if (lastSpeaker(this.session.messages) === bot.id) continue
        if ((await take(bot, answer && round === 0)) === 'spoke') any = true
      }
      if (signal.aborted) return 'aborted'
      if (!any) break
    }
    if (signal.aborted) return 'aborted'
    return !spoke && failed ? 'error' : 'done'
  }

  /** Model lists give context sizes and prices; fetch the members' providers once (briefly). */
  private async warmModels(): Promise<void> {
    const ids = new Set(this.members.map((b) => this.modelOf(b).providerId).filter((id) => this.registry.has(id)))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, 5000)))
    await Promise.race([Promise.all([...ids].map((id) => this.registry.models(id).catch(() => undefined))), timeout])
    clearTimeout(timer)
  }

  private modelOf(bot: Bot): ModelRef {
    return bot.model ?? this.settings.models.default
  }

  private emit(e: AgentEvent) {
    this.o.onEvent(e)
  }

  private push(message: ChatMessage) {
    this.session.messages.push(message)
    this.session.meta.updatedAt = Date.now()
    // Saved before the event: listeners re-read the store.
    this.o.onSave?.(this.session)
    this.emit({ type: 'message', message, index: this.session.messages.length - 1 })
  }

  private provider(ref: ModelRef): Provider {
    if (!this.registry.has(ref.providerId)) throw new ProviderUnavailableError(ref.providerId)
    return this.registry.get(ref.providerId)
  }

  private contextLength(ref: ModelRef): number {
    return this.settings.models.overrides[modelKey(ref)]?.contextLength ?? this.registry.cachedModel(ref.providerId, ref.modelId)?.contextLength ?? this.settings.models.defaultContextLength
  }

  private params(ref: ModelRef, bot: Bot): Pick<ChatRequest, 'temperature' | 'maxTokens' | 'reasoningEffort' | 'replayReasoning'> {
    const m = this.settings.models
    const o = m.overrides[modelKey(ref)] ?? {}
    return {
      temperature: o.temperature ?? m.temperature ?? undefined,
      maxTokens: o.maxTokens ?? m.maxTokens ?? undefined,
      reasoningEffort: o.reasoningEffort ?? bot.thinking ?? m.reasoningEffort ?? undefined,
      replayReasoning: o.replayReasoning,
    }
  }

  private recordUsage(ref: ModelRef, usage: Usage) {
    const record: UsageRecord = {
      ts: Date.now(),
      sessionId: this.session.meta.id,
      providerId: ref.providerId,
      modelId: ref.modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens ?? 0,
      cost: computeCost(usage, this.registry.cachedModel(ref.providerId, ref.modelId)?.pricing),
      ...(usage.apiCost != null && { apiCost: usage.apiCost }),
    }
    this.o.usage.record(record)
    this.session.lastPromptTokens = usage.promptTokens + usage.completionTokens
    this.emit({ type: 'usage', record, summary: this.o.usage.summary(this.session.meta.id), contextTokens: this.session.lastPromptTokens, contextLength: this.contextLength(ref) })
  }

  private modelName(ref: ModelRef): string {
    return shortModelName(ref, this.registry.has(ref.providerId) ? this.registry.cachedModel(ref.providerId, ref.modelId)?.name : undefined)
  }

  /** One bot's reply: its model, then the fallbacks. Streams text unless it's passing. */
  private async turn(bot: Bot, signal: AbortSignal, answering = false): Promise<TurnResult> {
    const lobby = this.lobby
    if (!lobby) return 'failed'
    this.emit({ type: 'speaker', botId: bot.id })
    const members = this.members
    const messages: ChatMessage[] = [
      { role: 'system', content: lobbySystemPrompt(bot, lobby, members, this.settings.profile) },
      ...withNote(lobbyTranscript(this.session.messages, bot, this.settings.bots), answering ? '' : windDownNote(this.session.messages)),
    ]
    const main = this.modelOf(bot)
    const chain = fallbackChain(main, this.settings.models.fallbacks, this.skipped)
    if (!chain.length) chain.push(main)
    const speaker = { id: bot.id, name: bot.name.trim() || 'Bot' }
    const retries = this.settings.agent.requestRetries
    for (let i = 0, attempt = 0; ; ) {
      const ref = chain[i]
      let raw = ''
      let reasoning = ''
      let shown = false
      try {
        for await (const ev of this.provider(ref).chat({
          model: ref.modelId,
          messages,
          signal,
          stallMs: this.settings.agent.stallTimeoutSec * 1000,
          ...this.params(ref, bot),
        })) {
          if (ev.type === 'text') {
            raw += ev.delta
            // Held back while it could still be a plain [pass], so a pass never flashes on screen.
            if (shown) this.emit(ev)
            else if (!maybePass(raw)) {
              shown = true
              this.emit({ type: 'text', delta: raw })
            }
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta
            this.emit(ev)
          } else if (ev.type === 'usage') this.recordUsage(ref, ev.usage)
          else if (ev.type === 'status') this.emit({ type: 'notice', level: 'info', text: ev.text })
        }
        if (signal.aborted) throw signal.reason ?? new Error('Stopped')
        const content = cleanReply(raw, bot, this.settings.bots)
        if (!content) {
          this.emit({ type: 'stream_reset' })
          return 'passed'
        }
        this.push({ role: 'assistant', content, speaker, ...(reasoning ? { reasoning } : {}) })
        return 'spoke'
      } catch (err) {
        if (signal.aborted) {
          // Stopped midway: keep what it had said.
          const content = cleanReply(raw, bot, this.settings.bots)
          if (content) this.push({ role: 'assistant', content: `${content}…`, speaker })
          else this.emit({ type: 'stream_reset' })
          return 'aborted'
        }
        // A reply that broke off midway is tried again from scratch.
        if (err instanceof ProviderError && err.retryable && attempt < retries) {
          attempt++
          this.emit({ type: 'stream_reset' })
          this.emit({ type: 'notice', level: 'info', text: `${speaker.name}: ${err.message} Retrying (${attempt}/${retries})…` })
          await sleep(1000 * 2 ** (attempt - 1), signal)
          if (signal.aborted) return 'aborted'
          continue
        }
        const kind = failoverKind(err, signal)
        if (kind === 'skip') this.skipped.add(modelKey(ref))
        const next = kind ? chain.findIndex((c, j) => j > i && (kind !== 'context' || this.contextLength(c) > this.contextLength(ref))) : -1
        this.emit({ type: 'stream_reset' })
        if (next < 0) {
          this.emit({ type: 'notice', level: 'warn', text: `${speaker.name} couldn't reply: ${(err as Error)?.message ?? String(err)}` })
          return 'failed'
        }
        const to = chain[next]
        const why = failureLabel(err)
        this.emit({ type: 'fallback', from: ref, to, reason: why, text: `${speaker.name}: ${this.modelName(ref)} failed (${why}). Continued on ${this.modelName(to)}.` })
        i = next
        attempt = 0
      }
    }
  }
}
