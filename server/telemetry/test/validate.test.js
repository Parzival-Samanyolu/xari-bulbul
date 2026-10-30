import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBatch, LIMITS } from '../src/validate.js'

const NOW = Date.UTC(2026, 9, 30, 12)
const ID = '3f1c2b7e-8a4d-4c1e-9b2a-1d2e3f4a5b6c'
const good = (over = {}) => ({
  installId: ID, appVersion: '5.0.0', os: 'darwin', arch: 'arm64',
  events: [{ name: 'app.start', ts: NOW - 1000 }], ...over,
})
const err = (body) => {
  const r = validateBatch(body, NOW)
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(body).slice(0, 120)}`)
  return r.error
}

test('accepts a well-formed batch', () => {
  const r = validateBatch(good({ events: [
    { name: 'app.start', ts: NOW },
    { name: 'feature:voice_input', ts: NOW, props: { ok: true, ms: 12.5, provider: 'openrouter' } },
  ] }), NOW)
  assert.equal(r.ok, true)
  assert.equal(r.batch.events.length, 2)
  assert.deepEqual(r.batch.events[1].props, { ok: true, ms: 12.5, provider: 'openrouter' })
  assert.equal(r.batch.events[0].props, null)
})

test('lowercases the install id', () => {
  const r = validateBatch(good({ installId: ID.toUpperCase() }), NOW)
  assert.equal(r.ok, true)
  assert.equal(r.batch.installId, ID)
})

test('rejects non-uuid install ids', () => {
  for (const installId of ['', 'abc', 42, null, ID + 'x', '3f1c2b7e8a4d4c1e9b2a1d2e3f4a5b6c', '00000000-0000-0000-0000-000000000000'])
    assert.match(err(good({ installId })), /installId/)
})

test('rejects bad top-level shapes and unknown fields', () => {
  err(null); err([]); err('x'); err(42)
  assert.match(err(good({ ip: '1.2.3.4' })), /unknown field/)
  err(good({ appVersion: '' })); err(good({ appVersion: 'a b' })); err(good({ appVersion: 'x'.repeat(33) }))
  err(good({ os: 'Darwin' })); err(good({ os: 'beos' })); err(good({ arch: 'mips' }))
  err(good({ events: [] })); err(good({ events: {} }))
})

test('caps events per batch', () => {
  const ev = { name: 'x', ts: NOW }
  assert.equal(validateBatch(good({ events: Array(LIMITS.maxEvents).fill(ev) }), NOW).ok, true)
  assert.match(err(good({ events: Array(LIMITS.maxEvents + 1).fill(ev) })), /at most 100/)
})

test('event names must match the pattern', () => {
  for (const name of ['ok', 'a.b:c-d_e', '0', 'x'.repeat(64)])
    assert.equal(validateBatch(good({ events: [{ name, ts: NOW }] }), NOW).ok, true, name)
  for (const name of ['', 'Upper', 'has space', 'slash/x', 'x'.repeat(65), 'émoji', 7, null])
    assert.match(err(good({ events: [{ name, ts: NOW }] })), /event name/)
})

test('event timestamps and unknown event fields', () => {
  for (const ts of ['1', 1.5, NaN, Date.UTC(2020, 0, 1), NOW + 2 * 86400000, undefined])
    assert.match(err(good({ events: [{ name: 'x', ts }] })), /ts/)
  assert.match(err(good({ events: [{ name: 'x', ts: NOW, path: '/Users/me' }] })), /unknown event field/)
})

test('props must be flat with string/number/bool values', () => {
  const withProps = (props) => good({ events: [{ name: 'x', ts: NOW, props }] })
  for (const props of [[], 'x', null, { a: { b: 1 } }, { a: [1] }, { a: null }, { a: Infinity }, { 'bad key': 1 }, { '': 1 }])
    err(withProps(props))
  const tooMany = Object.fromEntries(Array.from({ length: LIMITS.maxProps + 1 }, (_, i) => [`k${i}`, i]))
  assert.match(err(withProps(tooMany)), /at most 20 props/)
  const maxed = Object.fromEntries(Array.from({ length: LIMITS.maxProps }, (_, i) => [`k${i}`, i]))
  assert.equal(validateBatch(withProps(maxed), NOW).ok, true)
  assert.equal(validateBatch(withProps({ s: 'x'.repeat(500) }), NOW).ok, true)
  assert.match(err(withProps({ s: 'x'.repeat(501) })), /500/)
})

test('prototype-polluting keys are rejected', () => {
  const body = JSON.parse(`{"installId":"${ID}","appVersion":"1.0.0","os":"linux","arch":"x64","events":[{"name":"x","ts":${NOW},"props":{"__proto__":{"a":1}}}]}`)
  err(body)
})
