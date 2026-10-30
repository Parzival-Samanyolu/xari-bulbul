import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { TELEMETRY_URL, Telemetry, installId, scrubText, telemetryUrl, type TelemetryOptions } from '../src/telemetry/client.js'
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
