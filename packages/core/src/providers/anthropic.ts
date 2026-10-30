import type { ChatMessage, ModelInfo, ToolCall, Usage } from '../types.js'
import type { ProviderConfig } from '../settings/schema.js'
import { midStreamError, requestWithRetry } from './http.js'
import { userText } from './openai-compat.js'
import { readSseData } from './sse.js'
import { BATCH_STATUS, findJsonl, pollBatch } from './batch.js'
import { ANTHROPIC_FAST_MODELS, anthropicEffort } from './effort.js'
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from './types.js'

export interface AnthropicOptions {
  config: ProviderConfig
  apiKey?: string
  retries?: number
  /** Injected for tests. */
  fetch?: typeof fetch
}

/** Lets the API drop thinking blocks whose earlier history changed (compaction, undo) instead of answering 400. */
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const FAST_MODE_BETA = 'fast-mode-2026-02-01'
/** Models that accept `fallbacks: "default"`: a safety refusal is retried on a fallback model in the same call. */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/

type Block = Record<string, unknown> & { type: string }

/**
 * USD per million tokens: input, output, cache read. Cache writes cost 1.25x input.
 * Anthropic's model list has no prices, so without this the spend and budget limits can't see these requests.
 * Snapshot of the published prices (2026-10); unknown models report no cost.
 */
const PRICES: Record<string, [input: number, output: number, cacheRead: number]> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
}

/** Request cost in USD, or undefined for a model without a known price. */
export function anthropicCost(
  model: string,
  t: { input: number; cacheRead: number; cacheWrite: number; output: number },
  /** 2 for fast mode, 0.5 for batch requests. */
  factor = 1,
): number | undefined {
  let price = PRICES[model.replace(/-\d{8}$/, '')]
  if (!price) return undefined
  // Haiku 5.5 prompts over 100K tokens are billed at the higher tier.
  if (model.startsWith('claude-haiku-5-5') && t.input + t.cacheRead + t.cacheWrite > 100_000) price = [0.5, 2.5, 0.05]
  const [input, output, cacheRead] = price
  return (factor * (t.input * input + t.cacheWrite * input * 1.25 + t.cacheRead * cacheRead + t.output * output)) / 1e6
}

/**
 * Anthropic's native Messages API. Not the OpenAI-compatible endpoint, which has no prompt
 * caching and drops the thinking blocks Claude needs back alongside its tool calls.
 */
export class AnthropicProvider implements Provider {
  readonly id: string
  readonly name: string
  private readonly config: ProviderConfig
  private readonly apiKey?: string
  private readonly retries: number
  private readonly fetchImpl: typeof fetch
  private raw = new Map<string, RawModel>()
  private loading?: Promise<unknown>

  constructor(opts: AnthropicOptions) {
    this.config = opts.config
    this.id = opts.config.id
    this.name = opts.config.name
    this.apiKey = opts.apiKey
    this.retries = opts.retries ?? 3
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private url(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, '') + path
  }

  private headers(betas: string[] = []): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...this.config.headers }
    if (this.apiKey) h['x-api-key'] = this.apiKey
    if (betas.length) h['anthropic-beta'] = betas.join(',')
    return h
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return requestWithRetry(this.fetchImpl, this.name, this.retries, url, init)
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: RawModel[] = []
    let after: string | undefined
    do {
      const q = `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
      const res = await this.request(this.url(`/models${q}`), { method: 'GET', headers: this.headers(), signal })
      const json = (await res.json()) as { data?: RawModel[]; has_more?: boolean; last_id?: string }
      out.push(...(json.data ?? []))
      after = json.has_more && json.last_id ? json.last_id : undefined
    } while (after)
    for (const m of out) this.raw.set(m.id, m)
    return out
      .map((m) => {
        const created = m.created_at ? Date.parse(m.created_at) / 1000 : NaN
        return {
          id: m.id,
          name: m.display_name ?? m.id,
          providerId: this.id,
          contextLength: m.max_input_tokens,
          free: false,
          created: Number.isFinite(created) ? created : undefined,
          supportsTools: true,
          supportsImages: m.capabilities?.image_input?.supported,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Model limits and capabilities, fetched once if the list hasn't been loaded yet. */
  private async modelInfo(id: string, signal?: AbortSignal): Promise<RawModel | undefined> {
    if (!this.raw.has(id)) {
      this.loading ??= this.listModels(signal).catch(() => undefined)
      await this.loading
    }
    return this.raw.get(id)
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.apiKey && this.config.requiresKey) {
      throw new ProviderError(`No API key set for ${this.name}. Add one in Settings › Providers › API keys.`)
    }
    const info = await this.modelInfo(req.model, req.signal)
    const caps = info?.capabilities
    const { system, messages } = toAnthropicMessages(req.messages)
    const betas = [THINKING_BINDING_BETA]
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? Math.min(64_000, info?.max_tokens ?? 64_000),
      messages,
      stream: true,
      // Automatic prompt caching: the whole prefix up to the last block is cached between steps.
      cache_control: { type: 'ephemeral' },
    }
    if (system) body.system = system
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }
    // Capabilities unknown (model list failed): assume a current model.
    if (caps?.thinking?.types?.adaptive?.supported ?? !caps) {
      body.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
    }
    // Only when the user picked one; otherwise the model's own default applies (medium on Opus 5.5).
    if (req.reasoningEffort && (caps?.effort?.supported ?? !caps)) {
      body.output_config = { effort: anthropicEffort(req.model, req.reasoningEffort) }
    }
    const batch = req.speed === 'batch'
    // The Batches API rejects `fallbacks`.
    if (FALLBACK_MODELS.test(req.model) && !batch) {
      body.fallbacks = 'default'
      betas.push(FALLBACK_BETA)
    }
    if (batch) {
      yield { type: 'status', text: BATCH_STATUS }
      return yield* this.parse(req, this.batch(body, betas, req.signal), 0.5)
    }
    let fast = req.speed === 'fast' && ANTHROPIC_FAST_MODELS.test(req.model)

    const send = (retries = this.retries) =>
      requestWithRetry(this.fetchImpl, this.name, retries, this.url('/messages'), {
        method: 'POST',
        headers: this.headers(fast ? [...betas, FAST_MODE_BETA] : betas),
        body: JSON.stringify(fast ? { ...body, speed: 'fast' } : body),
        signal: req.signal,
      })
    // A fast request gets one try: fast mode has its own rate limit, and on a 429 the standard tier may still have room.
    const res = await (fast ? send(0) : send()).catch((e) => {
      if (!fast || !(e instanceof ProviderError && (e.retryable || e.status == null))) throw e
      if (e.status === 429) fast = false
      return send()
    })
    if (!res.body) throw new ProviderError('Empty response body from provider')
    yield* this.parse(req, sseEvents(res.body), () => (fast ? 2 : 1))
  }

  /** Sends one request through Message Batches and replays the finished message as stream events. */
  private async *batch(body: Record<string, unknown>, betas: string[], signal?: AbortSignal): AsyncIterable<RawEvent> {
    const { stream: _, ...params } = body
    const res = await this.request(this.url('/messages/batches'), {
      method: 'POST',
      headers: this.headers(betas),
      body: JSON.stringify({ requests: [{ custom_id: 'step', params }] }),
      signal,
    })
    const created = (await res.json()) as RawBatch
    const ended = await pollBatch(
      async () => {
        const r = await this.request(this.url(`/messages/batches/${created.id}`), { method: 'GET', headers: this.headers(betas), signal })
        const b = (await r.json()) as RawBatch
        return b.processing_status === 'ended' ? b : undefined
      },
      () => this.fetchImpl(this.url(`/messages/batches/${created.id}/cancel`), { method: 'POST', headers: this.headers(betas) }),
      signal,
    )
    const url = ended.results_url ?? this.url(`/messages/batches/${created.id}/results`)
    const text = await (await this.request(url, { method: 'GET', headers: this.headers(betas), signal })).text()
    const row = findJsonl<RawBatchResult>(text, 'step')
    const result = row?.result
    if (result?.type !== 'succeeded' || !result.message) {
      const why = result?.error?.error?.message ?? result?.error?.message ?? result?.type ?? 'no result'
      throw new ProviderError(`${this.name} batch request failed: ${why}`, undefined, result?.type === 'expired')
    }
    yield* messageEvents(result.message)
  }

  private async *parse(req: ChatRequest, events: AsyncIterable<RawEvent>, factor: number | (() => number)): AsyncIterable<StreamEvent> {
    let fast = false
    // Every content block in order, kept verbatim so it can be sent back next step.
    const blocks: Block[] = []
    const json = new Map<number, string>()
    let stopReason = 'end_turn'
    let stopDetails: { explanation?: string } | undefined
    let model = req.model
    const usage: Usage = { promptTokens: 0, completionTokens: 0 }
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    let gotUsage = false

    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start': {
          if (ev.message?.model) model = ev.message.model
          const u = ev.message?.usage
          if (u) {
            gotUsage = true
            tokens.input = u.input_tokens ?? 0
            tokens.cacheRead = u.cache_read_input_tokens ?? 0
            tokens.cacheWrite = u.cache_creation_input_tokens ?? 0
            tokens.output = u.output_tokens ?? 0
            if (u.speed) fast = u.speed === 'fast'
          }
          break
        }
        case 'content_block_start': {
          const b = { ...(ev.content_block ?? { type: 'text' }) } as Block
          if (b.type === 'text') b.text = ''
          if (b.type === 'thinking') (b.thinking = ''), (b.signature = (b.signature as string) ?? '')
          if (b.type === 'tool_use') json.set(ev.index ?? blocks.length, '')
          blocks[ev.index ?? blocks.length] = b
          break
        }
        case 'content_block_delta': {
          const i = ev.index ?? blocks.length - 1
          const b = blocks[i]
          const d = ev.delta ?? {}
          if (!b) break
          if (d.type === 'text_delta' && d.text) {
            b.text = (b.text as string) + d.text
            yield { type: 'text', delta: d.text }
          } else if (d.type === 'thinking_delta' && d.thinking) {
            b.thinking = (b.thinking as string) + d.thinking
            yield { type: 'reasoning', delta: d.thinking }
          } else if (d.type === 'signature_delta' && d.signature) {
            b.signature = ((b.signature as string) ?? '') + d.signature
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            json.set(i, (json.get(i) ?? '') + d.partial_json)
          }
          break
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
          if (ev.delta?.stop_details) stopDetails = ev.delta.stop_details
          if (ev.usage?.output_tokens != null) {
            gotUsage = true
            tokens.output = ev.usage.output_tokens
          }
          break
        }
        case 'error': {
          const t = ev.error?.type
          const code = t === 'overloaded_error' ? 529 : t === 'rate_limit_error' ? 429 : t === 'api_error' ? 500 : 400
          throw midStreamError(this.name, ev.error?.message, code)
        }
      }
    }

    if (stopReason === 'refusal') {
      const why = stopDetails?.explanation ? ` ${stopDetails.explanation}` : ''
      throw new ProviderError(`${this.name}: the model declined this request.${why}`, undefined, false)
    }

    const calls: ToolCall[] = []
    const content = blocks.filter(Boolean).map((b, i) => {
      if (b.type !== 'tool_use') return b
      const args = json.get(i) || '{}'
      calls.push({ id: b.id as string, name: b.name as string, arguments: args })
      return { ...b, input: parseArgs(args) }
    })
    for (const call of calls) yield { type: 'tool_call', call }
    if (gotUsage) {
      usage.promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
      usage.completionTokens = tokens.output
      if (tokens.cacheRead) usage.cachedTokens = tokens.cacheRead
      const cost = anthropicCost(req.model, tokens, fast ? 2 : typeof factor === 'number' ? factor : factor())
      if (cost != null) usage.cost = cost
      yield { type: 'usage', usage }
    }
    yield { type: 'extra', extra: { anthropic: { model, content } } }
    yield { type: 'finish', reason: stopReason }
  }
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<RawEvent> {
  for await (const data of readSseData(body)) {
    try {
      yield JSON.parse(data) as RawEvent
    } catch {
      // keep-alive or junk
    }
  }
}

/** A finished (non-streamed) message as the events a stream of it would have carried. */
export function* messageEvents(m: RawMessage): Iterable<RawEvent> {
  yield { type: 'message_start', message: { model: m.model, usage: m.usage } }
  for (const [index, b] of (m.content ?? []).entries()) {
    if (b.type === 'text') {
      yield { type: 'content_block_start', index, content_block: { ...b, text: '' } }
      yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text as string } }
    } else if (b.type === 'thinking') {
      yield { type: 'content_block_start', index, content_block: { ...b, thinking: '', signature: '' } }
      yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking as string } }
      yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature as string } }
    } else if (b.type === 'tool_use') {
      yield { type: 'content_block_start', index, content_block: { ...b, input: {} } }
      yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } }
    } else yield { type: 'content_block_start', index, content_block: b }
  }
  yield { type: 'message_delta', delta: { stop_reason: m.stop_reason ?? 'end_turn', stop_details: m.stop_details ?? undefined }, usage: { output_tokens: m.usage?.output_tokens } }
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

/**
 * Engine messages → Messages API turns. The first system message becomes `system`;
 * consecutive same-role turns merge, so a round's tool results share one user message.
 */
export function toAnthropicMessages(msgs: ChatMessage[]): { system?: string; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  let system: string | undefined
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const add = (role: 'user' | 'assistant', content: Block[]) => {
    if (!content.length) return
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...content)
    else out.push({ role, content })
  }
  for (const m of msgs) {
    switch (m.role) {
      case 'system':
        // Later system messages (none today) are passed as user text so nothing is lost.
        if (system == null) system = m.content
        else add('user', [{ type: 'text', text: m.content }])
        break
      case 'user': {
        const text = userText(m)
        add('user', [
          ...(m.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
          ...(text.trim() ? [{ type: 'text', text }] : []),
        ])
        break
      }
      case 'assistant': {
        const stored = (m.extra?.anthropic as { content?: Block[] } | undefined)?.content
        if (stored?.length) {
          add('assistant', stored)
          break
        }
        const blocks: Block[] = [
          ...(m.content.trim() ? [{ type: 'text', text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments || '{}') })),
        ]
        add('assistant', blocks.length ? blocks : [{ type: 'text', text: '(no reply)' }])
        break
      }
      case 'tool':
        add('user', [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.images?.length
              ? [{ type: 'text', text: m.content || '(no output)' }, ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))]
              : m.content || '(no output)',
          },
        ])
        break
    }
  }
  return { system, messages: out }
}

interface RawModel {
  id: string
  display_name?: string
  created_at?: string
  max_input_tokens?: number
  max_tokens?: number
  capabilities?: {
    image_input?: { supported?: boolean }
    thinking?: { supported?: boolean; types?: { adaptive?: { supported?: boolean } } }
    effort?: { supported?: boolean }
  }
}

interface RawEvent {
  type: string
  index?: number
  message?: {
    model?: string
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; speed?: string }
  }
  content_block?: Block
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
    stop_details?: { explanation?: string }
  }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

interface RawMessage {
  model?: string
  content?: Block[]
  stop_reason?: string
  stop_details?: { explanation?: string } | null
  usage?: NonNullable<RawEvent['message']>['usage']
}

interface RawBatch {
  id: string
  processing_status?: 'in_progress' | 'canceling' | 'ended'
  results_url?: string | null
}

interface RawBatchResult {
  custom_id?: string
  result?: {
    type: 'succeeded' | 'errored' | 'canceled' | 'expired'
    message?: RawMessage
    error?: { message?: string; error?: { message?: string } }
  }
}
