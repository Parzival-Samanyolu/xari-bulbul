import type { ChatMessage, ImageAttachment, ModelInfo, ToolCall, Usage } from '../types.js'
import type { ProviderConfig } from '../settings/schema.js'
import { backoff, inputProgress, sleep, withStallGuard } from './http.js'
import { readSseData } from './sse.js'
import { userText } from './openai-compat.js'
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from './types.js'
import { openAIEffort, providerKind } from './effort.js'
import { openaiCost, openaiPricing } from './prices.js'

/** Where users review and limit what apps spend from their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

/** Error codes the UI acts on. */
export const USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded'
export const SIGN_IN_AGAIN_CODE = 'chatgpt_sign_in_again'

export interface OpenAIResponsesOptions {
  config: ProviderConfig
  /** A valid access token, refreshed when needed. Throws when the user must sign in again. */
  token: () => Promise<string>
  retries?: number
  /** Injected for tests. */
  fetch?: typeof fetch
}

/**
 * OpenAI's Responses API, used for requests paid by the user's ChatGPT plan ("Sign in with
 * ChatGPT" for open-source apps). The route takes `store: false` + `stream: true` only, rejects
 * system-role items, `temperature`, `max_output_tokens` and `previous_response_id`, so history
 * is sent in full each time and reasoning items travel back with their encrypted content.
 */
export class OpenAIResponsesProvider implements Provider {
  readonly id: string
  readonly name: string
  private readonly config: ProviderConfig
  private readonly token: () => Promise<string>
  private readonly retries: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: OpenAIResponsesOptions) {
    this.config = opts.config
    this.id = opts.config.id
    this.name = opts.config.name
    this.token = opts.token
    this.retries = opts.retries ?? 3
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private url(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, '') + path
  }

  private async headers(): Promise<Record<string, string>> {
    return { 'content-type': 'application/json', ...this.config.headers, authorization: `Bearer ${await this.token()}` }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request(this.url('/models'), { method: 'GET', signal })
    const json = (await res.json()) as { models?: RawModel[]; data?: { id: string }[] }
    if (json.models) {
      return json.models
        .filter((m) => m.slug && (m.visibility ?? 'list') === 'list')
        .map((m) => toModelInfo(this.id, m.slug, m.display_name, m.max_context_window ?? m.context_window))
    }
    return (json.data ?? []).map((m) => toModelInfo(this.id, m.id))
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    yield* withStallGuard(this.name, req.model, 0, req.signal, (signal) => this.stream({ ...req, signal }))
  }

  /** The request body, exported for tests through `responsesBody`. */
  body(req: ChatRequest): Record<string, unknown> {
    return responsesBody(req, providerKind(this.config))
  }

  private async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const res = await this.request(this.url('/responses'), { method: 'POST', body: JSON.stringify(this.body(req)), signal: req.signal })
    if (!res.body) throw new ProviderError('Empty response body from ChatGPT')

    const calls: ToolCall[] = []
    const reasoning: Record<string, unknown>[] = []
    const argChars = new Map<string, number>()
    const callNames = new Map<string, string>()
    let reported = 0
    let usage: Usage | undefined
    let finish: string | undefined

    for await (const data of readSseData(res.body)) {
      let ev: RawEvent
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) yield { type: 'text', delta: ev.delta }
          break
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (ev.delta) yield { type: 'reasoning', delta: ev.delta }
          break
        case 'response.reasoning_summary_part.added':
          // Summaries come in parts; keep them apart in the shown reasoning.
          if ((ev.summary_index ?? 0) > 0) yield { type: 'reasoning', delta: '\n\n' }
          break
        case 'response.output_item.added':
          if (ev.item?.type === 'function_call' && ev.item.id) callNames.set(ev.item.id, ev.item.name ?? '')
          break
        case 'response.function_call_arguments.delta': {
          const key = ev.item_id ?? ''
          const chars = (argChars.get(key) ?? 0) + (ev.delta?.length ?? 0)
          argChars.set(key, chars)
          if (inputProgress(chars, reported)) {
            reported = chars
            yield { type: 'tool_input', name: callNames.get(key) ?? '', chars }
          }
          break
        }
        case 'response.output_item.done': {
          const item = ev.item
          if (item?.type === 'function_call') {
            calls.push({ id: item.call_id || item.id || `call_${Date.now().toString(36)}_${calls.length}`, name: item.name ?? '', arguments: item.arguments ?? '' })
          } else if (item?.type === 'reasoning') {
            const { id: _id, status: _status, ...rest } = item
            reasoning.push(rest)
          }
          break
        }
        case 'response.completed':
          usage = toUsage(ev.response?.usage)
          finish = calls.length ? 'tool_calls' : 'stop'
          break
        case 'response.incomplete': {
          usage = toUsage(ev.response?.usage)
          const why = ev.response?.incomplete_details?.reason
          if (why === 'max_output_tokens') finish = 'length'
          else throw new ProviderError(`ChatGPT stopped the reply early (${why ?? 'incomplete'}).`)
          break
        }
        case 'response.failed':
          throw responseError(ev.response?.error)
        case 'error':
          throw responseError({ code: ev.code, message: ev.message, param: ev.param })
      }
    }
    // Usage-limit errors can arrive mid-stream; a reply only counts once it says it's complete.
    if (!finish) throw new ProviderError('The connection to ChatGPT ended before the reply was complete.', undefined, true)

    for (const call of calls) yield { type: 'tool_call', call }
    if (reasoning.length) yield { type: 'extra', extra: { openaiResponses: { reasoning } } }
    if (usage) {
      const apiCost = openaiCost(req.model, usage)
      yield { type: 'usage', usage: apiCost === undefined ? usage : { ...usage, apiCost } }
    }
    yield { type: 'finish', reason: finish }
  }

  /** fetch with the access token, retrying network errors, 408, 5xx and plain rate limits (not plan limits). */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0
    while (true) {
      let headers: Record<string, string>
      try {
        headers = await this.headers()
      } catch (err) {
        // Signed out, plan use off, or the sign-in couldn't be renewed: nothing to retry here.
        if (err instanceof ProviderError) throw err
        // A renewal that failed on the network is worth another try; a sign-in that ended isn't.
        const ended = (err as { kind?: string }).kind === 'sign_in_again'
        throw new ProviderError((err as Error).message, ended ? 401 : undefined, !ended, undefined, ended ? SIGN_IN_AGAIN_CODE : undefined)
      }
      let res: Response
      try {
        res = await this.fetchImpl(url, { ...init, headers })
      } catch (err) {
        if (init.signal?.aborted) throw err
        if (attempt++ >= this.retries) throw new ProviderError(`Network error: ${(err as Error).message}`)
        await sleep(backoff(attempt), init.signal)
        continue
      }
      if (res.ok) return res
      const text = await res.text().catch(() => '')
      const err = httpError(res.status, text)
      const retryAfter = Number(res.headers.get('retry-after'))
      if (err.retryable && attempt++ < this.retries) {
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), init.signal)
        continue
      }
      throw err
    }
  }
}

/** Build the Responses request: system messages become `instructions`, the rest `input` items. */
export function responsesBody(req: ChatRequest, kind: ReturnType<typeof providerKind> = 'openai'): Record<string, unknown> {
  const instructions = req.messages
    .filter((m): m is Extract<ChatMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const body: Record<string, unknown> = {
    model: req.model,
    ...(instructions ? { instructions } : {}),
    input: responsesInput(req.messages),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }))
    body.parallel_tool_calls = true
  }
  if (req.reasoningEffort) body.reasoning = { effort: openAIEffort(kind, req.reasoningEffort), summary: 'auto' }
  return body
}

export function responsesInput(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let images: ImageAttachment[] = []
  messages.forEach((m, i) => {
    switch (m.role) {
      case 'system':
        break
      case 'user': {
        const text = userText(m)
        out.push({
          role: 'user',
          content: [...(text ? [{ type: 'input_text', text }] : []), ...(m.images ?? []).map(imagePart)],
        })
        break
      }
      case 'assistant': {
        const stored = (m.extra?.openaiResponses as { reasoning?: Record<string, unknown>[] } | undefined)?.reasoning
        if (stored?.length) out.push(...stored)
        if (m.content) out.push({ role: 'assistant', content: m.content })
        for (const c of m.toolCalls ?? []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments || '{}' })
        break
      }
      case 'tool':
        out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
        if (m.images?.length) images.push(...m.images)
        break
    }
    // A tool's images follow the round's results as a user message, as with chat completions.
    if (images.length && messages[i + 1]?.role !== 'tool') {
      const text = images.length > 1 ? 'Images returned by the tool calls above.' : 'Image returned by the tool call above.'
      out.push({ role: 'user', content: [{ type: 'input_text', text }, ...images.map(imagePart)] })
      images = []
    }
  })
  return out
}

const imagePart = (i: ImageAttachment) => ({ type: 'input_image', image_url: `data:${i.mediaType};base64,${i.data}` })

interface RawError {
  code?: string | null
  message?: string | null
  param?: string | null
}

/** Plain words for the errors this route documents. */
function explain(code: string | undefined, message: string | undefined, param: string | undefined, status?: number): ProviderError {
  switch (code) {
    case USAGE_LIMIT_CODE:
      return new ProviderError(`ChatGPT usage limit reached. Review your plan or this app's limit at ${CHATGPT_USAGE_URL}.`, 429, false, undefined, code)
    case 'subscription_sharing_user_not_eligible':
      return new ProviderError('This ChatGPT plan or workspace can’t be used in other apps.', 403, false, undefined, code)
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ProviderError('ChatGPT couldn’t check your plan usage right now. Try again shortly.', 503, true, undefined, code)
    case 'subscription_sharing_unsupported_capability':
      return new ProviderError(`ChatGPT plan requests don’t support ${param ? `“${param}”` : 'part of this request'}${message ? `: ${message}` : ''}.`, 400, false, undefined, code)
    case 'subscription_sharing_invalid_user':
      return new ProviderError('ChatGPT didn’t accept this sign-in. Sign in to ChatGPT again in Settings › Providers.', 401, false, undefined, SIGN_IN_AGAIN_CODE)
  }
  const text = message || 'unknown error'
  if (status === 401) return new ProviderError(`ChatGPT didn’t accept this sign-in (${text}). Sign in to ChatGPT again in Settings › Providers.`, 401, false, undefined, SIGN_IN_AGAIN_CODE)
  const retryable = status == null || status === 408 || status === 429 || status >= 500
  return new ProviderError(`ChatGPT error${status ? ` ${status}` : ''}: ${text}`, status, retryable, undefined, code)
}

function responseError(e: RawError | null | undefined): ProviderError {
  return explain(e?.code ?? undefined, e?.message ?? undefined, e?.param ?? undefined)
}

/** Errors before a stream opens may carry `{error: {...}}` or just `{detail: "..."}`. */
function httpError(status: number, text: string): ProviderError {
  let code: string | undefined
  let message: string | undefined
  let param: string | undefined
  try {
    const j = JSON.parse(text) as { error?: RawError | string; detail?: unknown; message?: string }
    if (j.error && typeof j.error === 'object') {
      code = j.error.code ?? undefined
      message = j.error.message ?? undefined
      param = j.error.param ?? undefined
    } else if (typeof j.error === 'string') message = j.error
    else if (typeof j.detail === 'string') message = j.detail
    else message = j.message
  } catch {
    message = text.slice(0, 500) || undefined
  }
  return explain(code, message, param, status)
}

interface RawModel {
  slug: string
  display_name?: string
  visibility?: string
  /** The default window; the model accepts up to `max_context_window`. */
  context_window?: number
  max_context_window?: number
}

function toModelInfo(providerId: string, id: string, name?: string, contextLength?: number): ModelInfo {
  // Plan usage has no per-token price: nothing here is free or priced. The API price is shown for comparison.
  const apiPricing = openaiPricing(id)
  return { id, name: name || id, providerId, contextLength, free: false, supportsTools: true, ...(apiPricing && { apiPricing }) }
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

function toUsage(u: RawUsage | undefined): Usage | undefined {
  if (!u) return undefined
  return { promptTokens: u.input_tokens ?? 0, completionTokens: u.output_tokens ?? 0, cachedTokens: u.input_tokens_details?.cached_tokens }
}

interface RawItem {
  type?: string
  id?: string
  status?: string
  call_id?: string
  name?: string
  arguments?: string
  [k: string]: unknown
}

interface RawEvent {
  type?: string
  delta?: string
  item_id?: string
  summary_index?: number
  item?: RawItem
  code?: string
  message?: string
  param?: string
  response?: {
    usage?: RawUsage
    error?: RawError | null
    incomplete_details?: { reason?: string } | null
  }
}
