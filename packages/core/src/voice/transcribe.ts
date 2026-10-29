// Speech to text through a provider's OpenAI-style `/audio/transcriptions` endpoint
// (OpenAI `whisper-1`, Groq `whisper-large-v3-turbo`, local servers that copy the API).

import type { ProviderConfig } from '../settings/schema.js'

/** Suggested transcription models, shown in Settings. */
export const TRANSCRIPTION_SUGGESTIONS: { providerId: string; modelId: string; label: string }[] = [
  { providerId: 'groq', modelId: 'whisper-large-v3-turbo', label: 'Groq · whisper-large-v3-turbo' },
  { providerId: 'openai', modelId: 'whisper-1', label: 'OpenAI · whisper-1' },
]

/** Providers can transcribe when they speak the OpenAI API; Anthropic's Messages API has no audio endpoint. */
export function canTranscribe(config: ProviderConfig | undefined): boolean {
  return !!config && config.api === 'openai'
}

export interface TranscriptionRequest {
  provider: Pick<ProviderConfig, 'baseUrl' | 'headers'>
  apiKey?: string
  model: string
  audio: Uint8Array
  /** e.g. `audio/webm` or `audio/wav`; picks the file extension the server sees. */
  mediaType: string
  /** ISO-639-1 code; omitted lets the model detect it. */
  language?: string
}

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
}

/** `audio/webm;codecs=opus` → `recording.webm`. Servers pick the decoder from the file name. */
export function audioFileName(mediaType: string): string {
  const base = mediaType.split(';')[0].trim().toLowerCase()
  return `recording.${EXTENSIONS[base] ?? 'webm'}`
}

/** The multipart POST for a transcription, without sending it. */
export function buildTranscriptionRequest(r: TranscriptionRequest): { url: string; init: RequestInit } {
  const form = new FormData()
  const type = r.mediaType.split(';')[0].trim() || 'audio/webm'
  form.append('file', new Blob([r.audio as Uint8Array<ArrayBuffer>], { type }), audioFileName(r.mediaType))
  form.append('model', r.model)
  form.append('response_format', 'json')
  if (r.language) form.append('language', r.language)
  // Content-Type (with the multipart boundary) is set by fetch from the FormData.
  const headers: Record<string, string> = { ...r.provider.headers }
  if (r.apiKey) headers.Authorization = `Bearer ${r.apiKey}`
  return {
    url: `${r.provider.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
    init: { method: 'POST', headers, body: form },
  }
}

/** Sends the recording and returns the text. Errors carry the provider's message. */
export async function transcribe(r: TranscriptionRequest, opts: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<string> {
  if (!r.audio.byteLength) throw new Error('The recording is empty.')
  const { url, init } = buildTranscriptionRequest(r)
  const res = await (opts.fetch ?? fetch)(url, { ...init, signal: opts.signal })
  const body = await res.text()
  if (!res.ok) {
    let message = body.slice(0, 300)
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? message
    } catch {
      /* not JSON */
    }
    throw new Error(`Transcription failed (${res.status}): ${message || res.statusText}`)
  }
  try {
    const j = JSON.parse(body) as { text?: unknown }
    if (typeof j.text === 'string') return j.text.trim()
  } catch {
    /* some servers answer plain text */
  }
  return body.trim()
}
