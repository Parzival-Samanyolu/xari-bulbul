import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter } from '../src/ratelimit.js'

const DAY = 86400000
const clock = (t) => ({ now: () => t.v })

test('limits requests per IP per minute and resets next minute', () => {
  const t = { v: Date.UTC(2026, 9, 30, 12, 0, 5) }
  const rl = new RateLimiter({ ipPerMinute: 3, ...clock(t) })
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allowIp('1.2.3.4')), [true, true, true, false])
  assert.equal(rl.allowIp('5.6.7.8'), true, 'other IPs are independent')
  t.v += 60_000
  assert.equal(rl.allowIp('1.2.3.4'), true)
})

test('limits batches per install per minute and events per day', () => {
  const t = { v: Date.UTC(2026, 9, 30, 12) }
  const rl = new RateLimiter({ installPerMinute: 2, installPerDay: 150, ...clock(t) })
  assert.equal(rl.allowInstall('a', 100), true)
  assert.equal(rl.allowInstall('a', 10), true)
  assert.equal(rl.allowInstall('a', 1), false, 'third batch in the same minute')
  t.v += 60_000
  assert.equal(rl.allowInstall('a', 50), false, 'would exceed the daily event cap')
  t.v += 60_000
  assert.equal(rl.allowInstall('a', 40), true)
  t.v += DAY
  assert.equal(rl.allowInstall('a', 100), true, 'daily cap resets')
})

test('IP hashes are salted and rotate daily; raw IPs are never kept', () => {
  const t = { v: Date.UTC(2026, 9, 30, 1) }
  const rl = new RateLimiter(clock(t))
  const h1 = rl.hashIp('1.2.3.4')
  assert.equal(rl.hashIp('1.2.3.4'), h1, 'stable within a day')
  assert.notEqual(rl.hashIp('1.2.3.5'), h1)
  rl.allowIp('1.2.3.4')
  for (const k of rl.minute.keys()) assert.ok(!k.includes('1.2.3.4'))
  t.v += DAY
  assert.notEqual(rl.hashIp('1.2.3.4'), h1, 'new salt the next day')
  assert.notEqual(new RateLimiter(clock(t)).hashIp('1.2.3.4'), rl.hashIp('1.2.3.4'), 'salt is random per process')
})

test('sweep drops expired counters', () => {
  const t = { v: Date.UTC(2026, 9, 30, 12) }
  const rl = new RateLimiter(clock(t))
  rl.allowIp('1.1.1.1'); rl.allowInstall('a', 1)
  t.v += DAY + 60_000
  rl.sweep()
  assert.equal(rl.minute.size, 0)
  assert.equal(rl.daily.size, 0)
})
