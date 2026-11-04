import type { ProviderConfig } from '../settings/schema.js'

// AI pictures for bot avatars. The desktop's main process calls `generateImage` (keys stay
// there); the renderer pixelates the result (see pixel.ts). No Node imports, so the renderer can
// use the provider checks and the prompt too.

export type ImageProviderKind = 'openai' | 'openrouter'

/** Image models tried per provider, in order (a retired model id falls through to the next). */
export const IMAGE_MODELS: Record<ImageProviderKind, string[]> = {
  openai: ['gpt-image-1'],
  openrouter: ['google/gemini-2.5-flash-image', 'google/gemini-2.5-flash-image-preview'],
}

/** Which image API a provider speaks, from its address; null when it can't make images. */
export function imageProviderKind(p: Pick<ProviderConfig, 'baseUrl' | 'api'>): ImageProviderKind | null {
  if (p.api !== 'openai') return null
  let host = ''
  try {
    host = new URL(p.baseUrl).hostname
  } catch {
    return null
  }
  if (host === 'api.openai.com') return 'openai'
  if (host === 'openrouter.ai') return 'openrouter'
  return null
}

/** The prompt for a bot's picture: a single character on a plain background, simple enough to survive 32×32. */
export function avatarPrompt(bot: { name: string; tagline?: string; persona?: string }, extra = ''): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const lines = [
    `A single cute character mascot named "${clip(bot.name.trim() || 'Bot', 40)}", for a small chat avatar.`,
    bot.tagline?.trim() && `It is: ${clip(bot.tagline.trim(), 120)}.`,
    bot.persona?.trim() && `Personality: ${clip(bot.persona.trim().replace(/\s+/g, ' '), 400)}`,
    extra.trim() && `Look: ${clip(extra.trim().replace(/\s+/g, ' '), 400)}`,
    'Head and shoulders, centered, facing the viewer, filling most of the frame.',
    'Bold simple shapes, a few flat colors, thick dark outline, chunky 16-bit pixel art.',
    'Plain solid white background. No text, no letters, no border, no frame, no shadow.',
  ]
  return lines.filter(Boolean).join('\n')
}

export interface ImageRequest {
  kind: ImageProviderKind
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
  prompt: string
  signal?: AbortSignal
  fetch?: typeof fetch
}

export interface GeneratedImage {
  mediaType: string
  base64: string
  model: string
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s

async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '')
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string }
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message)
    if (m) return m
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 200) || res.statusText || `HTTP ${res.status}`
}

/** A model that doesn't exist (any more): try the next one. */
const missingModel = (status: number, text: string) => status === 404 || (status === 400 && /model/i.test(text) && /(not|no|invalid|unknown|exist|support)/i.test(text))

/** The first image in an OpenRouter chat completion: `message.images[].image_url.url`, or an image part in `content`. */
export function imageFromChat(body: unknown): string | null {
  const msg = (body as { choices?: { message?: Record<string, unknown> }[] })?.choices?.[0]?.message
  if (!msg) return null
  const parts = [...(Array.isArray(msg.images) ? msg.images : []), ...(Array.isArray(msg.content) ? msg.content : [])] as Record<string, unknown>[]
  for (const p of parts) {
    const ref = (p?.image_url ?? p?.imageUrl) as { url?: string } | string | undefined
    const url = typeof ref === 'string' ? ref : ref?.url
    if (typeof url === 'string' && url) return url
  }
  return null
}

async function toImage(url: string, f: typeof fetch, signal?: AbortSignal): Promise<{ mediaType: string; base64: string }> {
  const m = DATA_URL.exec(url)
  if (m) return { mediaType: m[1], base64: m[2] }
  if (!/^https:\/\//.test(url)) throw new Error('The provider returned an image in an unknown format.')
  const res = await f(url, { signal })
  if (!res.ok) throw new Error(`Couldn't download the generated image (${res.status}).`)
  const type = res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { mediaType: type, base64: btoa(bin) }
}

/** One square picture from a prompt. Throws a readable error. */
export async function generateImage(req: ImageRequest): Promise<GeneratedImage> {
  const f = req.fetch ?? fetch
  const base = req.baseUrl.replace(/\/+$/, '')
  const headers = { ...req.headers, 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` }
  let last = 'No image model answered.'
  for (const model of IMAGE_MODELS[req.kind]) {
    const res =
      req.kind === 'openai'
        ? await f(`${base}/images/generations`, {
            method: 'POST',
            headers,
            signal: req.signal,
            body: JSON.stringify({ model, prompt: req.prompt, n: 1, size: '1024x1024', quality: 'low', background: 'transparent', output_format: 'png' }),
          })
        : await f(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            signal: req.signal,
            body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content: req.prompt }] }),
          })
    if (!res.ok) {
      last = await errorText(res)
      if (missingModel(res.status, last)) continue
      throw new Error(res.status === 401 || res.status === 403 ? `The API key was refused: ${last}` : last)
    }
    const body = (await res.json()) as unknown
    if (req.kind === 'openai') {
      const item = (body as { data?: { b64_json?: string; url?: string }[] }).data?.[0]
      if (item?.b64_json) return { mediaType: 'image/png', base64: item.b64_json, model }
      if (item?.url) return { ...(await toImage(item.url, f, req.signal)), model }
      throw new Error('The provider returned no image.')
    }
    const url = imageFromChat(body)
    if (!url) throw new Error(`${model} answered without an image. Try again, or change the prompt.`)
    return { ...(await toImage(url, f, req.signal)), model }
  }
  throw new Error(last)
}
