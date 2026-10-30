import { createHash, randomBytes } from 'node:crypto'

// Fixed-window counters kept only in memory. Client IPs are never stored:
// they're hashed with a random salt that is regenerated every UTC day and
// never written anywhere, so yesterday's hashes can't be linked to today's.

export class RateLimiter {
  /**
   * @param {object} o
   * @param {number} o.ipPerMinute     batches per IP hash per minute
   * @param {number} o.installPerMinute batches per installId per minute
   * @param {number} o.installPerDay   events per installId per day
   * @param {() => number} [o.now]
   */
  constructor({ ipPerMinute = 30, installPerMinute = 10, installPerDay = 5000, now = Date.now } = {}) {
    this.limits = { ipPerMinute, installPerMinute, installPerDay }
    this.now = now
    this.saltDay = ''
    this.salt = Buffer.alloc(0)
    this.minute = new Map() // key -> { window, count }
    this.daily = new Map() // installId -> { day, count }
  }

  hashIp(ip) {
    const day = utcDay(this.now())
    if (day !== this.saltDay) {
      this.saltDay = day
      this.salt = randomBytes(32)
      this.minute.clear() // old hashes are meaningless with the new salt
    }
    return createHash('sha256').update(this.salt).update(String(ip)).digest('base64url').slice(0, 22)
  }

  /** Counts one request from this IP. Returns false if over the limit. */
  allowIp(ip) {
    return this.#hit(`ip:${this.hashIp(ip)}`, this.limits.ipPerMinute)
  }

  /** Counts one batch of `eventCount` events from this install. */
  allowInstall(installId, eventCount) {
    if (!this.#hit(`in:${installId}`, this.limits.installPerMinute)) return false
    const day = utcDay(this.now())
    let d = this.daily.get(installId)
    if (!d || d.day !== day) {
      d = { day, count: 0 }
      this.daily.set(installId, d)
    }
    if (d.count + eventCount > this.limits.installPerDay) return false
    d.count += eventCount
    return true
  }

  #hit(key, limit) {
    const window = Math.floor(this.now() / 60_000)
    let e = this.minute.get(key)
    if (!e || e.window !== window) {
      e = { window, count: 0 }
      this.minute.set(key, e)
    }
    e.count++
    return e.count <= limit
  }

  /** Drops expired counters so memory stays bounded. */
  sweep() {
    const window = Math.floor(this.now() / 60_000)
    for (const [k, e] of this.minute) if (e.window !== window) this.minute.delete(k)
    const day = utcDay(this.now())
    for (const [k, d] of this.daily) if (d.day !== day) this.daily.delete(k)
  }
}

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)
