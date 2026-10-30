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
    return {
      generatedAt: new Date(now).toISOString(),
      windowDays: days,
      totals: { events: Number(totals.events), installs: Number(totals.installs) },
      dailyActiveInstalls: all(`SELECT day, COUNT(DISTINCT install_id) AS installs
        FROM events WHERE received_at >= ? GROUP BY day ORDER BY day`, since),
      versions: all(`SELECT app_version AS version, COUNT(DISTINCT install_id) AS installs
        FROM events WHERE received_at >= ? GROUP BY app_version ORDER BY installs DESC, version DESC`, since),
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

  close() {
    this.db.close()
  }
}
