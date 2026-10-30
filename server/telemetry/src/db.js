import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const RETENTION_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000

/** Event names counted as errors in the stats: anything starting with "error" or "crash". */
const ERROR_WHERE = `(name LIKE 'error%' OR name LIKE 'crash%')`

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY,
      received_at INTEGER NOT NULL,  -- server time, ms
      day         TEXT    NOT NULL,  -- UTC yyyy-mm-dd of received_at
      install_id  TEXT    NOT NULL,
      app_version TEXT    NOT NULL,
      os          TEXT    NOT NULL,
      arch        TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      client_ts   INTEGER NOT NULL,
      props       TEXT               -- JSON object or NULL
    );
    CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
    CREATE INDEX IF NOT EXISTS events_day_install ON events (day, install_id);
    CREATE INDEX IF NOT EXISTS events_name ON events (name, received_at);
    -- Latest snapshot per install, sessions and model usage all filter by name, then group by install.
    CREATE INDEX IF NOT EXISTS events_name_install ON events (name, install_id, id);
    -- Installs ever and active installs per window.
    CREATE INDEX IF NOT EXISTS events_install_received ON events (install_id, received_at);
  `)
  return new Store(db)
}

class Store {
  constructor(db) {
    this.db = db
    this.insertStmt = db.prepare(`INSERT INTO events
      (received_at, day, install_id, app_version, os, arch, name, client_ts, props)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  }

  insertBatch(batch, receivedAt) {
    const day = new Date(receivedAt).toISOString().slice(0, 10)
    this.db.exec('BEGIN')
    try {
      for (const ev of batch.events) {
        this.insertStmt.run(
          receivedAt, day, batch.installId, batch.appVersion, batch.os, batch.arch,
          ev.name, ev.ts, ev.props ? JSON.stringify(ev.props) : null,
        )
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Deletes events received more than RETENTION_DAYS ago. Returns rows deleted. */
  prune(now = Date.now(), days = RETENTION_DAYS) {
    const r = this.db.prepare('DELETE FROM events WHERE received_at < ?').run(now - days * DAY_MS)
    return Number(r.changes)
  }

  stats(now = Date.now(), days = 30) {
    const since = now - days * DAY_MS
    const all = (sql, ...p) => this.db.prepare(sql).all(...p).map((r) => ({ ...r }))
    const totals = this.db.prepare(`SELECT COUNT(*) AS events, COUNT(DISTINCT install_id) AS installs
      FROM events WHERE received_at >= ?`).get(since)
    const distinct = (from) => Number(this.db.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE received_at >= ?').get(from).n)
    return {
      generatedAt: new Date(now).toISOString(),
      windowDays: days,
      totals: {
        events: Number(totals.events),
        installs: Number(totals.installs),
        /** Every install seen while its events are kept (180 days). */
        installsEver: Number(this.db.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM events').get().n),
        active: { d1: distinct(now - DAY_MS), d7: distinct(now - 7 * DAY_MS), d30: distinct(now - 30 * DAY_MS) },
      },
      models: {
        d1: this.models(now - DAY_MS),
        d7: this.models(now - 7 * DAY_MS),
        d30: this.models(now - 30 * DAY_MS),
      },
      tokensPerDay: all(`SELECT day,
          SUM(COALESCE(json_extract(props, '$.input'), 0)) AS input,
          SUM(COALESCE(json_extract(props, '$.output'), 0)) AS output,
          SUM(COALESCE(json_extract(props, '$.cached'), 0)) AS cached,
          SUM(COALESCE(json_extract(props, '$.turns'), 0)) AS turns
        FROM events WHERE name = 'usage.model' AND received_at >= ? GROUP BY day ORDER BY day`, since).map(nums),
      providers: share(all(`SELECT json_extract(props, '$.provider') AS provider,
          SUM(COALESCE(json_extract(props, '$.turns'), 0)) AS turns,
          COUNT(DISTINCT install_id) AS installs
        FROM events WHERE name = 'usage.model' AND received_at >= ? GROUP BY 1 ORDER BY turns DESC, provider`, since).map(nums)),
      setups: this.setups(since),
      sessions: this.sessions(since),
      dailyActiveInstalls: all(`SELECT day, COUNT(DISTINCT install_id) AS installs
        FROM events WHERE received_at >= ? GROUP BY day ORDER BY day`, since),
      // Each install counts once, under the version it sent most recently.
      versions: all(`SELECT version, COUNT(*) AS installs FROM (
          SELECT e.install_id, e.app_version AS version FROM events e
          JOIN (SELECT install_id, MAX(id) AS last FROM events WHERE received_at >= ? GROUP BY install_id) l
            ON e.id = l.last)
        GROUP BY version ORDER BY installs DESC, version DESC`, since),
      os: all(`SELECT os, arch, COUNT(DISTINCT install_id) AS installs
        FROM events WHERE received_at >= ? GROUP BY os, arch ORDER BY installs DESC, os, arch`, since),
      topEvents: all(`SELECT name, COUNT(*) AS count, COUNT(DISTINCT install_id) AS installs
        FROM events WHERE received_at >= ? GROUP BY name ORDER BY count DESC, name LIMIT 50`, since),
      recentErrors: all(`SELECT received_at AS receivedAt, name, app_version AS version, os, arch, props
        FROM events WHERE ${ERROR_WHERE} ORDER BY received_at DESC, id DESC LIMIT 50`).map((r) => ({
        ...r,
        receivedAt: new Date(Number(r.receivedAt)).toISOString(),
        props: r.props ? JSON.parse(r.props) : null,
      })),
    }
  }

  /** Models since `from`: the top 20 by turns and by tokens, with sums. */
  models(from) {
    const rows = this.db.prepare(`SELECT json_extract(props, '$.provider') AS provider, json_extract(props, '$.model') AS model,
        SUM(COALESCE(json_extract(props, '$.turns'), 0)) AS turns,
        SUM(COALESCE(json_extract(props, '$.input'), 0)) AS input,
        SUM(COALESCE(json_extract(props, '$.output'), 0)) AS output,
        SUM(COALESCE(json_extract(props, '$.cached'), 0)) AS cached,
        SUM(COALESCE(json_extract(props, '$.errors'), 0)) AS errors,
        SUM(json_extract(props, '$.cost')) AS cost,
        COUNT(DISTINCT install_id) AS installs
      FROM events WHERE name = 'usage.model' AND received_at >= ? GROUP BY 1, 2`).all(from).map((r) => {
      const n = nums({ ...r })
      return { ...n, cost: r.cost == null ? null : Math.round(Number(r.cost) * 1e6) / 1e6, tokens: n.input + n.output }
    })
    const top = (key) => [...rows].sort((a, b) => b[key] - a[key] || b.turns - a.turns || String(a.model).localeCompare(String(b.model))).slice(0, 20)
    return { byTurns: top('turns'), byTokens: top('tokens') }
  }

  /** A breakdown of the latest `app.snapshot` of each install seen since `from`. */
  setups(from) {
    const rows = this.db.prepare(`SELECT e.os, e.props FROM events e
      JOIN (SELECT MAX(id) AS id FROM events WHERE name = 'app.snapshot' AND received_at >= ? GROUP BY install_id) l ON e.id = l.id`).all(from)
    const snaps = rows.map((r) => ({ os: r.os, ...(r.props ? JSON.parse(r.props) : {}) }))
    const total = snaps.length
    const tally = (pick) => {
      const m = new Map()
      for (const s of snaps) {
        const v = pick(s)
        if (v === undefined || v === null || v === '') continue
        m.set(String(v), (m.get(String(v)) ?? 0) + 1)
      }
      return [...m].map(([value, installs]) => ({ value, installs, pct: pct(installs, total) }))
        .sort((a, b) => b.installs - a.installs || a.value.localeCompare(b.value))
    }
    const features = new Map(FEATURES.map((f) => [f, 0]))
    for (const s of snaps) for (const f of String(s.features ?? '').split(',')) if (f) features.set(f, (features.get(f) ?? 0) + 1)
    return {
      installs: total,
      os: tally((s) => (s.os_version ? `${s.os} ${s.os_version}` : s.os)),
      locale: tally((s) => s.locale),
      ram: tally((s) => s.ram),
      cpus: tally((s) => s.cpus),
      screen: tally((s) => s.screen),
      layout: tally((s) => s.layout),
      theme: tally((s) => s.theme),
      mode: tally((s) => s.mode),
      provider: tally((s) => s.provider),
      role: tally((s) => s.role),
      experience: tally((s) => s.experience),
      packaged: tally((s) => (typeof s.packaged === 'boolean' ? (s.packaged ? 'packaged' : 'dev') : undefined)),
      features: [...features].map(([feature, installs]) => ({ feature, installs, pct: pct(installs, total) }))
        .sort((a, b) => b.installs - a.installs || a.feature.localeCompare(b.feature)),
      averages: {
        providers: avg(snaps, 'providers'), mcp: avg(snaps, 'mcp'), plugins: avg(snaps, 'plugins'), skills: avg(snaps, 'skills'), bots: avg(snaps, 'bots'),
      },
    }
  }

  /** App sessions (`app.session`, sent on quit) since `from`. */
  sessions(from) {
    const rows = this.db.prepare(`SELECT json_extract(props, '$.minutes') AS minutes, json_extract(props, '$.chats') AS chats
      FROM events WHERE name = 'app.session' AND received_at >= ?`).all(from)
    const minutes = rows.map((r) => Number(r.minutes) || 0)
    const chats = rows.map((r) => Number(r.chats) || 0)
    return {
      count: rows.length,
      medianMinutes: median(minutes),
      medianChats: median(chats),
      avgChats: rows.length ? Math.round((chats.reduce((a, b) => a + b, 0) / rows.length) * 10) / 10 : 0,
    }
  }

  close() {
    this.db.close()
  }
}

/** The on/off features `app.snapshot` can list; always shown, even at 0%. */
const FEATURES = ['bots', 'voice', 'tts', 'memory', 'moa', 'fallbacks', 'local_models', 'imessage', 'whatsapp', 'schedules']

const pct = (n, total) => (total ? Math.round((1000 * n) / total) / 10 : 0)

function nums(r) {
  const out = { ...r }
  for (const k of ['turns', 'input', 'output', 'cached', 'errors', 'installs']) if (k in out) out[k] = Number(out[k] ?? 0)
  return out
}

function share(rows) {
  const total = rows.reduce((a, r) => a + r.turns, 0)
  return rows.map((r) => ({ ...r, pct: pct(r.turns, total) }))
}

function avg(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => typeof x === 'number')
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0
}

function median(v) {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
