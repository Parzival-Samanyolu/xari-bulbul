import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { validateBatch, LIMITS } from './validate.js'
import { RateLimiter } from './ratelimit.js'
import { DASHBOARD_HTML } from './dashboard.js'

/**
 * Builds the HTTP server. Nothing here listens or schedules timers; server.js does that.
 * @param {object} o
 * @param {ReturnType<typeof import('./db.js').openDb>} o.store
 * @param {string} [o.statsToken] enables /v1/stats and / when non-empty
 * @param {RateLimiter} [o.limiter]
 * @param {() => number} [o.now]
 */
export function createApp({ store, statsToken = '', limiter = new RateLimiter(), now = Date.now }) {
  const tokenHash = statsToken ? sha256(statsToken) : null

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        return send(res, 200, 'ok\n', 'text/plain; charset=utf-8')
      }

      if (path === '/v1/events') {
        if (req.method !== 'POST') return send(res, 405, null, null, { allow: 'POST' })
        return await handleEvents(req, res)
      }

      if (path === '/v1/stats' && req.method === 'GET') {
        if (!authorized(url)) return send(res, 404)
        return send(res, 200, JSON.stringify(store.stats(now())), 'application/json; charset=utf-8')
      }

      if (path === '/' && req.method === 'GET') {
        if (!authorized(url)) return send(res, 404)
        return send(res, 200, DASHBOARD_HTML, 'text/html; charset=utf-8', {
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
        })
      }

      return send(res, 404)
    } catch (err) {
      console.error('request failed:', err?.message ?? err)
      if (!res.headersSent) send(res, 500)
      else res.destroy()
    }
  })

  // Slowloris-ish protection; Caddy sits in front too.
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 5_000

  function authorized(url) {
    if (!tokenHash) return false
    const given = url.searchParams.get('token')
    if (!given) return false
    return timingSafeEqual(sha256(given), tokenHash)
  }

  async function handleEvents(req, res) {
    if (!limiter.allowIp(clientIp(req))) return drain(req, res, 429)

    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return drain(req, res, 415)

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) return drain(req, res, 413)

    const raw = await readBody(req, LIMITS.maxBodyBytes)
    if (raw === null) return send(res, 413, null, null, { connection: 'close' })

    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return send(res, 400)
    }
    const v = validateBatch(body, now())
    if (!v.ok) return send(res, 400, JSON.stringify({ error: v.error }), 'application/json; charset=utf-8')

    if (!limiter.allowInstall(v.batch.installId, v.batch.events.length)) return send(res, 429)

    store.insertBatch(v.batch, now())
    return send(res, 204)
  }

  return server
}

/**
 * The peer address, or the last X-Forwarded-For hop when the peer is the local
 * Caddy (Caddy replaces untrusted client-supplied XFF with the real address).
 * Only used to compute an in-memory rate-limit hash; never stored or logged.
 */
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? ''
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (local) {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff) return xff.split(',').pop().trim()
  }
  return peer
}

/** Reads the body up to `max` bytes; returns null (and stops reading) if larger. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > max) {
        done = true
        req.pause()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

/** Rejects without reading the body, closing the connection so it isn't reused mid-body. */
function drain(req, res, status) {
  req.resume()
  return send(res, status, null, null, { connection: 'close' })
}

function send(res, status, body = null, type = null, headers = {}) {
  const h = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
  if (type) h['content-type'] = type
  if (body != null) h['content-length'] = Buffer.byteLength(body)
  res.writeHead(status, h)
  res.end(body ?? undefined)
}

const sha256 = (s) => createHash('sha256').update(s).digest()
