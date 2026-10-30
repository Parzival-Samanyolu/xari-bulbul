// Text to speech through an OpenAI-style `POST /audio/speech` (OpenAI, or any provider that copies it).

import type { ProviderConfig } from '../settings/schema.js'
import { OPENAI_DEFAULT_VOICE, type OpenAiTtsModel } from './speech-text.js'

export interface SpeechRequest {
  provider: Pick<ProviderConfig, 'baseUrl' | 'headers'>
  apiKey?: string
  model: OpenAiTtsModel | string
  voice?: string | null
  text: string
  /** 0.5–2. `tts-1` takes it as `speed`; `gpt-4o-mini-tts` ignores `speed`, so the caller plays it faster instead. */
  rate?: number
}

/** Whether the model honours the `speed` parameter (OpenAI documents it doesn't for gpt-4o-mini-tts). */
export const speechModelTakesSpeed = (model: string) => !/^gpt-4o-mini-tts/.test(model)

/** The JSON POST for one chunk, without sending it. */
export function buildSpeechRequest(r: SpeechRequest): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = { model: r.model, voice: r.voice?.trim() || OPENAI_DEFAULT_VOICE, input: r.text, response_format: 'mp3' }
  const rate = r.rate ?? 1
  if (rate !== 1 && speechModelTakesSpeed(r.model)) body.speed = rate
  const headers: Record<string, string> = { ...r.provider.headers, 'Content-Type': 'application/json' }
  if (r.apiKey) headers.Authorization = `Bearer ${r.apiKey}`
  return { url: `${r.provider.baseUrl.replace(/\/+$/, '')}/audio/speech`, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

/** Sends one chunk and returns the MP3 bytes. Errors carry the provider's message. */
export async function openaiSpeech(r: SpeechRequest, opts: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<Uint8Array> {
  if (!r.text.trim()) throw new Error('Nothing to say.')
  const { url, init } = buildSpeechRequest(r)
  const res = await (opts.fetch ?? fetch)(url, { ...init, signal: opts.signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = text.slice(0, 300)
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? message
    } catch {
      /* not JSON */
    }
    throw new Error(`Speech failed (${res.status}): ${message || res.statusText}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}
