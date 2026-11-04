import { describe, expect, it } from 'vitest'
import {
  avatarPrompt,
  botFace,
  clearBackground,
  creatureSprite,
  generateImage,
  hasAvatarFile,
  imageFromChat,
  imageProviderKind,
  palette,
  pixelate,
  quantize,
  type Pixels,
} from '../src/bots/bots.js'
import { BUILTIN_PROVIDERS, parseSettings } from '../src/settings/schema.js'

/** A w×h picture: a white background with a filled square of `color` in the middle. */
function picture(w = 64, h = 64, color: [number, number, number] = [200, 40, 90]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inside = x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4
      const [r, g, b] = inside ? color : [252, 252, 250]
      data.set([r, g, b, 255], i)
    }
  return { width: w, height: h, data }
}

const alphaAt = (p: Pixels, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3]
const colors = (p: Pixels) => new Set(Array.from({ length: p.width * p.height }, (_, i) => i).filter((i) => p.data[i * 4 + 3]).map((i) => p.data.slice(i * 4, i * 4 + 3).join(',')))

describe('pixel avatars', () => {
  it('clears a plain background and keeps the subject', () => {
    const out = clearBackground(picture())
    expect(alphaAt(out, 0, 0)).toBe(0)
    expect(alphaAt(out, 63, 63)).toBe(0)
    expect(alphaAt(out, 32, 32)).toBe(255)
  })

  it('leaves a busy picture alone', () => {
    const img = picture()
    for (let i = 0; i < img.data.length; i += 4) img.data.set([(i * 37) % 255, (i * 91) % 255, (i * 13) % 255, 255], i)
    expect(clearBackground(img)).toBe(img)
  })

  it('pixelates to a square grid with a small palette and an outline', () => {
    const img = picture(128, 96)
    // Noise in the subject, so there are many colors to reduce.
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 200) img.data[i + 1] = (i / 4) % 200
    const out = pixelate(img, { grid: 32, colors: 8 })
    expect(out.width).toBe(32)
    expect(out.height).toBe(32)
    expect(alphaAt(out, 0, 0)).toBe(0)
    expect(alphaAt(out, 16, 16)).toBe(255)
    // Alpha is snapped; colors are the palette plus outline tints of it.
    for (let i = 3; i < out.data.length; i += 4) expect([0, 255]).toContain(out.data[i])
    expect(colors(out).size).toBeLessThanOrEqual(16)
  })

  it('quantizes to at most the asked number of colors', () => {
    const img = picture(32, 32)
    for (let i = 0; i < img.data.length; i += 4) img.data.set([i % 256, (i * 3) % 256, (i * 7) % 256, 255], i)
    expect(palette(img, 16).length).toBeLessThanOrEqual(16)
    expect(colors(quantize(img, 16)).size).toBeLessThanOrEqual(16)
  })

  it('makes the same symmetric creature for the same seed, and others for others', () => {
    const a = creatureSprite('Pip')
    const b = creatureSprite('Pip')
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
    expect(a.width).toBe(16)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 8; x++) {
        const l = (y * 16 + x) * 4
        const r = (y * 16 + 15 - x) * 4
        expect(Array.from(a.data.slice(l, l + 4))).toEqual(Array.from(a.data.slice(r, r + 4)))
      }
    const opaque = Array.from({ length: 256 }, (_, i) => a.data[i * 4 + 3]).filter(Boolean).length
    expect(opaque).toBeGreaterThan(60)
    const seeds = ['Pip#1', 'Pip#2', 'Pip#3', 'Moss', 'Ada']
    const distinct = new Set(seeds.map((s) => Array.from(creatureSprite(s).data).join()))
    expect(distinct.size).toBe(seeds.length)
  })

  it('keeps the outline column and row clear around the sprite edge', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const s = creatureSprite(seed)
      // Nothing but outline on the border: the body never touches the edge.
      for (let i = 0; i < 16; i++) for (const [x, y] of [[0, i], [i, 0], [i, 15], [15, i]] as const) expect(s.data[(y * 16 + x) * 4 + 3] === 0 || s.data[(y * 16 + x) * 4] < 90).toBe(true)
    }
  })
})

describe('pixel avatar settings', () => {
  it('parses a pixel avatar and falls back to a shape for unknown kinds', () => {
    const s = parseSettings({
      bots: [
        { id: 'a', name: 'A', avatar: { kind: 'pixel', image: '/data/bots/pixel-1.png', color: '#d98bb0', locked: true, prompt: 'a fox' } },
        { id: 'b', name: 'B', avatar: { kind: 'hologram', color: '#d98bb0' } },
      ],
    })
    expect(s.bots[0].avatar).toMatchObject({ kind: 'pixel', image: '/data/bots/pixel-1.png', prompt: 'a fox' })
    expect(botFace('A', s.bots[0].avatar)).toEqual({ kind: 'pixel', image: '/data/bots/pixel-1.png', color: '#d98bb0' })
    expect(hasAvatarFile(s.bots[0].avatar)).toBe(true)
    expect(s.bots[1].avatar.kind).toBe('shape')
    expect(hasAvatarFile(s.bots[1].avatar)).toBe(false)
  })

  it('draws a pixel avatar without a file as a shape', () => {
    expect(botFace('A', { kind: 'pixel', color: '#d98bb0', locked: true }).kind).toBe('shape')
  })
})

describe('avatar image generation', () => {
  const openai = BUILTIN_PROVIDERS.find((p) => p.id === 'openai')!
  const openrouter = BUILTIN_PROVIDERS.find((p) => p.id === 'openrouter')!

  it('knows which providers make images', () => {
    expect(imageProviderKind(openai)).toBe('openai')
    expect(imageProviderKind(openrouter)).toBe('openrouter')
    expect(imageProviderKind({ baseUrl: 'http://localhost:11434/v1', api: 'openai' })).toBeNull()
    expect(imageProviderKind({ baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic' })).toBeNull()
  })

  it('builds a prompt from the bot and the extra text', () => {
    const p = avatarPrompt({ name: 'Pip', tagline: 'Space otter', persona: 'Loves puns.' }, 'blue scarf')
    expect(p).toContain('"Pip"')
    expect(p).toContain('Space otter')
    expect(p).toContain('Loves puns.')
    expect(p).toContain('blue scarf')
    expect(p).toMatch(/white background/)
  })

  it('reads b64_json from OpenAI', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const img = await generateImage({ kind: 'openai', baseUrl: openai.baseUrl, apiKey: 'k', prompt: 'p', fetch: f })
    expect(img).toEqual({ mediaType: 'image/png', base64: 'iVBORw0KGgo=', model: 'gpt-image-1' })
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations')
    expect(calls[0].body).toMatchObject({ model: 'gpt-image-1', prompt: 'p' })
  })

  it('reads message.images from OpenRouter and skips a retired model', async () => {
    const models: string[] = []
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; modalities: string[] }
      models.push(body.model)
      expect(body.modalities).toEqual(['image', 'text'])
      if (models.length === 1) return new Response(JSON.stringify({ error: { message: 'No endpoints found for this model' } }), { status: 404 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'here', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const img = await generateImage({ kind: 'openrouter', baseUrl: openrouter.baseUrl, apiKey: 'k', prompt: 'p', fetch: f })
    expect(img).toEqual({ mediaType: 'image/png', base64: 'AAAA', model: models[1] })
    expect(models).toEqual(['google/gemini-2.5-flash-image', 'google/gemini-2.5-flash-image-preview'])
  })

  it('reports a refused key and a reply without an image', async () => {
    const refused = (async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 })) as unknown as typeof fetch
    await expect(generateImage({ kind: 'openai', baseUrl: openai.baseUrl, apiKey: 'k', prompt: 'p', fetch: refused })).rejects.toThrow(/refused: Incorrect API key/)
    const textOnly = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot draw' } }] }), { status: 200 })) as unknown as typeof fetch
    await expect(generateImage({ kind: 'openrouter', baseUrl: openrouter.baseUrl, apiKey: 'k', prompt: 'p', fetch: textOnly })).rejects.toThrow(/without an image/)
  })

  it('finds image parts in content too', () => {
    expect(imageFromChat({ choices: [{ message: { content: [{ type: 'image_url', imageUrl: { url: 'data:image/webp;base64,BB' } }] } }] })).toBe('data:image/webp;base64,BB')
    expect(imageFromChat({})).toBeNull()
  })
})
