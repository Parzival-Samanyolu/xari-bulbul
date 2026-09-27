import type { ChatMessage, ModelInfo, ToolCall, Usage } from '../types.js'
import type { ProviderConfig } from '../settings/schema.js'
import { readSseData } from './sse.js'
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from './types.js'

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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.config.headers }
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    return h
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request(this.url('/models'), { method: 'GET', headers: this.headers(), signal })
    const json = (await res.json()) as { data?: RawModel[] }
    return (json.data ?? []).map((m) => toModelInfo(this.id, m)).sort((a, b) => a.id.localeCompare(b.id))
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.apiKey && this.config.requiresKey) {
      throw new ProviderError(`No API key set for ${this.name}. Add one in Settings → Providers & Keys.`)
    }
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWireMessage),
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
    if (req.maxTokens != null) body.max_tokens = req.maxTokens
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort
    if (this.config.requestUsageCost) body.usage = { include: true }

    const res = await this.request(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!res.body) throw new ProviderError('Empty response body from provider')

    const calls = new Map<number, ToolCall>()
    let finishReason = 'stop'
    let usage: Usage | undefined

    for await (const data of readSseData(res.body)) {
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
      if (chunk.usage) usage = toUsage(chunk.usage)
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const d = choice.delta ?? {}
      if (d.content) yield { type: 'text', delta: d.content }
      const reasoning = d.reasoning ?? d.reasoning_content
      if (reasoning) yield { type: 'reasoning', delta: reasoning }
      for (const [pos, tc] of (d.tool_calls ?? []).entries()) {
        const idx = tc.index ?? pos
        const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
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
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finishReason }
  }

  /** fetch with retry on network errors, 408/409/429/5xx (only before the stream starts). */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0
    while (true) {
      let res: Response
      try {
        res = await this.fetchImpl(url, init)
      } catch (err) {
        if (init.signal?.aborted) throw err
        if (attempt++ >= this.retries) throw new ProviderError(`Network error: ${(err as Error).message}`)
        await sleep(backoff(attempt), init.signal)
        continue
      }
      if (res.ok) return res
      const retryable = [408, 409, 429].includes(res.status) || res.status >= 500
      const text = await res.text().catch(() => '')
      if (retryable && attempt++ < this.retries) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), init.signal)
        continue
      }
      throw new ProviderError(`${this.name} error ${res.status}: ${extractError(text)}`, res.status, retryable)
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15_000) + Math.random() * 250
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })
}

function extractError(text: string): string {
  try {
    const j = JSON.parse(text)
    return j.error?.message ?? j.message ?? text
  } catch {
    return text.slice(0, 500) || 'unknown error'
  }
}

function midStreamError(provider: string, message: string | undefined, code: number | undefined): ProviderError {
  // Client errors (bad request, context too long) won't fix themselves; everything else is worth a retry.
  const retryable = code == null || code === 408 || code === 429 || code >= 500
  const detail = message && !/injected into SSE stream/i.test(message) ? ` (${message})` : ''
  return new ProviderError(`${provider}: the model's provider failed partway through its reply${detail}.`, code, retryable)
}

/** The user's text followed by any attached files, as the model sees it. */
export function userText(m: Extract<ChatMessage, { role: 'user' }>): string {
  const files = (m.files ?? []).map((f) => `<file name="${f.path ?? f.name}">\n${f.text}\n</file>`)
  return [m.content, ...files].filter((s) => s.trim()).join('\n\n')
}

export function toWireMessage(m: ChatMessage): Record<string, unknown> {
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
              })),
            }
          : {}),
      }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
}

interface RawModel {
  id: string
  architecture?: { input_modalities?: string[] }
  created?: number
  name?: string
  context_length?: number
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
    contextLength: m.context_length,
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
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
}
