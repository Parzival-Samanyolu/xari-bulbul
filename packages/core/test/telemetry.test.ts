import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { TELEMETRY_URL, Telemetry, installId, scrubText, telemetryUrl, type TelemetryOptions } from '../src/telemetry/client.js'
import { SNAPSHOT_FEATURES, appSession, appSnapshot, cpuBucket, localeBucket, osVersionBucket, ramBucket, screenBucket, telemetryModel, telemetryProvider } from '../src/telemetry/shape.js'
import { parseSettings } from '../src/settings/schema.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { tmpDir } from './helpers.js'

// The collector's own validation (server/telemetry/src/validate.js): every payload the client
// sends in these tests must pass it, so the app and the server can't drift apart.
type Validate = (body: unknown, now?: number) => { ok: true; batch: unknown } | { ok: false; error: string }
let validateBatch: Validate
let LIMITS: { maxBodyBytes: number; maxEvents: number }
beforeAll(async () => {
  const file = path.resolve(__dirname, '../../../server/telemetry/src/validate.js')
  const mod = await import(pathToFileURL(file).href)
  validateBatch = mod.validateBatch
  LIMITS = mod.LIMITS
})

interface Sent {
  url: string
  body: string
  json: Record<string, unknown> & { events: { name: string; ts: number; props?: Record<string, unknown> }[] }
}

function setup(o: Partial<TelemetryOptions> & { status?: number | (() => number) } = {}) {
  const sent: Sent[] = []
  let enabled = true
  const fetchStub = (async (url: string, init: RequestInit) => {
    const body = String(init.body)
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    sent.push({ url, body, json: JSON.parse(body) })
    const status = typeof o.status === 'function' ? o.status() : (o.status ?? 204)
    return new Response(null, { status })
  }) as unknown as typeof fetch
  const dataDir = tmpDir()
  const t = new Telemetry({
    dataDir,
    appVersion: '5.0.0',
    url: 'https://collector.test/v1/events',
    enabled: () => enabled,
    fetch: fetchStub,
    platform: 'darwin',
    arch: 'arm64',
    scrub: { home: '/Users/murad', user: 'murad', appPath: '/Applications/Xari Bulbul.app/Contents/Resources/app.asar' },
    ...o,
  })
  return { t, sent, dataDir, setEnabled: (v: boolean) => (enabled = v) }
}

const valid = (s: Sent) => {
  const r = validateBatch(s.json, Date.now())
  expect(r, r.ok ? '' : r.error).toMatchObject({ ok: true })
  expect(Buffer.byteLength(s.body)).toBeLessThanOrEqual(LIMITS.maxBodyBytes)
}

describe('telemetry', () => {
  it('sends batches the collector accepts', async () => {
    const { t, sent, dataDir } = setup()
    t.event('app.start')
    t.count('feature.chat_sent', { bot: false })
    t.count('feature.chat_sent', { bot: false })
    t.count('feature.chat_sent', { bot: true })
    t.count('feature.tool', { kind: 'edit' })
    t.count('feature.plugin_installed', { id: 'blender' })
    t.event('onboarding.skipped', { step: 'provider' })
    t.error('error.main', new Error(`ENOENT: no such file or directory, open '/Users/murad/secret project/plan.txt'`))
    // Nested and odd props are dropped instead of sinking the batch.
    t.event('feature.settings_page', { page: 'model.main', nested: { a: 1 } as unknown as string, nan: NaN, 'bad key!': 1 })
    t.event('Bad Name')
    await t.flush()
    expect(sent).toHaveLength(1)
    valid(sent[0])
    const { json } = sent[0]
    expect(Object.keys(json).sort()).toEqual(['appVersion', 'arch', 'events', 'installId', 'os'])
    expect(json).toMatchObject({ appVersion: '5.0.0', os: 'darwin', arch: 'arm64', installId: installId(dataDir) })
    const names = json.events.map((e) => e.name)
    expect(names).not.toContain('Bad Name')
    expect(json.events.find((e) => e.name === 'feature.chat_sent' && e.props?.bot === false)?.props).toEqual({ bot: false, count: 2 })
    expect(json.events.find((e) => e.name === 'feature.settings_page')?.props).toEqual({ page: 'model.main' })
    const err = json.events.find((e) => e.name === 'error.main')!
    expect(err.props!.message).toBe("Error: ENOENT: no such file or directory, open '<path>'")
    expect(JSON.stringify(json)).not.toMatch(/murad|secret project|plan\.txt/)
    // Sent once: the queue is empty afterwards.
    await t.flush()
    expect(sent).toHaveLength(1)
  })

  it('keeps the same install id, in the data folder', () => {
    const dir = tmpDir()
    const id = installId(dir)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(installId(dir)).toBe(id)
    expect(fs.readFileSync(path.join(dir, 'install-id'), 'utf8').trim()).toBe(id)
  })

  it('splits into batches of at most 100 events under the size limit', async () => {
    const { t, sent } = setup()
    for (let i = 0; i < 250; i++) t.event('feature.test', { i })
    // Big error events: 100 of these would be over 64 KB.
    for (let i = 0; i < 25; i++) t.error('error.renderer', Object.assign(new Error(`boom ${i} ${'x'.repeat(600)}`), { stack: `Error\n${'    at f (<anon>)\n'.repeat(60)}` }))
    await t.flush()
    expect(sent.length).toBeGreaterThanOrEqual(3)
    for (const s of sent) {
      valid(s)
      expect(s.json.events.length).toBeLessThanOrEqual(100)
    }
    expect(sent.reduce((n, s) => n + s.json.events.length, 0)).toBe(275)
  })

  it('sends nothing when the user opted out, and drops what was queued', async () => {
    const { t, sent, dataDir, setEnabled } = setup()
    t.event('app.start')
    t.count('feature.voice_input')
    setEnabled(false)
    t.event('feature.chat_sent')
    await t.flush()
    expect(sent).toHaveLength(0)
    expect(fs.existsSync(path.join(dataDir, 'install-id'))).toBe(false)
    // Turned back on: the old queue is gone.
    setEnabled(true)
    await t.flush()
    expect(sent).toHaveLength(0)
  })

  it('sends nothing with an empty URL', async () => {
    const { t, sent } = setup({ url: '' })
    t.event('app.start')
    t.error('crash.main', new Error('x'))
    await t.flush()
    expect(sent).toHaveLength(0)
    expect(t.active).toBe(false)
  })

  it('holds events until ready, then sends them', async () => {
    let ready = false
    const { t, sent } = setup({ ready: () => ready })
    t.event('app.start')
    await t.flush()
    expect(sent).toHaveLength(0)
    ready = true
    await t.flush()
    expect(sent).toHaveLength(1)
    valid(sent[0])
  })

  it('drops a rejected or rate-limited batch, and gives up on others after a few tries', async () => {
    for (const status of [400, 413, 429]) {
      const { t, sent } = setup({ status })
      t.event('app.start')
      await t.flush()
      await t.flush()
      expect(sent).toHaveLength(1)
    }
    const { t, sent } = setup({ status: 503 })
    t.event('app.start')
    for (let i = 0; i < 6; i++) await t.flush()
    expect(sent).toHaveLength(3)
    // Offline (fetch throws) counts the same way.
    const offline = setup({ fetch: (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch })
    offline.t.event('app.start')
    for (let i = 0; i < 5; i++) await offline.t.flush()
  })

  it('reports the same error once per run', async () => {
    const { t, sent } = setup()
    for (let i = 0; i < 5; i++) t.error('error.main', new Error('same'))
    await t.flush()
    expect(sent[0].json.events).toHaveLength(1)
  })

  it('picks the URL from the environment', () => {
    expect(telemetryUrl({})).toBe(TELEMETRY_URL)
    expect(TELEMETRY_URL).toBe('https://193-122-49-121.sslip.io/v1/events')
    expect(telemetryUrl({ XB_TELEMETRY_URL: 'http://localhost:8787/v1/events' })).toBe('http://localhost:8787/v1/events')
    expect(telemetryUrl({ XB_TELEMETRY_URL: '' })).toBe('')
    expect(telemetryUrl({ XB_TELEMETRY: '0' })).toBe('')
    expect(telemetryUrl({ VITEST: 'true' })).toBe('')
    // This test run itself never sends.
    expect(telemetryUrl()).toBe('')
  })
})

describe('scrubText', () => {
  const ctx = { home: '/Users/murad', user: 'murad', appPath: '/Applications/Xari Bulbul.app/Contents/Resources/app.asar' }

  it('keeps the app’s own stack frames and removes every other path', () => {
    const stack = [
      'TypeError: Cannot read properties of undefined',
      '    at AppController.send (/Applications/Xari Bulbul.app/Contents/Resources/app.asar/out/main/index.js:120:7)',
      '    at file:///Applications/Xari%20Bulbul.app/Contents/Resources/app.asar/out/renderer/assets/index-B2x.js:1:2345',
      '    at load (/Users/murad/Projects/acme-secret/tool.mjs:3:9)',
      '    at node:internal/process/task_queues:95:5',
      '    at run (/opt/homebrew/lib/node_modules/thing/x.js:1:1)',
    ].join('\n')
    const out = scrubText(stack, ctx)
    expect(out).toContain('(<app>/out/main/index.js:120:7)')
    expect(out).toContain('at <app>/out/renderer/assets/index-B2x.js:1:2345')
    expect(out).toContain('at load (<path>:3:9)')
    expect(out).toContain('node:internal/process/task_queues:95:5')
    expect(out).toContain('at run (<path>:1:1)')
    expect(out).not.toMatch(/murad|acme|homebrew/)
  })

  it('removes Windows paths, the home folder, user names, emails and keys', () => {
    const win = { home: 'C:\\Users\\Murad', user: 'Murad', appPath: 'C:\\Users\\Murad\\AppData\\Local\\Programs\\Xari Bulbul\\resources\\app.asar' }
    expect(scrubText('at x (C:\\Users\\Murad\\AppData\\Local\\Programs\\Xari Bulbul\\resources\\app.asar\\out\\main\\index.js:1:2)', win)).toBe('at x (<app>\\out\\main\\index.js:1:2)')
    expect(scrubText('open D:\\work\\client\\notes.txt failed', win)).toBe('open <path> failed')
    expect(scrubText('at y (C:\\Users\\Murad\\code\\a.js:1:1)', win)).toBe('at y (<path>:1:1)')
    expect(scrubText('user murad@example.com said hi to MURAD', ctx)).toBe('user <email> said hi to <user>')
    expect(scrubText('401: Incorrect API key provided: sk-or-v1-abcdef0123456789abcdef', ctx)).toBe('401: Incorrect API key provided: <secret>')
    expect(scrubText('Authorization: Bearer abc.def.ghi-123456', ctx)).toBe('Authorization: Bearer <secret>')
    expect(scrubText('cd ~/Projects/x && ls', ctx)).toBe('cd <path> && ls')
    expect(scrubText("spawn '/Users/murad/My Files/run me.sh' ENOENT", ctx)).toBe("spawn '<path>' ENOENT")
    // macOS can hand back the home folder in decomposed Unicode.
    expect(scrubText('/Users/Gülşən/x.txt'.normalize('NFD'), { home: '/Users/Gülşən' })).toBe('<path>')
  })

  it('keeps plain text and URLs, and cuts to 500 characters', () => {
    expect(scrubText('fetch failed: https://openrouter.ai/api/v1/models 503', ctx)).toBe('fetch failed: https://openrouter.ai/api/v1/models 503')
    expect(scrubText('a/b and 50/50', ctx)).toBe('a/b and 50/50')
    expect(scrubText('x'.repeat(2000), ctx).length).toBeLessThanOrEqual(500)
  })
})

describe('model usage', () => {
  it('sums usage per provider and model into one event per send, then starts over', async () => {
    const { t, sent } = setup()
    t.modelUsage('openrouter', 'openai/gpt-5', { turns: 1, input: 1000, output: 200, cached: 100, cost: 0.0123 })
    t.modelUsage('openrouter', 'openai/gpt-5', { turns: 1, input: 500, output: 50, cached: 0, cost: 0.002 })
    t.modelUsage('openrouter', 'openai/gpt-5', { errors: 1 })
    t.modelUsage('ollama-cloud', 'gpt-oss:120b', { turns: 2, input: 10, output: 5, cost: null })
    t.modelUsage('custom', 'custom', { turns: 1, input: 7, output: 3, cost: -1, cached: NaN })
    await t.flush()
    expect(sent).toHaveLength(1)
    valid(sent[0])
    const usage = sent[0].json.events.filter((e) => e.name === 'usage.model')
    expect(usage).toHaveLength(3)
    expect(usage.find((e) => e.props?.model === 'openai/gpt-5')?.props).toEqual({
      provider: 'openrouter', model: 'openai/gpt-5', turns: 2, input: 1500, output: 250, cached: 100, errors: 1, cost: 0.0143,
    })
    // Unknown cost is left out rather than sent as 0.
    expect(usage.find((e) => e.props?.provider === 'ollama-cloud')?.props).not.toHaveProperty('cost')
    expect(usage.find((e) => e.props?.provider === 'custom')?.props).toEqual({ provider: 'custom', model: 'custom', turns: 1, input: 7, output: 3, cached: 0, errors: 0 })
    // The totals were flushed: nothing is sent again.
    await t.flush()
    expect(sent).toHaveLength(1)
    t.modelUsage('openrouter', 'openai/gpt-5', { turns: 1, input: 1, output: 1 })
    await t.flush()
    expect(sent[1].json.events).toHaveLength(1)
    expect(sent[1].json.events[0].props).toMatchObject({ turns: 1, input: 1 })
  })

  it('forgets model totals when share info is off', async () => {
    const { t, sent, setEnabled } = setup()
    t.modelUsage('openrouter', 'x', { turns: 1 })
    setEnabled(false)
    t.modelUsage('openrouter', 'x', { turns: 1 })
    setEnabled(true)
    await t.flush()
    expect(sent).toHaveLength(0)
  })

  it('the usage tracker reports every record to its listeners', () => {
    const u = new UsageTracker(null)
    const seen: string[] = []
    const off = u.onRecord((r) => seen.push(r.modelId))
    u.onRecord(() => {
      throw new Error('a broken listener')
    })
    const rec = { ts: 1, sessionId: 's', providerId: 'openrouter', promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: null }
    u.record({ ...rec, modelId: 'a' })
    off()
    u.record({ ...rec, modelId: 'b' })
    expect(seen).toEqual(['a'])
    expect(u.all()).toHaveLength(2)
  })
})

describe('what share info says about models and setup', () => {
  // A setup full of things that must never leave the machine.
  const SECRET = ['Acme Secret Gateway', 'acme-secret', 'internal.acme.corp', 'sk-acme-0123456789abcdef', 'Murad Qasimov', 'Grumpy Pirate',
    'You are a grumpy pirate', 'my-private-mcp', 'secret-mcp-token', '/Users/murad/clients/acme', 'Nightly secret report', 'my-finetune']
  const settings = parseSettings({
    providers: [
      { id: 'acme-secret', name: 'Acme Secret Gateway', baseUrl: 'https://internal.acme.corp/v1', headers: { authorization: 'Bearer sk-acme-0123456789abcdef' } },
      // A built-in pointed somewhere else is a custom endpoint too.
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://internal.acme.corp/openai/v1' },
      { id: 'ollama-local', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', requiresKey: false },
      { id: 'llama-local', name: 'Local (llama.cpp)', baseUrl: 'http://127.0.0.1:41234/v1', requiresKey: false },
    ],
    models: {
      default: { providerId: 'acme-secret', modelId: 'my-finetune' },
      fallbacks: [{ providerId: 'openrouter', modelId: 'openrouter/free' }],
    },
    bots: [{ id: 'b1', name: 'Grumpy Pirate', persona: 'You are a grumpy pirate', tagline: 'Arr', cwd: '/Users/murad/clients/acme' }],
    mcp: { servers: [{ id: 'my-private-mcp', name: 'my-private-mcp', transport: 'http', url: 'https://internal.acme.corp/mcp', headers: { authorization: 'secret-mcp-token' } }] },
    schedules: [{ id: 's1', name: 'Nightly secret report', cwd: '/Users/murad/clients/acme', prompt: 'summarize acme' }],
    profile: { name: 'Murad Qasimov', role: 'developer', experience: 'experienced', language: 'Turkish' },
    appearance: { layout: 'elite', theme: 'dark' },
    permissions: { mode: 'auto' },
    memory: { enabled: true },
    gateways: { whatsapp: { enabled: true, cwd: '/Users/murad/clients/acme', prefix: 'Grumpy Pirate: ' } },
    app: { openWorkspaces: ['/Users/murad/clients/acme'], lastWorkspace: '/Users/murad/clients/acme' },
  })

  it('sends custom providers, custom endpoints and unknown local files as custom', () => {
    const p = settings.providers
    expect(telemetryModel({ providerId: 'acme-secret', modelId: 'my-finetune' }, p)).toEqual({ provider: 'custom', model: 'custom' })
    expect(telemetryModel({ providerId: 'openai', modelId: 'gpt-5' }, p)).toEqual({ provider: 'custom', model: 'custom' })
    expect(telemetryModel({ providerId: 'gone', modelId: 'x' }, p)).toEqual({ provider: 'custom', model: 'custom' })
    expect(telemetryModel({ providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-5' }, p)).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' })
    expect(telemetryModel({ providerId: 'google', modelId: 'gemini-3-flash' }, p)).toEqual({ provider: 'google', model: 'gemini-3-flash' })
    // Fine-tunes carry an organisation's name.
    expect(telemetryModel({ providerId: 'mistral', modelId: 'ft:open-mistral-7b:acme:x' }, p).model).toBe('custom')
    // Local servers: the preset's id, but the model names are the user's.
    expect(telemetryModel({ providerId: 'ollama-local', modelId: 'my-finetune:latest' }, p)).toEqual({ provider: 'ollama-local', model: 'custom' })
    // The app's own llama.cpp server: curated downloads by file name, anything else custom.
    expect(telemetryModel({ providerId: 'llama-local', modelId: 'qwen3.5-4b' }, p)).toEqual({ provider: 'local', model: 'Qwen3.5-4B-Q4_K_M.gguf' })
    expect(telemetryModel({ providerId: 'llama-local', modelId: 'my-finetune' }, p)).toEqual({ provider: 'local', model: 'custom' })
    expect(telemetryProvider('openrouter', p)).toBe('openrouter')
  })

  it('builds a snapshot of counts, choices and on/off, with no names, paths or keys', async () => {
    const props = appSnapshot(settings, { osVersion: '15.1.0', locale: 'tr_TR', ramBytes: 16 * 1024 ** 3, cpus: 10, screen: { width: 1512, height: 982 } }, {
      connectedProviders: 3, plugins: 2, skills: 4, localModels: 1, voice: false, packaged: true,
    })
    expect(props).toEqual({
      os_version: '15.1', locale: 'tr-TR', ram: '16', cpus: '12', screen: '1440', packaged: true,
      layout: 'elite', theme: 'dark', mode: 'auto', provider: 'custom', providers: 3, mcp: 1, plugins: 2, skills: 4, bots: 1,
      features: 'bots,memory,fallbacks,local_models,whatsapp,schedules', role: 'developer', experience: 'experienced',
    })
    expect(Object.keys(props).length).toBeLessThanOrEqual(20)
    const text = JSON.stringify(props)
    for (const s of SECRET) expect(text).not.toContain(s)
    expect(text).not.toMatch(/acme|murad|pirate|https?:|\//i)
    for (const f of (props.features as string).split(',')) expect(SNAPSHOT_FEATURES).toContain(f)

    // Sent through the client, the whole batch passes the collector's validation and still names nothing.
    const { t, sent } = setup()
    t.event('app.snapshot', props)
    t.event('app.session', appSession(Date.now() - 95 * 60_000, Date.now(), 4))
    t.modelUsage(telemetryModel(settings.models.default, settings.providers).provider, telemetryModel(settings.models.default, settings.providers).model, { turns: 1, input: 10, output: 2 })
    t.count('feature.fallback', { from: telemetryProvider('acme-secret', settings.providers), to: 'openrouter' })
    t.count('feature.approval', { outcome: 'denied' })
    t.count('feature.tool_failed', { kind: 'execute' })
    t.count('feature.checkpoint_revert', { scope: 'file' })
    for (const n of ['feature.subagent', 'feature.compaction', 'feature.moa_turn']) t.count(n)
    await t.flush()
    expect(sent).toHaveLength(1)
    valid(sent[0])
    for (const s of SECRET) expect(sent[0].body).not.toContain(s)
    expect(sent[0].json.events.find((e) => e.name === 'app.session')?.props).toEqual({ minutes: 95, chats: 4 })
    expect(sent[0].json.events.find((e) => e.name === 'feature.fallback')?.props).toEqual({ from: 'custom', to: 'openrouter', count: 1 })
  })

  it('a fresh install reports defaults and unset profile', () => {
    const props = appSnapshot(parseSettings({}), {}, { connectedProviders: 0, plugins: 0, skills: 0, localModels: 0, voice: false, packaged: false })
    expect(props).toMatchObject({ os_version: 'unknown', locale: 'unknown', ram: 'unknown', screen: 'unknown', provider: 'openrouter', role: 'unset', experience: 'unset', features: 'memory', bots: 0, mcp: 0 })
  })

  it('buckets system details coarsely', () => {
    expect(osVersionBucket('10.0.22631')).toBe('10.0')
    expect(osVersionBucket('6.8.0-45-generic')).toBe('6.8')
    expect(osVersionBucket('26')).toBe('26.0')
    expect(osVersionBucket('')).toBe('unknown')
    expect(localeBucket('en-US')).toBe('en-US')
    expect(localeBucket('en_GB.UTF-8')).toBe('en-GB')
    expect(localeBucket('tr')).toBe('tr')
    expect(localeBucket('es-419')).toBe('es-419')
    expect(localeBucket('not a locale')).toBe('unknown')
    expect([4, 8, 16, 32, 64].map((g) => ramBucket(g * 1024 ** 3 - 1))).toEqual(['4', '8', '16', '32+', '32+'])
    expect([2, 4, 6, 12, 32].map(cpuBucket)).toEqual(['2', '4', '8', '12', '16+'])
    expect([1024, 1280, 1512, 1920, 3008].map((width) => screenBucket({ width, height: 900 }))).toEqual(['<1280', '1280', '1440', '1920', '2560+'])
    expect(appSession(0, 29_000, 0)).toEqual({ minutes: 0, chats: 0 })
  })
})
