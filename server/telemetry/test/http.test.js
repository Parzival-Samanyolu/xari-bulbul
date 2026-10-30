import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { RateLimiter } from '../src/ratelimit.js'

const ID = '3f1c2b7e-8a4d-4c1e-9b2a-1d2e3f4a5b6c'
const TOKEN = 'secret-token-123'
let dir, store, server, base

const body = (over = {}) => JSON.stringify({
  installId: ID, appVersion: '5.0.0', os: 'darwin', arch: 'arm64',
  events: [{ name: 'app.start', ts: Date.now() }], ...over,
})
const post = (data, headers = {}) =>
  fetch(base + '/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: data })
const count = () => store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'xb-telemetry-http-'))
  store = openDb(join(dir, 'events.db'))
  server = createApp({ store, statsToken: TOKEN, limiter: new RateLimiter({ ipPerMinute: 1000, installPerMinute: 1000 }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('healthz', async () => {
  const r = await fetch(base + '/healthz')
  assert.equal(r.status, 200)
  assert.equal(await r.text(), 'ok\n')
})

test('accepts a valid batch with 204 and stores server time, no IP', async () => {
  const before = count()
  const t0 = Date.now()
  const r = await post(body({ events: [{ name: 'app.start', ts: Date.now() - 5000, props: { first: true } }] }))
  assert.equal(r.status, 204)
  assert.equal(count(), before + 1)
  const row = store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get()
  assert.ok(row.received_at >= t0)
  assert.equal(row.props, '{"first":true}')
  assert.ok(!Object.keys(row).some((k) => /ip|addr|agent/i.test(k)))
  assert.ok(!JSON.stringify(row).includes('127.0.0.1'))
})

test('rejects invalid input without storing', async () => {
  const before = count()
  assert.equal((await post('not json')).status, 400)
  assert.equal((await post(body({ installId: 'nope' }))).status, 400)
  assert.equal((await post(body({ events: [{ name: 'BAD', ts: Date.now() }] }))).status, 400)
  assert.equal((await post(body(), { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await fetch(base + '/v1/events')).status, 405)
  assert.equal(count(), before)
})

test('enforces the 64 KB body cap', async () => {
  const big = body({ events: [{ name: 'x', ts: Date.now(), props: { s: 'y'.repeat(400) } }] }).padEnd(70 * 1024, ' ')
  assert.equal((await post(big)).status, 413)
})

test('enforces the body cap on chunked bodies without content-length', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(base + '/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    for (let i = 0; i < 80; i++) req.write(' '.repeat(1024))
    req.end()
  })
  assert.equal(status, 413)
})

test('rate limits per install id with 429', async () => {
  const s2Dir = mkdtempSync(join(tmpdir(), 'xb-telemetry-rl-'))
  const s2 = openDb(join(s2Dir, 'e.db'))
  const srv = createApp({ store: s2, limiter: new RateLimiter({ ipPerMinute: 100, installPerMinute: 2 }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/v1/events`
  const codes = []
  for (let i = 0; i < 3; i++)
    codes.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body() })).status)
  assert.deepEqual(codes, [204, 204, 429])
  srv.close(); s2.close(); rmSync(s2Dir, { recursive: true, force: true })
})

test('rate limits per forwarded client IP with 429', async () => {
  const s2Dir = mkdtempSync(join(tmpdir(), 'xb-telemetry-rl-'))
  const s2 = openDb(join(s2Dir, 'e.db'))
  const srv = createApp({ store: s2, limiter: new RateLimiter({ ipPerMinute: 2, installPerMinute: 100 }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/v1/events`
  const send = (ip) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: body() })
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await send('9.9.9.9')).status)
  codes.push((await send('8.8.8.8')).status)
  assert.deepEqual(codes, [204, 204, 429, 204])
  srv.close(); s2.close(); rmSync(s2Dir, { recursive: true, force: true })
})

test('stats and dashboard require the token', async () => {
  assert.equal((await fetch(base + '/v1/stats')).status, 404)
  assert.equal((await fetch(base + '/v1/stats?token=wrong')).status, 404)
  assert.equal((await fetch(base + '/?token=wrong')).status, 404)
  const r = await fetch(base + '/v1/stats?token=' + TOKEN)
  assert.equal(r.status, 200)
  const s = await r.json()
  assert.ok(Array.isArray(s.dailyActiveInstalls) && Array.isArray(s.recentErrors))
  for (const k of ['models', 'tokensPerDay', 'providers', 'setups', 'sessions']) assert.ok(k in s, k)
  assert.ok('installsEver' in s.totals && 'active' in s.totals)
  const d = await fetch(base + '/?token=' + TOKEN)
  assert.equal(d.status, 200)
  const html = await d.text()
  for (const h of ['Active installs per day', 'Tokens per day', 'Models', 'Providers', 'Setups', 'Sessions', 'Recent errors']) assert.match(html, new RegExp(h))
  assert.ok(!/<(link|img|iframe)\b/i.test(html), 'no external assets')
  assert.ok(!/(src|href)=["']https?:/.test(html), 'no external assets')
  assert.match(d.headers.get('content-security-policy'), /default-src 'none'/)
})

test('stats are disabled when no token is configured', async () => {
  const srv = createApp({ store })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const u = `http://127.0.0.1:${srv.address().port}`
  assert.equal((await fetch(u + '/v1/stats?token=')).status, 404)
  assert.equal((await fetch(u + '/v1/stats?token=anything')).status, 404)
  assert.equal((await fetch(u + '/')).status, 404)
  srv.close()
})
