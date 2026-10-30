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
  assert.deepEqual(s.totals, { events: 8, installs: 3 })
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
