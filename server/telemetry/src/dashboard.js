// A single self-contained page: no external assets, no frameworks. It reads the
// token from its own URL and fetches /v1/stats with it. Charts are inline SVG and
// CSS bars drawn from the JSON.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Xarı Bülbül usage</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #131012; --panel: #1b171a; --line: #2e282c; --fg: #ece7ea; --muted: #a39aa0;
    --accent: #c9739a; --accent-2: #f0b9cf; --accent-3: #6e4a5c; --bad: #e88a7a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 72px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 2px; }
  h2 { font-size: 15px; font-weight: 600; margin: 40px 0 4px; }
  h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px; color: var(--muted); }
  p.note { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
  .muted { color: var(--muted); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 20px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
  .tile span { font-size: 12px; color: var(--muted); }
  .tile b { display: block; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
  @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-weight: 500; color: var(--muted); font-size: 12px; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.barcell { width: 28%; }
  .bar { height: 8px; background: var(--accent); border-radius: 2px; min-width: 2px; }
  .model { font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, Menlo, monospace; color: var(--muted); }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin: 0 8px 10px 0; }
  .seg button { background: none; border: 0; color: var(--muted); font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--accent-3); color: var(--fg); }
  .seg button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
  svg { display: block; width: 100%; height: auto; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .err { color: var(--bad); }
</style>
</head>
<body>
<main>
  <h1>Xarı Bülbül usage</h1>
  <div id="meta" class="muted">Loading…</div>
  <div class="tiles" id="tiles"></div>

  <h2>Activity</h2>
  <p class="note">Last 30 days, UTC, by the day events arrived.</p>
  <div class="grid2">
    <div class="panel"><h3>Active installs per day</h3><div id="dauChart"></div></div>
    <div class="panel"><h3>Tokens per day</h3><div id="tokChart"></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Input</span><span><i style="background:var(--accent-2)"></i>Output</span></div></div>
  </div>

  <h2>Models</h2>
  <p class="note">Summed over model requests. Custom providers and endpoints are counted as “custom”, without their names.</p>
  <div><span class="seg" id="period"></span><span class="seg" id="sortBy"></span></div>
  <div class="panel"><table id="models"></table></div>

  <div class="grid2">
    <section><h2>Providers</h2><p class="note">Share of model requests, 30 days.</p><div class="panel"><table id="providers"></table></div></section>
    <section><h2>Sessions</h2><p class="note">From app quits in the last 30 days.</p><div class="tiles" id="sessions" style="margin-top:0"></div></section>
  </div>

  <h2>Setups</h2>
  <p class="note" id="setupNote">The latest snapshot of each install active in the last 30 days.</p>
  <div class="panel" style="margin-bottom:14px"><h3>Features turned on</h3><table id="features"></table></div>
  <div class="grid3" id="setups"></div>

  <div class="grid2">
    <section><h2>Versions</h2><div class="panel"><table id="versions"></table></div></section>
    <section><h2>Operating systems</h2><div class="panel"><table id="os"></table></div></section>
  </div>
  <h2>Top events</h2>
  <div class="panel"><table id="events"></table></div>
  <h2>Recent errors</h2>
  <div class="panel"><table id="errors"></table></div>
</main>
<script>
(async () => {
  const token = new URLSearchParams(location.search).get('token') || ''
  const el = (id) => document.getElementById(id)
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const fmt = (n) => {
    n = Number(n) || 0
    const a = Math.abs(n)
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B'
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'
    if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k'
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return String(Math.round(n * 10) / 10)
  }
  const usd = (c) => c == null ? '<span class="muted">n/a</span>' : '$' + (c >= 100 ? c.toFixed(0) : c >= 1 ? c.toFixed(2) : c.toFixed(4))
  const bar = (v, max) => '<td class="barcell"><div class="bar" style="width:' + (max ? Math.max(1, 100 * v / max) : 0).toFixed(1) + '%"></div></td>'
  const table = (id, head, rows) => {
    el(id).innerHTML = '<tr>' + head.map((h) => '<th' + (h.n ? ' class="n"' : '') + '>' + esc(h.t ?? h) + '</th>').join('') + '</tr>' +
      (rows.length ? rows.join('') : '<tr><td class="muted" colspan="' + head.length + '">None yet</td></tr>')
  }
  const tiles = (id, list) => {
    el(id).innerHTML = list.map(([k, v]) => '<div class="tile"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('')
  }
  // Fills in missing days so the bars line up with the calendar.
  const lastDays = (n, now) => Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * 864e5).toISOString().slice(0, 10))
  const columns = (days, series, colors, label) => {
    const W = 600, H = 140, pad = 18, bw = W / days.length
    const max = Math.max(1, ...days.map((d) => series.reduce((a, s) => a + (s[d] || 0), 0)))
    let out = ''
    days.forEach((d, i) => {
      let y = H - pad
      series.forEach((s, j) => {
        const h = (H - 2 * pad) * (s[d] || 0) / max
        if (h > 0) out += '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (y - h).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" fill="' + colors[j] + '"><title>' + esc(d + ': ' + label(d)) + '</title></rect>'
        y -= h
      })
    })
    out += '<text x="0" y="11" fill="var(--muted)" font-size="11">' + esc(fmt(max)) + '</text>'
    out += '<text x="0" y="' + H + '" fill="var(--muted)" font-size="11">' + esc(days[0].slice(5)) + '</text>'
    out += '<text x="' + W + '" y="' + H + '" fill="var(--muted)" font-size="11" text-anchor="end">' + esc(days.at(-1).slice(5)) + '</text>'
    out += '<line x1="0" x2="' + W + '" y1="' + (H - pad) + '" y2="' + (H - pad) + '" stroke="var(--line)"/>'
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Bar chart">' + out + '</svg>'
  }
  const seg = (id, options, current, onPick) => {
    el(id).innerHTML = options.map(([v, t]) => '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (v === current) + '">' + esc(t) + '</button>').join('')
    el(id).onclick = (e) => {
      const b = e.target.closest('button')
      if (!b) return
      for (const x of el(id).children) x.setAttribute('aria-pressed', String(x === b))
      onPick(b.dataset.v)
    }
  }

  try {
    const r = await fetch('/v1/stats?token=' + encodeURIComponent(token), { cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const s = await r.json()
    const now = Date.parse(s.generatedAt)
    el('meta').textContent = 'Generated ' + new Date(s.generatedAt).toLocaleString()

    const t = s.totals, m30 = (s.models && s.models.d30) || { byTurns: [], byTokens: [] }
    const tok30 = (s.tokensPerDay || []).reduce((a, d) => a + d.input + d.output, 0)
    const cost30 = m30.byTurns.reduce((a, m) => a + (m.cost || 0), 0)
    tiles('tiles', [
      ['Installs ever', fmt(t.installsEver ?? t.installs)],
      ['Active today', fmt(t.active ? t.active.d1 : 0)],
      ['Active 7 days', fmt(t.active ? t.active.d7 : 0)],
      ['Active 30 days', fmt(t.active ? t.active.d30 : t.installs)],
      ['Tokens, 30 days', fmt(tok30)],
      ['Known cost, 30 days', '$' + cost30.toFixed(2)],
    ])

    const days = lastDays(30, now)
    const dau = Object.fromEntries(s.dailyActiveInstalls.map((d) => [d.day, d.installs]))
    el('dauChart').innerHTML = columns(days, [dau], ['var(--accent)'], (d) => (dau[d] || 0) + ' installs')
    const tin = {}, tout = {}
    for (const d of s.tokensPerDay || []) { tin[d.day] = d.input; tout[d.day] = d.output }
    el('tokChart').innerHTML = columns(days, [tin, tout], ['var(--accent)', 'var(--accent-2)'], (d) => fmt(tin[d] || 0) + ' in, ' + fmt(tout[d] || 0) + ' out')

    let period = 'd7', sortBy = 'turns'
    const drawModels = () => {
      const p = (s.models && s.models[period]) || { byTurns: [], byTokens: [] }
      const list = sortBy === 'turns' ? p.byTurns : p.byTokens
      const key = sortBy === 'turns' ? 'turns' : 'tokens'
      const max = Math.max(0, ...list.map((x) => x[key]))
      table('models', ['Model', 'Provider', '', { t: 'Requests', n: 1 }, { t: 'Input', n: 1 }, { t: 'Output', n: 1 }, { t: 'Cached', n: 1 }, { t: 'Cost', n: 1 }, { t: 'Errors', n: 1 }, { t: 'Installs', n: 1 }],
        list.map((x) => '<tr><td class="model">' + esc(x.model) + '</td><td>' + esc(x.provider) + '</td>' + bar(x[key], max) +
          '<td class="n">' + fmt(x.turns) + '</td><td class="n">' + fmt(x.input) + '</td><td class="n">' + fmt(x.output) + '</td><td class="n">' + fmt(x.cached) +
          '</td><td class="n">' + usd(x.cost) + '</td><td class="n' + (x.errors ? ' err' : '') + '">' + fmt(x.errors) + '</td><td class="n">' + x.installs + '</td></tr>'))
    }
    seg('period', [['d1', '1 day'], ['d7', '7 days'], ['d30', '30 days']], period, (v) => { period = v; drawModels() })
    seg('sortBy', [['turns', 'By requests'], ['tokens', 'By tokens']], sortBy, (v) => { sortBy = v; drawModels() })
    drawModels()

    const prov = s.providers || []
    table('providers', ['Provider', '', { t: 'Share', n: 1 }, { t: 'Requests', n: 1 }, { t: 'Installs', n: 1 }],
      prov.map((p) => '<tr><td>' + esc(p.provider) + '</td>' + bar(p.pct, 100) + '<td class="n">' + p.pct + '%</td><td class="n">' + fmt(p.turns) + '</td><td class="n">' + p.installs + '</td></tr>'))

    const ss = s.sessions || { count: 0, medianMinutes: 0, medianChats: 0, avgChats: 0 }
    tiles('sessions', [['Median minutes', fmt(ss.medianMinutes)], ['Median chats', fmt(ss.medianChats)], ['Average chats', fmt(ss.avgChats)], ['Sessions', fmt(ss.count)]])

    const su = s.setups || { installs: 0, features: [] }
    el('setupNote').textContent = 'The latest snapshot of each install active in the last 30 days (' + su.installs + ' installs).'
    table('features', ['Feature', '', { t: 'Installs', n: 1 }, { t: 'Share', n: 1 }],
      (su.features || []).map((f) => '<tr><td>' + esc(f.feature.replace(/_/g, ' ')) + '</td>' + bar(f.pct, 100) + '<td class="n">' + f.installs + '</td><td class="n">' + f.pct + '%</td></tr>'))
    const groups = [['os', 'OS version'], ['locale', 'Language'], ['ram', 'Memory (GB)'], ['cpus', 'CPU cores'], ['screen', 'Screen width'], ['layout', 'Layout'],
      ['theme', 'Theme'], ['mode', 'Permission mode'], ['provider', 'Default provider'], ['role', 'Role'], ['experience', 'Experience'], ['packaged', 'Build']]
    el('setups').innerHTML = groups.map(([k, title]) => '<div class="panel"><h3>' + esc(title) + '</h3><table id="setup-' + k + '"></table></div>').join('') +
      '<div class="panel"><h3>Averages per install</h3><table id="setup-avg"></table></div>'
    for (const [k] of groups) {
      const rows = (su[k] || []).slice(0, 10)
      table('setup-' + k, ['', '', { t: '%', n: 1 }], rows.map((x) => '<tr><td>' + esc(x.value) + '</td>' + bar(x.pct, 100) + '<td class="n">' + x.pct + '</td></tr>'))
    }
    const av = su.averages || {}
    table('setup-avg', ['', { t: 'Avg', n: 1 }], [['Connected providers', av.providers], ['MCP servers', av.mcp], ['Plugins', av.plugins], ['Skills', av.skills], ['Bots', av.bots]]
      .map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="n">' + fmt(v || 0) + '</td></tr>'))

    const vmax = Math.max(0, ...s.versions.map((v) => v.installs))
    table('versions', ['Version', '', { t: 'Installs', n: 1 }], s.versions.map((v) => '<tr><td>' + esc(v.version) + '</td>' + bar(v.installs, vmax) + '<td class="n">' + v.installs + '</td></tr>'))
    table('os', ['OS', 'Arch', { t: 'Installs', n: 1 }], s.os.map((o) => '<tr><td>' + esc(o.os) + '</td><td>' + esc(o.arch) + '</td><td class="n">' + o.installs + '</td></tr>'))
    table('events', ['Event', { t: 'Count', n: 1 }, { t: 'Installs', n: 1 }], s.topEvents.map((e) => '<tr><td class="model">' + esc(e.name) + '</td><td class="n">' + e.count + '</td><td class="n">' + e.installs + '</td></tr>'))
    table('errors', ['Received', 'Event', 'Version', 'OS', 'Details'], s.recentErrors.map((e) =>
      '<tr><td>' + esc(new Date(e.receivedAt).toLocaleString()) + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.version) +
      '</td><td>' + esc(e.os + ' ' + e.arch) + '</td><td><pre>' + esc(e.props ? JSON.stringify(e.props, null, 2) : '') + '</pre></td></tr>'))
  } catch (err) {
    el('meta').textContent = 'Could not load stats: ' + err.message
  }
})()
</script>
</body>
</html>
`
