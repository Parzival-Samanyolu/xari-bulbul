// Xarı Bülbül share-info collector. Zero runtime dependencies.
// Run: node --experimental-sqlite --disable-warning=ExperimentalWarning server.js
import { openDb } from './src/db.js'
import { createApp } from './src/app.js'
import { RateLimiter } from './src/ratelimit.js'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DB_PATH = process.env.DB_PATH || '/var/lib/xb-telemetry/events.db'
const STATS_TOKEN = process.env.STATS_TOKEN || ''

const store = openDb(DB_PATH)
const limiter = new RateLimiter()
const server = createApp({ store, statsToken: STATS_TOKEN, limiter })

function prune() {
  try {
    const n = store.prune()
    if (n) console.log(`retention: deleted ${n} events older than 180 days`)
  } catch (e) {
    console.error('retention failed:', e.message)
  }
}
prune()
const timers = [
  setInterval(prune, 24 * 60 * 60 * 1000),
  setInterval(() => limiter.sweep(), 60 * 1000),
]
for (const t of timers) t.unref()

server.listen(PORT, HOST, () => {
  console.log(`xb-telemetry listening on ${HOST}:${PORT}, db ${DB_PATH}, stats ${STATS_TOKEN ? 'on' : 'off'}`)
})

function shutdown(sig) {
  console.log(`${sig}: shutting down`)
  server.close(() => {
    store.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
