import type { ChatMessage, ModelInfo, ToolCall, Usage } from '../types.js'
import type { ProviderConfig } from '../settings/schema.js'
import { midStreamError, requestWithRetry } from './http.js'
import { readSseData } from './sse.js'
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from './types.js'
import { BATCH_STATUS, findJsonl, pollBatch } from './batch.js'
import { openAIEffort, providerKind } from './effort.js'

export interface OpenAICompatOptions {
  config: ProviderConfig
  apiKey?: string
  retries?: number
  /** Injected for tests. */
  fetch?: typeof fetch
}

/**
 * One adapter for every OpenAI-compatible API (OpenRouter, Ollama Cloud, and any
 * custom provider). Hand-written on purpose: streaming, tool-call assembly, usage.
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string
  readonly name: string
  private readonly config: ProviderConfig
  private readonly apiKey?: string
  private readonly retries: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: OpenAICompatOptions) {
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

  private isOpenAI(): boolean {
    return /^https:\/\/api\.openai\.com\//.test(this.config.baseUrl)
  }

  /** Hosts whose model lists mix chat models with embedding, safety, OCR and speech models. */
  private isMixedList(): boolean {
    return /^https:\/\/(integrate\.api\.nvidia\.com|api\.mistral\.ai|api\.groq\.com)\//.test(this.config.baseUrl)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.config.headers }
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    return h
  }

  unavailable(modelId: string): boolean {
    return !!UNAVAILABLE.get(this.config.baseUrl)?.has(modelId)
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request(this.url('/models'), { method: 'GET', headers: this.headers(), signal })
    const json = (await res.json()) as { data?: RawModel[] }
    return (json.data ?? [])
      .filter((m) => !this.isOpenAI() || !NON_CHAT_OPENAI.test(m.id))
      .filter((m) => !this.isMixedList() || !NON_CHAT_MIXED.test(m.id))
      .flatMap((m) => {
        // Google lists `models/gemini-3.5-flash` next to embedding, image, video and audio models,
        // and still lists Gemini 2.x, which answers 404 "no longer available to new users".
        if (!m.id.startsWith('models/')) return [m]
        const id = m.id.slice('models/'.length)
        return NON_CHAT_GOOGLE.test(id) || RETIRED_GOOGLE.test(id) ? [] : [{ ...m, id, name: m.name ?? id }]
      })
      .filter((m) => !this.unavailable(m.id))
      .map((m) => toModelInfo(this.id, m))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    // Free tiers (NVIDIA's especially) can queue a request forever; give up when nothing arrives for a while.
    // Not for local servers, which may spend minutes loading a model, or OpenAI, whose reasoning models think silently.
    const stallMs = this.config.requiresKey && !this.isOpenAI() ? (req.stallMs ?? 0) : 0
    if (!stallMs) return yield* this.stream(req, () => {})
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort(req.signal?.reason)
    if (req.signal?.aborted) onAbort()
    req.signal?.addEventListener('abort', onAbort, { once: true })
    let stalled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => ((stalled = true), ctrl.abort()), stallMs)
    }
    try {
      touch()
      yield* this.stream({ ...req, signal: ctrl.signal }, touch)
    } catch (e) {
      if (!stalled || req.signal?.aborted) throw e
      throw new ProviderError(`${this.name} sent nothing for ${Math.round(stallMs / 1000)}s on ${req.model}; it may be queued or overloaded. Try another model.`, 408)
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** `touch` is called whenever bytes arrive, to reset the stall timer. */
  private async *stream(req: ChatRequest, touch: () => void): AsyncIterable<StreamEvent> {
    if (!this.apiKey && this.config.requiresKey) {
      throw new ProviderError(`No API key set for ${this.name}. Add one in Settings → Providers & Keys.`)
    }
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wireMessages(req.messages, req.replayReasoning ?? !this.isOpenAI()),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    if (req.temperature != null) body.temperature = req.temperature
    // OpenAI's reasoning models reject `max_tokens`.
    if (req.maxTokens != null) body[this.isOpenAI() ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
    const kind = providerKind(this.config)
    if (req.reasoningEffort) body.reasoning_effort = openAIEffort(kind, req.reasoningEffort)
    if (req.speed === 'fast' && kind === 'openai') body.service_tier = 'priority'
    if (req.speed === 'fast' && kind === 'openrouter') body.provider = { sort: 'throughput' }
    if (this.config.requestUsageCost) body.usage = { include: true }
    const batch = req.speed === 'batch' && kind === 'openai'
    if (batch) yield { type: 'status', text: BATCH_STATUS }
    const source = batch ? this.batch(body, req.signal) : readSseData(await this.send(body, req))

    const calls = new Map<number, ToolCall>()
    let finishReason = 'stop'
    let usage: Usage | undefined
    const details: unknown[] = []

    for await (const data of source) {
      touch()
      if (data === '[DONE]') break
      let chunk: RawChunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue // keep-alive comments or junk
      }
      // Mid-reply failures arrive as an error chunk because the HTTP status (200) is already sent.
      // OpenRouter's wording is "JSON error injected into SSE stream".
      if (chunk.error) throw midStreamError(this.name, chunk.error.message, chunk.error.code)
      if (chunk.usage) usage = { ...toUsage(chunk.usage), ...(batch ? { priceFactor: 0.5 } : {}) }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const d = choice.delta ?? {}
      if (d.content) yield { type: 'text', delta: d.content }
      const reasoning = d.reasoning ?? d.reasoning_content
      if (reasoning) yield { type: 'reasoning', delta: reasoning }
      if (d.reasoning_details?.length) details.push(...d.reasoning_details)
      for (const [pos, tc] of (d.tool_calls ?? []).entries()) {
        let idx = tc.index ?? pos
        // Gemini sends each call whole, in its own chunk, without `index`: a new id is a new call.
        if (tc.index == null && tc.id) while (calls.get(idx)?.id && calls.get(idx)?.id !== tc.id) idx++
        const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        if (tc.extra_content) cur.extra = tc.extra_content
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        calls.set(idx, cur)
      }
      if (choice.finish_reason === 'error') throw midStreamError(this.name, undefined, undefined)
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    for (const [idx, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.id) call.id = `call_${Date.now().toString(36)}_${idx}`
      yield { type: 'tool_call', call }
    }
    if (details.length) yield { type: 'extra', extra: { openai: { reasoning_details: details } } }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finishReason }
  }

  private async send(body: Record<string, unknown>, req: ChatRequest): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    }).catch((e) => {
      // NVIDIA lists many models it no longer serves ("Function '…': Not found for account").
      if (!(e instanceof ProviderError && e.status === 404 && /model|function/i.test(e.message))) throw e
      const set = UNAVAILABLE.get(this.config.baseUrl) ?? new Set<string>()
      UNAVAILABLE.set(this.config.baseUrl, set.add(req.model))
      throw new ProviderError(`${this.name} lists ${req.model} but doesn't serve it (404). Pick another model; this one is now hidden from the list.`, 404)
    })
    if (!res.body) throw new ProviderError('Empty response body from provider')
    return res.body
  }

  /**
   * One request through OpenAI's Batch API: upload a one-line JSONL file, wait for the batch,
   * then hand back the finished completion as a single stream chunk.
   */
  private async *batch(body: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<string> {
    const { stream: _s, stream_options: _o, ...params } = body
    const json = this.headers()
    const { 'content-type': _ct, ...auth } = json
    const get = (path: string) => this.request(this.url(path), { method: 'GET', headers: json, signal })
    const form = new FormData()
    form.append('purpose', 'batch')
    form.append('file', new Blob([JSON.stringify({ custom_id: 'step', method: 'POST', url: '/v1/chat/completions', body: params }) + '\n']), 'step.jsonl')
    const file = (await (await this.request(this.url('/files'), { method: 'POST', headers: auth, body: form, signal })).json()) as { id: string }
    const files = [file.id]
    try {
      const create = await this.request(this.url('/batches'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h' }),
        signal,
      })
      const created = (await create.json()) as RawBatch
      const done = await pollBatch(
        async () => {
          const b = (await (await get(`/batches/${created.id}`)).json()) as RawBatch
          return ['completed', 'failed', 'expired', 'cancelled'].includes(b.status) ? b : undefined
        },
        () => this.fetchImpl(this.url(`/batches/${created.id}/cancel`), { method: 'POST', headers: json }),
        signal,
      )
      const out = done.output_file_id ?? done.error_file_id
      if (done.status !== 'completed' || !out) {
        const why = done.errors?.data?.[0]?.message ?? done.status
        throw new ProviderError(`${this.name} batch request failed: ${why}`, undefined, done.status === 'expired')
      }
      files.push(out)
      const row = findJsonl<RawBatchLine>(await (await get(`/files/${out}/content`)).text(), 'step')
      const status = row?.response?.status_code ?? 0
      const completion = row?.response?.body
      if (!completion?.choices || status >= 400) {
        const why = row?.error?.message ?? completion?.error?.message ?? 'no result'
        throw new ProviderError(`${this.name} batch request failed: ${why}`, status || undefined)
      }
      yield JSON.stringify(completionChunk(completion))
    } finally {
      // Uploaded and result files would otherwise pile up in the account.
      for (const id of files) void this.fetchImpl(this.url(`/files/${id}`), { method: 'DELETE', headers: json }).catch(() => {})
    }
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return requestWithRetry(this.fetchImpl, this.name, this.retries, url, init)
  }
}

/** The user's text followed by any attached files, as the model sees it. */
export function userText(m: Extract<ChatMessage, { role: 'user' }>): string {
  const files = (m.files ?? []).map((f) => `<file name="${f.path ?? f.name}">\n${f.text}\n</file>`)
  const note = m.note ? `<system-reminder>\n${m.note}\n</system-reminder>` : ''
  return [m.content, ...files, note].filter((s) => s.trim()).join('\n\n')
}

/**
 * Reasoning models (DeepSeek, Kimi, gpt-oss, Qwen thinking) expect their reasoning back on the
 * assistant messages of the tool loop in progress; without it they lose the thread after each call.
 * Only messages after the last user-typed message get it, so old turns stay light.
 */
export function wireMessages(messages: ChatMessage[], replayReasoning: boolean): Record<string, unknown>[] {
  let from = messages.length
  if (replayReasoning) {
    from = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === 'user' && !m.synthetic) {
        from = i + 1
        break
      }
    }
  }
  return messages.map((m, i) => toWireMessage(m, i >= from))
}

export function toWireMessage(m: ChatMessage, replayReasoning = false): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: m.role, content: m.content }
    case 'user': {
      const text = userText(m)
      if (!m.images?.length) return { role: 'user', content: text }
      return {
        role: 'user',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
        ],
      }
    }
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content || (m.toolCalls?.length ? null : ''),
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments || '{}' },
                ...(c.extra ? { extra_content: c.extra } : {}),
              })),
            }
          : {}),
        ...(replayReasoning && m.toolCalls?.length ? replayedReasoning(m) : {}),
      }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
}

function replayedReasoning(m: Extract<ChatMessage, { role: 'assistant' }>): Record<string, unknown> {
  const details = (m.extra?.openai as { reasoning_details?: unknown[] } | undefined)?.reasoning_details
  return {
    ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
    ...(details?.length ? { reasoning_details: details } : {}),
  }
}

const NON_CHAT_GOOGLE =
  /embedding|imagen|image|nano-banana|veo|tts|aqa|audio|live|lyria|transcribe|translate|robotics|computer-use|deep-research|antigravity/

/** NVIDIA, Mistral and Groq list these next to chat models. */
const NON_CHAT_MIXED = /embed|rerank|retriever|guard|safety|reward|moderation|ocr|parse|whisper|tts|nvclip|detector|deplot/

/** OpenAI lists image, audio, embedding and legacy completion models next to chat ones. */
const NON_CHAT_OPENAI =
  /embedding|whisper|tts|dall-e|gpt-image|image|audio|realtime|transcribe|moderation|search|sora|davinci|babbage|codex-mini/

const RETIRED_GOOGLE = /^gemini-[12]\./

/** Model ids that answered 404 this run, by base URL; shared so they stay hidden when the registry is rebuilt. */
const UNAVAILABLE = new Map<string, Set<string>>()

interface RawModel {
  id: string
  architecture?: { input_modalities?: string[] }
  created?: number
  name?: string
  context_length?: number
  /** Groq, Cerebras */
  context_window?: number
  /** Mistral */
  max_context_length?: number
  /** vLLM */
  max_model_len?: number
  max_input_tokens?: number
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
}

function toModelInfo(providerId: string, m: RawModel): ModelInfo {
  const prompt = Number(m.pricing?.prompt)
  const completion = Number(m.pricing?.completion)
  const priced = Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0
  return {
    id: m.id,
    name: m.name ?? m.id,
    providerId,
    contextLength: m.context_length ?? m.context_window ?? m.max_context_length ?? m.max_model_len ?? m.max_input_tokens,
    pricing: priced ? { prompt, completion } : undefined,
    free: (priced && prompt === 0 && completion === 0) || m.id.endsWith(':free'),
    created: typeof m.created === 'number' ? m.created : undefined,
    // Providers that don't advertise parameters (Ollama) are assumed to support tools.
    supportsTools: m.supported_parameters ? m.supported_parameters.includes('tools') : true,
    supportsImages: m.architecture?.input_modalities ? m.architecture.input_modalities.includes('image') : undefined,
  }
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  cost?: number
}

function toUsage(u: RawUsage): Usage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens,
    cost: typeof u.cost === 'number' ? u.cost : undefined,
  }
}

interface RawChunk {
  error?: { message?: string; code?: number }
  usage?: RawUsage
  choices?: {
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      reasoning_details?: unknown[]
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
        extra_content?: Record<string, unknown>
      }[]
    }
    finish_reason?: string | null
  }[]
}

interface RawBatch {
  id: string
  status: string
  output_file_id?: string | null
  error_file_id?: string | null
  errors?: { data?: { message?: string }[] } | null
}

interface RawCompletion {
  choices?: { message?: NonNullable<NonNullable<RawChunk['choices']>[number]['delta']>; finish_reason?: string | null }[]
  usage?: RawUsage
  error?: { message?: string }
}

interface RawBatchLine {
  custom_id?: string
  response?: { status_code?: number; body?: RawCompletion }
  error?: { message?: string } | null
}

/** A finished (non-streamed) completion as one stream chunk. */
function completionChunk(c: RawCompletion): RawChunk {
  const choice = c.choices?.[0]
  const m = choice?.message ?? {}
  return {
    usage: c.usage,
    choices: [{ delta: { ...m, tool_calls: m.tool_calls?.map((t, index) => ({ ...t, index })) }, finish_reason: choice?.finish_reason ?? 'stop' }],
  }
}
