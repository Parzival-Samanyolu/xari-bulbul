# xb-telemetry: the share-info collector

A small service that receives anonymous usage events from Xarı Bülbül when
**Settings › About › Privacy › Share anonymous usage info** is on. It is Node 22 with no dependencies (`node:http` and `node:sqlite`).
systemd runs it on the VPS `oracle-amd1`, behind Caddy at
`https://193-122-49-121.sslip.io`.

The app's `TELEMETRY_URL` is `https://193-122-49-121.sslip.io/v1/events`.

This folder is standalone. It is not part of the pnpm workspace and has no `node_modules`.

## What is collected

Each batch the app sends:

| Field        | Example                                | Notes                                    |
|--------------|----------------------------------------|------------------------------------------|
| `installId`  | `3f1c2b7e-8a4d-4c1e-9b2a-1d2e3f4a5b6c` | random UUID made on first launch, not tied to a person or machine |
| `appVersion` | `5.0.0`                                |                                          |
| `os`, `arch` | `darwin`, `arm64`                      | Node's `process.platform` / `process.arch` |
| `events[]`   | `{name, ts, props?}`                   | up to 100 per batch                      |

Event names look like `app.start`, `feature.voice_input` or `error.provider`, and match
`^[a-z0-9_.:-]{1,64}$`. `props` is a flat object with at most 20 string/number/boolean
values; strings are capped at 500 characters. Error events carry a message and a stack trace
with user paths removed by the app.

The server also stores the time it received the batch.

## What is never collected

- IP addresses. The client IP is used only for in-memory rate limiting, as a hash salted with
  a random value that is replaced every UTC day and never written anywhere. Caddy has no access log.
- Prompts, replies, code, file names, paths, API keys, account names or emails. The app never
  sends them. The server rejects any field it does not know about, and any nested or non-scalar value.
- Cookies, user agents and any other request headers.

Anything that fails validation is rejected whole (HTTP 400) and nothing from it is stored.

Events older than **180 days** are deleted daily (also at startup).

## API

| Method | Path                    | Result |
|--------|-------------------------|--------|
| POST   | `/v1/events`            | `204` stored · `400` invalid · `413` body over 64 KB · `415` not `application/json` · `429` rate limited |
| GET    | `/healthz`              | `200 ok` |
| GET    | `/v1/stats?token=TOKEN` | JSON stats (404 without the right token, or if no token is set) |
| GET    | `/?token=TOKEN`         | a small HTML dashboard of the same stats (no external assets) |

Rate limits are in memory: 30 batches per minute per IP hash, 10 batches per minute per
install, and 5000 events per install per UTC day.

## Environment

| Variable      | Default                            | Notes |
|---------------|------------------------------------|-------|
| `PORT`        | `8787`                             |       |
| `HOST`        | `127.0.0.1`                        | keep it on loopback; Caddy is the public side |
| `DB_PATH`     | `/var/lib/xb-telemetry/events.db`  | the SQLite file, in WAL mode; the directory is created if missing |
| `STATS_TOKEN` | *(unset)*                          | enables `/v1/stats` and `/`; unset means both return 404 |

On the VPS, `PORT`, `HOST` and `DB_PATH` are set in `xb-telemetry.service`. `STATS_TOKEN` is set in
`/etc/xb-telemetry/env` (root-only), which `deploy.sh` generates on the first deploy.

## Node and `node:sqlite`

`node:sqlite` arrived in Node 22.5 behind `--experimental-sqlite`. From 22.13 it works without
the flag but still prints an `ExperimentalWarning`. The unit and the npm scripts always pass
`--experimental-sqlite --disable-warning=ExperimentalWarning`, which works on every 22.x from
22.5 (the flag is a no-op on 22.13+). NodeSource's `setup_22.x` installs the latest 22.x.

## Run and test locally

```bash
cd server/telemetry
npm test                                          # node --test, temp databases
PORT=8787 DB_PATH=/tmp/xb/events.db STATS_TOKEN=dev npm start
open "http://127.0.0.1:8787/?token=dev"
```

## Deploy

From the Mac, with `ssh oracle-amd1` working and passwordless sudo on the host:

```bash
cd server/telemetry
./deploy.sh            # or ./deploy.sh <ssh-host>
```

The script is safe to run again, including for updates. It:

1. Runs the tests locally and stops if they fail.
2. Rsyncs the code to the host and installs it in `/opt/xb-telemetry`.
3. Installs Node 22 from NodeSource and Caddy from its official apt repo, if missing.
4. Creates `/etc/xb-telemetry/env` with a random `STATS_TOKEN` the first time, and prints it once.
5. Installs and restarts `xb-telemetry.service`. The service runs as a `DynamicUser` with its state in
   `/var/lib/xb-telemetry`, `MemoryMax=150M` and a hardened sandbox.
6. Installs `Caddyfile` as `/etc/caddy/sites/xb-telemetry.caddy`, imports it from
   `/etc/caddy/Caddyfile`, and reloads Caddy. Caddy gets the certificate itself.
7. Opens TCP 80/443 in iptables before Oracle's default `REJECT` rule, saves the rules with
   `netfilter-persistent` (`/etc/iptables/rules.v4`), and also allows them in ufw if ufw is active.
8. Checks `/healthz` on the host and over HTTPS.

**The Oracle Cloud VCN must also allow the ports.** Add ingress rules for TCP 80 and 443 from
`0.0.0.0/0` to the subnet's security list (Console › Networking › Virtual cloud networks ›
the VCN › the subnet › Security list), or to the instance's NSG. The script can't do this.

Useful commands on the host:

```bash
systemctl status xb-telemetry
journalctl -u xb-telemetry -f
sudo cat /etc/xb-telemetry/env                    # the stats token
sudo sqlite3 /var/lib/xb-telemetry/events.db      # if sqlite3 is installed
```

To rotate the token, edit `/etc/xb-telemetry/env` and run `sudo systemctl restart xb-telemetry`.

## Reading stats

Open `https://193-122-49-121.sslip.io/?token=TOKEN` for the dashboard, or fetch the JSON:

```bash
curl -s "https://193-122-49-121.sslip.io/v1/stats?token=TOKEN" | jq
```

Everything except `recentErrors` covers the last 30 days:

- `totals`: events and distinct installs
- `dailyActiveInstalls`: `[{day, installs}]`, UTC days, by receive time
- `versions`: `[{version, installs}]`
- `os`: `[{os, arch, installs}]`
- `topEvents`: the 50 most frequent `[{name, count, installs}]`
- `recentErrors`: the last 50 events whose name starts with `error` or `crash`, with their props

## Files

- `server.js`: the entry point. It reads the env, opens the DB, and schedules retention and rate-limit sweeps.
- `src/app.js`: the HTTP routes.
- `src/validate.js`: batch validation.
- `src/ratelimit.js`: rate limits and daily-salted IP hashing.
- `src/db.js`: the schema, inserts, stats and retention.
- `src/dashboard.js`: the dashboard HTML.
- `test/`: `node --test` suites.
- `xb-telemetry.service`, `Caddyfile`, `deploy.sh`: the deployment files.
