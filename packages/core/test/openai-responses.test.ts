import { describe, expect, it } from 'vitest'
import { OpenAIResponsesProvider, USAGE_LIMIT_CODE, SIGN_IN_AGAIN_CODE, responsesBody } from '../src/providers/openai-responses.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { BUILTIN_PROVIDERS, CHATGPT_PROVIDER_ID, parseSettings } from '../src/settings/schema.js'
import { ProviderError, type StreamEvent } from '../src/providers/types.js'
import type { ChatMessage } from '../src/types.js'
import { sseResponse } from './helpers.js'

const config = BUILTIN_PROVIDERS.find((p) => p.id === CHATGPT_PROVIDER_ID)!

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

function provider(respond: (url: string, init: RequestInit) => Response | Promise<Response>, token = async () => 'tok') {
  const seen: { url: string; body?: any; headers: Record<string, string> }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers as Record<string, string> })
    return respond(url, init)
  }) as typeof globalThis.fetch
  return { p: new OpenAIResponsesProvider({ config, token, fetch, retries: 2 }), seen }
}

const completed = (usage = { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }) => ({ type: 'response.completed', response: { usage } })

describe('OpenAIResponsesProvider', () => {
  it('is a built-in, paid by the ChatGPT plan, added to old settings files', () => {
    expect(config).toMatchObject({ api: 'openai-responses', auth: 'chatgpt', baseUrl: 'https://api.openai.com/v1' })
    expect(parseSettings({ providers: [] }).providers.some((p) => p.id === CHATGPT_PROVIDER_ID)).toBe(true)
    expect(parseSettings({}).providers.find((p) => p.id === 'openai')?.auth).toBe('key')
  })

  it('sends the request shape the plan route accepts', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'list files', images: [{ mediaType: 'image/png', data: 'AAA' }] as any },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }], extra: { openaiResponses: { reasoning: [{ type: 'reasoning', summary: [], encrypted_content: 'enc' }] } } },
      { role: 'tool', toolCallId: 'c1', name: 'ls', content: 'a.ts' },
    ]
    const body = responsesBody({ model: 'gpt-6.1-sol', messages, tools: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }], reasoningEffort: 'max', temperature: 0.2, maxTokens: 100 })
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', instructions: 'Be brief.', store: false, stream: true, include: ['reasoning.encrypted_content'], reasoning: { effort: 'xhigh', summary: 'auto' } })
    for (const k of ['temperature', 'max_output_tokens', 'max_tokens', 'previous_response_id', 'metadata', 'user', 'top_p']) expect(body).not.toHaveProperty(k)
    expect(body.tools).toEqual([{ type: 'function', name: 'ls', description: 'list', parameters: { type: 'object' }, strict: false }])
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'list files' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'enc' },
      { role: 'assistant', content: 'Looking.' },
      { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.ts' },
    ])
    expect((body.input as any[]).some((i) => i.role === 'system')).toBe(false)
  })

  it('streams text, reasoning and tool calls, keeps reasoning items, and reports usage', async () => {
    const { p, seen } = provider(() =>
      sseResponse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.reasoning_summary_text.delta', delta: 'Think' },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', status: 'completed', summary: [{ type: 'summary_text', text: 'Think' }], encrypted_content: 'ENC' } },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', name: 'read_file' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } },
        completed(),
      ]),
    )
    const events = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(seen[0].url).toBe('https://api.openai.com/v1/responses')
    expect(seen[0].headers.authorization).toBe('Bearer tok')
    expect(events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Hello')
    expect(events.find((e) => e.type === 'reasoning')).toEqual({ type: 'reasoning', delta: 'Think' })
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } })
    expect(events.find((e) => e.type === 'extra')).toEqual({ type: 'extra', extra: { openaiResponses: { reasoning: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Think' }], encrypted_content: 'ENC' }] } } })
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { promptTokens: 12, completionTokens: 4, cachedTokens: 3 } })
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' })
  })

  it('treats a stream without response.completed as a failure', async () => {
    const { p } = provider(() => sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]))
    await expect(collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(/ended before the reply was complete/)
  })

  it('reports a plan limit hit mid-stream without retrying it', async () => {
    const { p, seen } = provider(() =>
      sseResponse([{ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.failed', response: { error: { code: USAGE_LIMIT_CODE, message: 'limit' } } }]),
    )
    const err = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ status: 429, code: USAGE_LIMIT_CODE, retryable: false })
    expect(err.message).toMatch(/chatgpt\.com\/settings\/usage/)
    expect(seen).toHaveLength(1)
  })

  it('does not retry a plan limit before the stream, but retries a plain 5xx', async () => {
    let n = 0
    const limited = provider(() => new Response(JSON.stringify({ error: { code: USAGE_LIMIT_CODE, message: 'limit' } }), { status: 429 }))
    await expect(collect(limited.p.chat({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: USAGE_LIMIT_CODE })
    expect(limited.seen).toHaveLength(1)
    const flaky = provider(() => (n++ === 0 ? new Response('oops', { status: 502, headers: { 'retry-after': '0.01' } }) : sseResponse([completed()])))
    const events = await collect(flaky.p.chat({ model: 'm', messages: [] }))
    expect(flaky.seen).toHaveLength(2)
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  })

  it('shows a {detail} body from direct admission and asks to sign in again on 401', async () => {
    const forbidden = provider(() => new Response(JSON.stringify({ detail: 'Region not supported' }), { status: 403 }))
    await expect(collect(forbidden.p.chat({ model: 'm', messages: [] }))).rejects.toThrow(/403: Region not supported/)
    const expired = provider(() => new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 401 }))
    await expect(collect(expired.p.chat({ model: 'm', messages: [] }))).rejects.toMatchObject({ status: 401, code: SIGN_IN_AGAIN_CODE })
  })

  it('names the unsupported parameter', async () => {
    const { p } = provider(() => new Response(JSON.stringify({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0]', message: 'nope' } }), { status: 400 }))
    await expect(collect(p.chat({ model: 'm', messages: [] }))).rejects.toThrow(/“tools\[0\]”/)
  })

  it('surfaces a token error (signed out) without calling the API', async () => {
    const { p, seen } = provider(() => sseResponse([completed()]), async () => {
      throw Object.assign(new Error('Sign in to ChatGPT in Settings › Providers.'), { kind: 'sign_in_again' })
    })
    await expect(collect(p.chat({ model: 'm', messages: [] }))).rejects.toMatchObject({ message: expect.stringMatching(/Sign in to ChatGPT/), status: 401, code: SIGN_IN_AGAIN_CODE })
    expect(seen).toHaveLength(0)
  })

  it('lists the account’s models in server order, keeping visible ones', async () => {
    const { p, seen } = provider(() =>
      Response.json({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'hidden-one', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list' },
        ],
      }),
    )
    const models = await p.listModels()
    expect(seen[0].url).toBe('https://api.openai.com/v1/models')
    expect(models.map((m) => [m.id, m.name])).toEqual([
      ['gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['gpt-5.6-luna', 'GPT-5.6 Luna'],
    ])
    expect(models.every((m) => !m.pricing && !m.free && m.supportsTools)).toBe(true)
  })

  it('uses the model’s maximum context, not the smaller default', async () => {
    const { p } = provider(() =>
      Response.json({
        models: [
          { slug: 'big', context_window: 272_000, max_context_window: 872_000 },
          { slug: 'plain', context_window: 500_000 },
        ],
      }),
    )
    const models = await p.listModels()
    expect(models.map((m) => m.contextLength)).toEqual([872_000, 500_000])
  })

  it('is built by the registry only while signed in', () => {
    const signedOut = new ProviderRegistry([config], () => undefined, {})
    expect(signedOut.has(CHATGPT_PROVIDER_ID)).toBe(false)
    const signedIn = new ProviderRegistry([config], () => undefined, { tokenFor: (id) => (id === CHATGPT_PROVIDER_ID ? async () => 't' : undefined) })
    expect(signedIn.get(CHATGPT_PROVIDER_ID)).toBeInstanceOf(OpenAIResponsesProvider)
  })
})
