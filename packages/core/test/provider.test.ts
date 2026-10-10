import { describe, expect, it } from 'vitest'
import { OpenAICompatProvider, toWireMessage } from '../src/providers/openai-compat.js'
import { BUILTIN_PROVIDERS } from '../src/settings/schema.js'
import type { StreamEvent } from '../src/providers/types.js'
import { sseResponse } from './helpers.js'

const config = BUILTIN_PROVIDERS[0]

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('OpenAICompatProvider', () => {
  it('streams text, assembles split tool calls, and reports usage with cost', async () => {
    let sentBody: any
    const fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return sseResponse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } },
        '[DONE]',
      ])
    }) as typeof globalThis.fetch
    const p = new OpenAICompatProvider({ config, apiKey: 'k', fetch })
    const events = await collect(p.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', parameters: {} }] }))

    expect(events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Hello')
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: '{"path":"a"}' } })
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { promptTokens: 10, completionTokens: 5, cachedTokens: undefined, cost: 0.001 } })
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' })
    expect(sentBody.stream).toBe(true)
    expect(sentBody.usage).toEqual({ include: true })
    expect(sentBody.tools[0].type).toBe('function')
  })

  it('retries on 429 then succeeds', async () => {
    let calls = 0
    const fetch = (async () => {
      calls++
      if (calls === 1) return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0.01' } })
      return sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]'])
    }) as unknown as typeof globalThis.fetch
    const p = new OpenAICompatProvider({ config, apiKey: 'k', fetch, retries: 2 })
    const events = await collect(p.chat({ model: 'x', messages: [] }))
    expect(calls).toBe(2)
    expect(events[0]).toEqual({ type: 'text', delta: 'ok' })
  })

  it('surfaces provider error messages and refuses without a key', async () => {
    const fetch = (async () => new Response('{"error":{"message":"bad model"}}', { status: 400 })) as unknown as typeof globalThis.fetch
    await expect(collect(new OpenAICompatProvider({ config, apiKey: 'k', fetch }).chat({ model: 'x', messages: [] }))).rejects.toThrow(/bad model/)
    await expect(collect(new OpenAICompatProvider({ config, fetch }).chat({ model: 'x', messages: [] }))).rejects.toThrow(/No API key/)
  })

  it('talks to keyless local providers without an Authorization header', async () => {
    let headers: Record<string, string> = {}
    const fetch = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>
      return sseResponse([{ choices: [{ delta: { content: 'hi' } }] }, '[DONE]'])
    }) as typeof globalThis.fetch
    const local = { ...config, id: 'ollama-local', baseUrl: 'http://localhost:11434/v1', headers: {}, requiresKey: false }
    const events = await collect(new OpenAICompatProvider({ config: local, fetch }).chat({ model: 'x', messages: [] }))
    expect(events[0]).toEqual({ type: 'text', delta: 'hi' })
    expect(headers.authorization).toBeUndefined()
  })

  it('maps model lists including pricing and tool support', async () => {
    const fetch = (async () =>
      Response.json({
        data: [
          { id: 'b/model', name: 'B', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] },
          { id: 'a/model:free', created: 1700000000, pricing: { prompt: '0', completion: '0' } },
        ],
      })) as unknown as typeof globalThis.fetch
    const models = await new OpenAICompatProvider({ config, apiKey: 'k', fetch }).listModels()
    expect(models.map((m) => m.id)).toEqual(['a/model:free', 'b/model'])
    expect(models[1].pricing).toEqual({ prompt: 0.000001, completion: 0.000002 })
    expect(models[1].free).toBe(false)
    expect(models[0]).toMatchObject({ free: true, created: 1700000000, supportsTools: true })
  })

  it('lists Google chat models without the models/ prefix or retired Gemini 2.x', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'models/gemini-3.5-flash', object: 'model' },
            { id: 'models/gemini-2.5-flash', object: 'model' },
            { id: 'models/gemini-embedding-001', object: 'model' },
            { id: 'models/imagen-4.0-generate-001', object: 'model' },
            { id: 'models/gemini-2.5-flash-preview-tts', object: 'model' },
          ],
        }),
      )) as unknown as typeof globalThis.fetch
    const p = new OpenAICompatProvider({ config: BUILTIN_PROVIDERS.find((c) => c.id === 'google')!, apiKey: 'k', fetch })
    expect((await p.listModels()).map((m) => [m.id, m.name])).toEqual([['gemini-3.5-flash', 'gemini-3.5-flash']])
  })

  it('keeps index-less tool calls apart and round-trips Gemini thought signatures', async () => {
    const sig = { google: { thought_signature: 'abc' } }
    const fetch = (async () =>
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' }, extra_content: sig }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"y"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])) as typeof globalThis.fetch
    const p = new OpenAICompatProvider({ config, apiKey: 'k', fetch })
    const calls = (await collect(p.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })))
      .filter((e) => e.type === 'tool_call')
      .map((e: any) => e.call)
    expect(calls).toEqual([
      { id: 'a', name: 'read_file', arguments: '{"path":"x"}', extra: sig },
      { id: 'b', name: 'read_file', arguments: '{"path":"y"}' },
    ])
    const wire = toWireMessage({ role: 'assistant', content: '', toolCalls: calls }) as any
    expect(wire.tool_calls[0].extra_content).toEqual(sig)
    expect(wire.tool_calls[1]).not.toHaveProperty('extra_content')
  })
})
