import { describe, expect, it } from 'vitest'
import { modelMaker } from '../src/providers/catalog.js'
import { contextIndex, contextKey, fillContext } from '../src/providers/context-catalog.js'
import { OpenAICompatProvider } from '../src/providers/openai-compat.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { BUILTIN_PROVIDERS } from '../src/settings/schema.js'
import type { ModelInfo } from '../src/types.js'

const info = (id: string, contextLength?: number): ModelInfo => ({ id, name: id, providerId: 'p', free: false, supportsTools: true, contextLength })

describe('model maker', () => {
  it('reads the org prefix, then the model family', () => {
    expect(modelMaker('meta/llama-3.2-11b-vision-instruct')).toBe('meta')
    expect(modelMaker('deepseek-ai/deepseek-v4.1-flash')).toBe('deepseek')
    expect(modelMaker('nvidia/nemotron-3-super-120b-a12b')).toBe('nvidia')
    expect(modelMaker('openai/gpt-oss-20b')).toBe('openai')
    expect(modelMaker('gpt-oss:120b')).toBe('openai')
    expect(modelMaker('llama-3.3-70b-versatile')).toBe('meta')
    expect(modelMaker('qwen3-coder:480b')).toBe('qwen')
    expect(modelMaker('models/gemini-3.5-flash')).toBe('google')
    expect(modelMaker('some-unknown-model')).toBeUndefined()
  })
})

describe('context fill', () => {
  it('matches ids across providers by name only', () => {
    expect(contextKey('openai/gpt-oss-120b')).toBe('gpt-oss-120b')
    expect(contextKey('gpt-oss:120b')).toBe('gpt-oss-120b')
    expect(contextKey('qwen/qwen3-coder:free')).toBe('qwen3-coder')
    const index = contextIndex([info('openai/gpt-oss-120b', 131_072), info('mistralai/codestral-2508', 256_000)])
    const out = fillContext([info('gpt-oss:120b'), info('codestral-2508', 32_000), info('mystery')], index)
    expect(out.map((m) => m.contextLength)).toEqual([131_072, 32_000, undefined])
  })

  it('fills from the public OpenRouter list only when asked', async () => {
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(url)
      if (url.startsWith('https://openrouter.ai')) return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b', context_length: 131_072 }] }))
      return new Response(JSON.stringify({ data: [{ id: 'gpt-oss-120b' }] }))
    }) as unknown as typeof globalThis.fetch
    const groq = BUILTIN_PROVIDERS.filter((c) => c.id === 'groq')
    expect((await new ProviderRegistry(groq, () => 'k', { fetch }).models('groq'))[0].contextLength).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect((await new ProviderRegistry(groq, () => 'k', { fetch, fillContext: true }).models('groq'))[0].contextLength).toBe(131_072)
  })

  it('reads the context fields Groq and Mistral use', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'a', context_window: 8192 }, { id: 'b', max_context_length: 32_000 }] }))) as unknown as typeof globalThis.fetch
    const p = new OpenAICompatProvider({ config: { ...BUILTIN_PROVIDERS[0], baseUrl: 'https://x.dev/v1' }, apiKey: 'k', fetch })
    expect((await p.listModels()).map((m) => m.contextLength)).toEqual([8192, 32_000])
  })
})

describe('unserved models', () => {
  it('hides a listed model after the provider answers 404 for it', async () => {
    const fetch = (async (url: string) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: '01-ai/yi-large' }, { id: 'nvidia/nemotron-3.5-bolt-e4b' }] }))
        : new Response(JSON.stringify({ status: 404, title: 'Not Found', detail: "Function 'x': Not found for account 'y'" }), { status: 404 })) as unknown as typeof globalThis.fetch
    const nvidia = BUILTIN_PROVIDERS.filter((c) => c.id === 'nvidia')
    const registry = new ProviderRegistry(nvidia, () => 'k', { fetch })
    expect(await registry.models('nvidia')).toHaveLength(2)
    const chat = registry.get('nvidia').chat({ model: '01-ai/yi-large', messages: [{ role: 'user', content: 'hi' }] })
    await expect(chat[Symbol.asyncIterator]().next()).rejects.toThrow(/doesn't serve it/)
    expect((await registry.models('nvidia')).map((m) => m.id)).toEqual(['nvidia/nemotron-3.5-bolt-e4b'])
    // A rebuilt registry (settings change) still hides it.
    expect((await new ProviderRegistry(nvidia, () => 'k', { fetch }).models('nvidia')).map((m) => m.id)).toEqual(['nvidia/nemotron-3.5-bolt-e4b'])
  })
})

describe('stall timeout', () => {
  const hang = (async (_url: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof globalThis.fetch
  const nvidia = BUILTIN_PROVIDERS.find((c) => c.id === 'nvidia')!
  const drain = async (it: AsyncIterable<unknown>) => {
    for await (const _ of it);
  }

  it('gives up on a hosted provider that sends nothing', async () => {
    const p = new OpenAICompatProvider({ config: nvidia, apiKey: 'k', fetch: hang, retries: 0 })
    await expect(drain(p.chat({ model: 'deepseek-ai/deepseek-v4.1-flash', messages: [], stallMs: 30 }))).rejects.toThrow(/sent nothing for 0s.*Try another model/)
  })

  it('reports a user stop as an abort, not a stall', async () => {
    const p = new OpenAICompatProvider({ config: nvidia, apiKey: 'k', fetch: hang, retries: 0 })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 10)
    await expect(drain(p.chat({ model: 'm', messages: [], stallMs: 5000, signal: ctrl.signal }))).rejects.toThrow('aborted')
  })
})
