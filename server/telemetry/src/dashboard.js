// A single self-contained page: no external assets, no frameworks. It reads the
// token from its own URL and fetches /v1/stats with it.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Xarı Bülbül usage</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1a1c; --muted: #6b6468; --line: #e4dfe2; --bg: #faf8f9; --accent: #8a2f55; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ece8ea; --muted: #a59ca1; --line: #352f32; --bg: #171416; --accent: #d98aa9; } }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 14px; font-weight: 600; margin: 32px 0 8px; }
  .muted { color: var(--muted); }
  .tiles { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
  .tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; min-width: 140px; }
  .tile b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 500; color: var(--muted); }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--accent); border-radius: 2px; min-width: 1px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, Menlo, monospace; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <h1>Xarı Bülbül usage</h1>
  <div id="meta" class="muted">Loading…</div>
  <div class="tiles" id="tiles"></div>
  <h2>Daily active installs</h2>
  <table id="dau"></table>
  <div class="grid">
    <section><h2>Versions</h2><table id="versions"></table></section>
    <section><h2>Operating systems</h2><table id="os"></table></section>
  </div>
  <h2>Top events</h2>
  <table id="events"></table>
  <h2>Recent errors</h2>
  <table id="errors"></table>
</main>
<script>
(async () => {
  const token = new URLSearchParams(location.search).get('token') || ''
  const el = (id) => document.getElementById(id)
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const table = (id, head, rows) => {
    el(id).innerHTML = '<tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
      (rows.length ? rows.join('') : '<tr><td class="muted" colspan="' + head.length + '">None yet</td></tr>')
  }
  try {
    const r = await fetch('/v1/stats?token=' + encodeURIComponent(token), { cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const s = await r.json()
    el('meta').textContent = 'Last ' + s.windowDays + ' days · generated ' + new Date(s.generatedAt).toLocaleString()
    const today = s.dailyActiveInstalls.at(-1)
    el('tiles').innerHTML = [
      ['Installs', s.totals.installs], ['Events', s.totals.events],
      ['Active today', today ? today.installs : 0], ['Errors shown', s.recentErrors.length],
    ].map(([k, v]) => '<div class="tile"><span class="muted">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('')
    const max = Math.max(1, ...s.dailyActiveInstalls.map((d) => d.installs))
    table('dau', ['Day', 'Installs', ''], s.dailyActiveInstalls.slice().reverse().map((d) =>
      '<tr><td>' + esc(d.day) + '</td><td class="n">' + d.installs + '</td><td style="width:50%"><div class="bar" style="width:' +
      (100 * d.installs / max).toFixed(1) + '%"></div></td></tr>'))
    table('versions', ['Version', 'Installs'], s.versions.map((v) => '<tr><td>' + esc(v.version) + '</td><td class="n">' + v.installs + '</td></tr>'))
    table('os', ['OS', 'Arch', 'Installs'], s.os.map((o) => '<tr><td>' + esc(o.os) + '</td><td>' + esc(o.arch) + '</td><td class="n">' + o.installs + '</td></tr>'))
    table('events', ['Event', 'Count', 'Installs'], s.topEvents.map((e) => '<tr><td>' + esc(e.name) + '</td><td class="n">' + e.count + '</td><td class="n">' + e.installs + '</td></tr>'))
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
