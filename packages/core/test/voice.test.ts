import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { audioFileName, buildTranscriptionRequest, canTranscribe, transcribe } from '../src/voice/transcribe.js'
import { BUILTIN_PROVIDERS, parseSettings } from '../src/settings/schema.js'

const groq = BUILTIN_PROVIDERS.find((p) => p.id === 'groq')!
const audio = new Uint8Array([1, 2, 3, 4])

describe('provider transcription', () => {
  it('builds a multipart request to /audio/transcriptions', async () => {
    const { url, init } = buildTranscriptionRequest({ provider: groq, apiKey: 'gsk', model: 'whisper-large-v3-turbo', audio, mediaType: 'audio/webm;codecs=opus' })
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk')
    // fetch sets the multipart content type itself, with the boundary.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('response_format')).toBe('json')
    expect(form.get('language')).toBeNull()
    const file = form.get('file') as File
    expect(file.name).toBe('recording.webm')
    expect(file.type).toBe('audio/webm')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio)
  })

  it('names files by media type and trims a trailing slash from the base URL', () => {
    expect(audioFileName('audio/wav')).toBe('recording.wav')
    expect(audioFileName('audio/ogg; codecs=opus')).toBe('recording.ogg')
    expect(audioFileName('application/x-unknown')).toBe('recording.webm')
    const { url, init } = buildTranscriptionRequest({ provider: { baseUrl: 'http://localhost:8080/v1/', headers: {} }, model: 'm', audio, mediaType: 'audio/wav', language: 'tr' })
    expect(url).toBe('http://localhost:8080/v1/audio/transcriptions')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect((init.body as FormData).get('language')).toBe('tr')
  })

  it('returns the text from the JSON answer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: '  hello there \n' }), { status: 200 }))
    await expect(transcribe({ provider: groq, apiKey: 'k', model: 'w', audio, mediaType: 'audio/webm' }, { fetch })).resolves.toBe('hello there')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends a real multipart body that a server can read', async () => {
    let seen = { auth: '', type: '', body: '' }
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen = { auth: String(req.headers.authorization), type: String(req.headers['content-type']), body: Buffer.concat(chunks).toString('latin1') }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ text: 'from the server' }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      const text = await transcribe({ provider: { baseUrl, headers: {} }, apiKey: 'k', model: 'whisper-1', audio, mediaType: 'audio/wav' })
      expect(text).toBe('from the server')
      expect(seen.auth).toBe('Bearer k')
      expect(seen.type).toMatch(/^multipart\/form-data; boundary=/)
      expect(seen.body).toContain('name="file"; filename="recording.wav"')
      expect(seen.body).toContain('Content-Type: audio/wav')
      expect(seen.body).toContain('\x01\x02\x03\x04')
      expect(seen.body).toMatch(/name="model"\r\n\r\nwhisper-1\r\n/)
    } finally {
      server.close()
    }
  })

  it("surfaces the provider's error message", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }))
    await expect(transcribe({ provider: groq, apiKey: 'bad', model: 'w', audio, mediaType: 'audio/webm' }, { fetch })).rejects.toThrow('Transcription failed (401): Invalid API Key')
  })

  it('refuses an empty recording without a request', async () => {
    const fetch = vi.fn()
    await expect(transcribe({ provider: groq, model: 'w', audio: new Uint8Array(), mediaType: 'audio/webm' }, { fetch })).rejects.toThrow(/empty/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('only OpenAI-style providers can transcribe; the setting defaults to off', () => {
    expect(canTranscribe(groq)).toBe(true)
    expect(canTranscribe(BUILTIN_PROVIDERS.find((p) => p.id === 'anthropic'))).toBe(false)
    expect(canTranscribe(undefined)).toBe(false)
    expect(parseSettings({}).models.transcription).toBeNull()
  })
})
