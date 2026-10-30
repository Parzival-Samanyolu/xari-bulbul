import { describe, expect, it, vi } from 'vitest'
import { parseSettings } from '../src/settings/schema.js'
import { CODE_OMITTED, chunkSpeech, prepareSpeech, speechText, splitSentences, urlHost } from '../src/voice/speech-text.js'
import { buildSpeechRequest, openaiSpeech } from '../src/voice/openai-tts.js'

describe('speech text', () => {
  it('strips markdown and keeps the words', () => {
    const md = [
      '# Setting up',
      '',
      'Run **`npm install`** first, then *start* the ~~old~~ server.',
      '',
      '- one item',
      '2. second item',
      '> quoted line',
      '',
      '---',
      'See [the docs](https://example.com/docs) or ![a diagram](x.png).',
    ].join('\n')
    expect(speechText(md)).toBe('Setting up. Run npm install first, then start the old server. one item. second item. quoted line. See the docs or a diagram.')
  })

  it('replaces code blocks with one short note', () => {
    const md = 'Before.\n\n```ts\nconst a = 1\n```\n```\nmore\n```\n\nAfter.\n~~~\nx\n~~~'
    expect(speechText(md)).toBe(`Before. ${CODE_OMITTED} After. ${CODE_OMITTED}`)
  })

  it('an unclosed code block skips to the end', () => {
    expect(speechText('Look:\n```\nnever closed\nstill code')).toBe(`Look: ${CODE_OMITTED}`)
  })

  it('shrinks URLs to their host', () => {
    expect(urlHost('https://www.github.com/a/b?c=1')).toBe('github.com')
    expect(urlHost('nonsense')).toBe('a link')
    expect(speechText('Open https://www.example.org/path/to/page?x=1, then <https://docs.rs/foo>.')).toBe('Open example.org, then docs.rs.')
  })

  it('reads table rows as lists and drops separator rows', () => {
    expect(speechText('| Name | Size |\n|---|:--:|\n| a.ts | 2 KB |')).toBe('Name, Size. a.ts, 2 KB.')
  })

  it('keeps snake_case and math stars alone', () => {
    expect(speechText('Use my_var_name and 2 * 3 * 4')).toBe('Use my_var_name and 2 * 3 * 4.')
  })

  it('drops lines with nothing to say', () => {
    expect(speechText('***\n\n|---|\n<br>\n')).toBe('')
    expect(prepareSpeech('```\ncode only\n```')).toEqual([CODE_OMITTED])
  })
})

describe('chunking', () => {
  it('splits sentences, not abbreviations or decimals', () => {
    expect(splitSentences('Hello there. Version 3.5 is out, e.g. today! Is it? "Yes." Done')).toEqual(['Hello there.', 'Version 3.5 is out, e.g. today!', 'Is it?', '"Yes."', 'Done'])
    expect(splitSentences('你好。世界！')).toEqual(['你好。', '世界！'])
  })

  it('starts with one sentence, then packs up to the limit', () => {
    const chunks = chunkSpeech('One. Two. Three. Four. Five.', 12)
    expect(chunks).toEqual(['One.', 'Two. Three.', 'Four. Five.'])
  })

  it('breaks a long sentence at commas, then spaces, never over the limit', () => {
    const long = `${'word '.repeat(30).trim()}, ${'more '.repeat(100).trim()}.`
    const chunks = chunkSpeech(long, 100)
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long)
    expect(chunkSpeech('x'.repeat(250), 100).map((c) => c.length)).toEqual([100, 100, 50])
  })

  it('default chunks stay under ~400 characters', () => {
    const md = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about something moderately long and useful.`).join(' ')
    const chunks = prepareSpeech(md)
    expect(chunks[0]).toBe('Sentence number 0 talks about something moderately long and useful.')
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400)
    expect(prepareSpeech('')).toEqual([])
  })
})

describe('settings', () => {
  it('defaults to the system voice', () => {
    expect(parseSettings({}).voice.tts).toEqual({ provider: 'system', voice: null, readAloud: false, rate: 1, openai: { providerId: 'openai', model: 'gpt-4o-mini-tts' } })
    const s = parseSettings({ voice: { engine: 'local', tts: { provider: 'openai', voice: 'nova', rate: 1.5 } } })
    expect(s.voice.engine).toBe('local')
    expect(s.voice.tts).toMatchObject({ provider: 'openai', voice: 'nova', rate: 1.5, openai: { model: 'gpt-4o-mini-tts' } })
  })

  it('turns a provider this version lacks (an earlier "edge") into the system voice', () => {
    const s = parseSettings({ voice: { tts: { provider: 'edge', voice: 'en-GB-SoniaNeural', readAloud: true } }, appearance: { theme: 'dark' } })
    expect(s.voice.tts).toMatchObject({ provider: 'system', voice: null, readAloud: true })
    expect(s.appearance.theme).toBe('dark')
  })
})

describe('openai speech', () => {
  const provider = { baseUrl: 'https://api.openai.com/v1/', headers: { 'X-Extra': '1' } }

  it('builds the request', () => {
    const { url, init } = buildSpeechRequest({ provider, apiKey: 'sk-1', model: 'tts-1', voice: 'nova', text: 'Hello', rate: 1.5 })
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'X-Extra': '1', 'Content-Type': 'application/json', Authorization: 'Bearer sk-1' })
    expect(JSON.parse(init.body as string)).toEqual({ model: 'tts-1', voice: 'nova', input: 'Hello', response_format: 'mp3', speed: 1.5 })
    // gpt-4o-mini-tts ignores speed (the app changes the playback rate), and no voice means alloy.
    const mini = JSON.parse(buildSpeechRequest({ provider, model: 'gpt-4o-mini-tts', text: 'Hi', rate: 1.5 }).init.body as string)
    expect(mini).toEqual({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Hi', response_format: 'mp3' })
  })

  it('returns the audio bytes and surfaces errors', async () => {
    const ok = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    expect([...(await openaiSpeech({ provider, model: 'tts-1', text: 'Hi' }, { fetch: ok as typeof fetch }))]).toEqual([1, 2, 3])
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }))
    await expect(openaiSpeech({ provider, model: 'tts-1', text: 'Hi' }, { fetch: bad as typeof fetch })).rejects.toThrow('Speech failed (401): Invalid API key')
    await expect(openaiSpeech({ provider, model: 'tts-1', text: '  ' })).rejects.toThrow(/Nothing/)
  })
})
