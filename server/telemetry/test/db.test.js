import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'

const DAY = 86400000
const NOW = Date.UTC(2026, 9, 30, 12)
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let dir, store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xb-telemetry-'))
  store = openDb(join(dir, 'nested', 'events.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const batch = (installId, appVersion, os, arch, ...events) => ({
  installId, appVersion, os, arch, events: events.map(([name, props = null]) => ({ name, ts: NOW, props })),
})

test('uses WAL mode', () => {
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
})

test('stats: daily actives, versions, OS, top events and recent errors', () => {
  store.insertBatch(batch(A, '5.0.0', 'darwin', 'arm64', ['app.start'], ['feature.voice']), NOW - 2 * DAY)
  store.insertBatch(batch(A, '5.0.0', 'darwin', 'arm64', ['app.start']), NOW - DAY)
  store.insertBatch(batch(B, '4.9.0', 'linux', 'x64', ['app.start'], ['error', { message: 'boom' }]), NOW - DAY)
  store.insertBatch(batch(C, '5.0.0', 'win32', 'x64', ['app.start'], ['crash.main', { stack: 'at x' }]), NOW)
  store.insertBatch(batch(C, '5.0.0', 'win32', 'x64', ['errorless_but_named']), NOW)
  store.insertBatch(batch(B, '4.9.0', 'linux', 'x64', ['app.start']), NOW - 40 * DAY) // outside the 30-day window

  const s = store.stats(NOW)
  assert.deepEqual(s.totals, { events: 8, installs: 3, installsEver: 3, active: { d1: 3, d7: 3, d30: 3 } })
  assert.deepEqual(s.dailyActiveInstalls, [
    { day: '2026-10-28', installs: 1 },
    { day: '2026-10-29', installs: 2 },
    { day: '2026-10-30', installs: 1 },
  ])
  assert.deepEqual(s.versions, [{ version: '5.0.0', installs: 2 }, { version: '4.9.0', installs: 1 }])
  assert.deepEqual(s.os, [
    { os: 'darwin', arch: 'arm64', installs: 1 },
    { os: 'linux', arch: 'x64', installs: 1 },
    { os: 'win32', arch: 'x64', installs: 1 },
  ])
  assert.deepEqual(s.topEvents[0], { name: 'app.start', count: 4, installs: 3 })
  assert.equal(s.topEvents.length, 5)

  assert.deepEqual(s.recentErrors.map((e) => e.name), ['errorless_but_named', 'crash.main', 'error'])
  assert.deepEqual(s.recentErrors[1].props, { stack: 'at x' })
  assert.equal(s.recentErrors[1].receivedAt, new Date(NOW).toISOString())
  assert.equal(s.recentErrors[0].props, null)
})

test('recent errors are capped at 50, newest first', () => {
  for (let i = 0; i < 60; i++) store.insertBatch(batch(A, '5.0.0', 'darwin', 'arm64', ['error', { i }]), NOW - (60 - i) * 1000)
  const errs = store.stats(NOW).recentErrors
  assert.equal(errs.length, 50)
  assert.equal(errs[0].props.i, 59)
  assert.equal(errs[49].props.i, 10)
})

test('retention deletes events older than 180 days only', () => {
  store.insertBatch(batch(A, '1.0.0', 'linux', 'x64', ['old']), NOW - 181 * DAY)
  store.insertBatch(batch(A, '1.0.0', 'linux', 'x64', ['edge']), NOW - 180 * DAY + 1000)
  store.insertBatch(batch(A, '1.0.0', 'linux', 'x64', ['new']), NOW)
  assert.equal(store.prune(NOW), 1)
  const names = store.db.prepare('SELECT name FROM events ORDER BY id').all().map((r) => r.name)
  assert.deepEqual(names, ['edge', 'new'])
  assert.equal(store.prune(NOW), 0)
})

test('a failing batch is rolled back whole', () => {
  const bad = batch(A, '1.0.0', 'linux', 'x64', ['ok'], ['ok'])
  bad.events[1].name = null // violates NOT NULL
  assert.throws(() => store.insertBatch(bad, NOW))
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
})

const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const usage = (provider, model, o = {}) => ['usage.model', { provider, model, turns: 1, input: 0, output: 0, cached: 0, errors: 0, ...o }]

test('models: tokens per model for 1, 7 and 30 days; custom stays custom', () => {
  store.insertBatch(batch(A, '5.1.0', 'darwin', 'arm64',
    usage('openrouter', 'openai/gpt-5', { turns: 10, input: 10000, output: 2000, cached: 500, cost: 0.5 }),
    usage('custom', 'custom', { turns: 3, input: 90000, output: 100 }),
  ), NOW)
  store.insertBatch(batch(B, '5.1.0', 'linux', 'x64',
    usage('openrouter', 'openai/gpt-5', { turns: 5, input: 1000, output: 100, cost: 0.25, errors: 2 }),
    usage('ollama-cloud', 'gpt-oss:120b', { turns: 40, input: 400, output: 40 }),
  ), NOW - 3 * DAY)
  store.insertBatch(batch(C, '5.1.0', 'win32', 'x64', usage('google', 'gemini-3-flash', { turns: 1, input: 5, output: 5 })), NOW - 20 * DAY)
  store.insertBatch(batch(C, '5.1.0', 'win32', 'x64', usage('google', 'gemini-3-flash', { turns: 99 })), NOW - 40 * DAY)

  const s = store.stats(NOW)
  // Today: A only.
  assert.deepEqual(s.models.d1.byTurns.map((m) => m.model), ['openai/gpt-5', 'custom'])
  assert.deepEqual(s.models.d1.byTokens.map((m) => m.model), ['custom', 'openai/gpt-5'])
  const gpt = s.models.d7.byTurns.find((m) => m.model === 'openai/gpt-5')
  assert.deepEqual(gpt, { provider: 'openrouter', model: 'openai/gpt-5', turns: 15, input: 11000, output: 2100, cached: 500, errors: 2, cost: 0.75, installs: 2, tokens: 13100 })
  assert.deepEqual(s.models.d7.byTurns.map((m) => m.model), ['gpt-oss:120b', 'openai/gpt-5', 'custom'])
  const custom = s.models.d30.byTokens[0]
  assert.equal(custom.provider, 'custom')
  assert.equal(custom.model, 'custom')
  assert.equal(custom.cost, null)
  assert.equal(s.models.d30.byTurns.length, 4)
  // 40 days ago is outside every window.
  assert.equal(s.models.d30.byTurns.find((m) => m.provider === 'google').turns, 1)

  assert.deepEqual(s.tokensPerDay, [
    { day: '2026-10-10', input: 5, output: 5, cached: 0, turns: 1 },
    { day: '2026-10-27', input: 1400, output: 140, cached: 0, turns: 45 },
    { day: '2026-10-30', input: 100000, output: 2100, cached: 500, turns: 13 },
  ])
  assert.deepEqual(s.providers.map((p) => [p.provider, p.turns, p.pct]), [
    ['ollama-cloud', 40, 67.8], ['openrouter', 15, 25.4], ['custom', 3, 5.1], ['google', 1, 1.7],
  ])
})

test('setups: the latest snapshot per install, with feature adoption', () => {
  const snap = (o) => ['app.snapshot', { os_version: '15.1', locale: 'tr-TR', ram: '16', cpus: '8', screen: '1440', packaged: true, layout: 'basic', theme: 'system', mode: 'ask', provider: 'openrouter', providers: 1, mcp: 0, plugins: 0, skills: 0, bots: 0, features: 'memory', role: 'unset', experience: 'unset', ...o }]
  store.insertBatch(batch(A, '5.0.0', 'darwin', 'arm64', snap({ layout: 'basic', features: '' })), NOW - 2 * DAY)
  // A's newer snapshot replaces the older one.
  store.insertBatch(batch(A, '5.1.0', 'darwin', 'arm64', snap({ layout: 'elite', features: 'memory,bots,moa', role: 'developer', experience: 'experienced', providers: 3 })), NOW)
  store.insertBatch(batch(B, '5.1.0', 'linux', 'x64', snap({ os_version: '6.8', locale: 'en-US', ram: '32+', mode: 'auto', features: 'memory', provider: 'custom', providers: 1 })), NOW)
  store.insertBatch(batch(D, '5.1.0', 'win32', 'x64', ['app.start']), NOW)

  const s = store.stats(NOW).setups
  assert.equal(s.installs, 2)
  assert.deepEqual(s.layout, [{ value: 'basic', installs: 1, pct: 50 }, { value: 'elite', installs: 1, pct: 50 }])
  assert.deepEqual(s.os.map((o) => o.value), ['darwin 15.1', 'linux 6.8'])
  assert.deepEqual(s.locale.map((o) => o.value), ['en-US', 'tr-TR'])
  assert.deepEqual(s.ram.map((o) => o.value), ['16', '32+'])
  assert.deepEqual(s.role, [{ value: 'developer', installs: 1, pct: 50 }, { value: 'unset', installs: 1, pct: 50 }])
  assert.deepEqual(s.provider.map((o) => o.value), ['custom', 'openrouter'])
  assert.deepEqual(s.features.slice(0, 3), [
    { feature: 'memory', installs: 2, pct: 100 }, { feature: 'bots', installs: 1, pct: 50 }, { feature: 'moa', installs: 1, pct: 50 },
  ])
  assert.equal(s.features.find((f) => f.feature === 'whatsapp').pct, 0)
  assert.equal(s.averages.providers, 2)
})

test('sessions: median minutes and chats per session', () => {
  for (const [minutes, chats] of [[5, 0], [30, 2], [120, 7], [60, 3]]) store.insertBatch(batch(A, '5.1.0', 'darwin', 'arm64', ['app.session', { minutes, chats }]), NOW)
  assert.deepEqual(store.stats(NOW).sessions, { count: 4, medianMinutes: 45, medianChats: 2.5, avgChats: 3 })
})

test('stats from old clients only: the new sections are empty, not broken', () => {
  store.insertBatch(batch(A, '4.0.0', 'darwin', 'arm64', ['app.start'], ['feature.tool', { kind: 'edit', count: 3 }]), NOW)
  const s = store.stats(NOW)
  assert.deepEqual(s.models.d30, { byTurns: [], byTokens: [] })
  assert.deepEqual(s.tokensPerDay, [])
  assert.deepEqual(s.providers, [])
  assert.equal(s.setups.installs, 0)
  assert.equal(s.setups.features.every((f) => f.pct === 0), true)
  assert.deepEqual(s.sessions, { count: 0, medianMinutes: 0, medianChats: 0, avgChats: 0 })
  assert.equal(s.totals.installsEver, 1)
})

test('indexes for the new queries exist', () => {
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name)
  for (const n of ['events_name_install', 'events_install_received']) assert.ok(names.includes(n), n)
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT MAX(id) FROM events WHERE name = 'app.snapshot' AND received_at >= 0 GROUP BY install_id").all()
  assert.ok(plan.some((r) => /INDEX events_name/.test(r.detail)), JSON.stringify(plan))
})

test('versions: an install that updated counts once, under its newest version', () => {
  store.insertBatch(batch(A, '5.0.0', 'darwin', 'arm64', ['app.start']), NOW - 2 * DAY)
  store.insertBatch(batch(A, '5.0.1', 'darwin', 'arm64', ['app.start']), NOW - DAY)
  store.insertBatch(batch(A, '5.0.2', 'darwin', 'arm64', ['app.start']), NOW)
  store.insertBatch(batch(B, '5.0.1', 'linux', 'x64', ['app.start']), NOW)
  assert.deepEqual(store.stats(NOW).versions, [{ version: '5.0.2', installs: 1 }, { version: '5.0.1', installs: 1 }])
})
