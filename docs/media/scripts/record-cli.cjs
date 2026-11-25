// Records xari-cli.gif: the terminal CLI in tmux against the scripted mock model, rendered with xterm.js.
// Needs: tmux, ffmpeg, playwright (chromium), a built CLI (pnpm build:cli).
// Usage: NODE_PATH=$(npm root -g) node docs/media/scripts/record-cli.cjs [outFile]
const fs = require('fs')
const path = require('path')
const { execFile, execFileSync } = require('child_process')
const { sleep, startMock, assemble } = require('./lib.cjs')
const { chromium } = require('playwright')

const root = path.resolve(__dirname, '../../..')
const out = path.resolve(process.argv[2] || path.join(__dirname, '../xari-cli.gif'))
const work = '/tmp/demo-cli'
const proj = path.join(work, 'shop-api')
const data = path.join(work, 'data')
const PORT = 47811
const COLS = 100
const ROWS = 32
const tmux = (...a) => execFileSync('tmux', a)
const capture = () => new Promise((r) => execFile('tmux', ['capture-pane', '-t', 'x', '-p', '-e'], (e, o) => r(e ? '' : o)))

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(
    path.join(proj, 'src/orders.js'),
    `const express = require('express')
const db = require('./db')
const app = express()
app.use(express.json())

app.get('/orders', (req, res) => res.json(db.all()))

app.post('/orders', (req, res) => {
  const order = db.insert(req.body)
  res.status(201).json(order)
})

module.exports = app
`,
  )
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ app: { onboarded: true }, providers: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, requiresKey: false }], models: { default: { providerId: 'mock', modelId: 'mock' } }, memory: { autoReview: false } }))
  const mock = startMock(PORT, 'code')
  await sleep(800)
  try { tmux('kill-session', '-t', 'x') } catch {}
  tmux('new-session', '-d', '-s', 'x', '-x', String(COLS), '-y', String(ROWS), `cd ${proj} && HARNESS_DATA_DIR=${data} node ${root}/apps/cli/dist/xari.mjs --mode ask`)

  const caps = []
  const t0 = Date.now()
  let running = true
  let latest = ''
  const loop = (async () => {
    while (running) {
      const s = Date.now()
      latest = await capture()
      if (latest.trim()) caps.push({ t: s - t0, ansi: latest })
      await sleep(Math.max(0, 100 - (Date.now() - s)))
    }
  })()
  const waitFor = async (re, ms = 20000) => {
    const s = Date.now()
    while (Date.now() - s < ms) {
      if (re.test(latest)) return
      await sleep(50)
    }
    throw new Error('timeout waiting for ' + re)
  }

  await waitFor(/Ask Xar/)
  await sleep(1300)
  const prompt = 'add input validation to POST /orders'
  for (let i = 0; i < prompt.length; i += 3) {
    tmux('send-keys', '-t', 'x', '-l', prompt.slice(i, i + 3))
    await sleep(75)
  }
  await sleep(500)
  tmux('send-keys', '-t', 'x', 'Enter')
  await waitFor(/Allow\?/)
  await sleep(3200)
  tmux('send-keys', '-t', 'x', '-l', '1')
  await waitFor(/Done\./)
  await sleep(3800)
  running = false
  await loop
  tmux('kill-session', '-t', 'x')
  mock.kill()
  const edited = fs.readFileSync(path.join(proj, 'src/orders.js'), 'utf8')
  if (!edited.includes('status(400)')) throw new Error('the demo edit did not land')

  // Render each distinct capture through xterm.js.
  const nm = path.join(root, 'node_modules/@xterm/xterm')
  const fdir = path.join(work, 'frames')
  fs.mkdirSync(fdir, { recursive: true })
  const b = await chromium.launch()
  const p = await b.newPage({ deviceScaleFactor: 1, viewport: { width: 1000, height: 800 } })
  await p.setContent(`<html><head><style>${fs.readFileSync(nm + '/css/xterm.css', 'utf8')} body{margin:0;background:#16121a;padding:14px;display:inline-block}</style></head><body><div id=t></div></body></html>`)
  await p.addScriptTag({ path: nm + '/lib/xterm.js' })
  await p.evaluate(({ cols, rows }) => {
    window.term = new window.Terminal({ cols, rows, fontSize: 15, fontFamily: 'DejaVu Sans Mono, monospace', theme: { background: '#16121a', foreground: '#ece4ea' }, cursorBlink: false })
    window.term.open(document.getElementById('t'))
  }, { cols: COLS, rows: ROWS })
  const body = await p.$('body')
  const frames = []
  let prev = null
  for (const c of caps) {
    if (c.ansi === prev) continue
    prev = c.ansi
    const file = path.join(fdir, `f${String(frames.length).padStart(4, '0')}.png`)
    await p.evaluate((d) => new Promise((r) => { window.term.reset(); window.term.write(d, r) }), c.ansi.replace(/\n/g, '\r\n').replace(/\r\n$/, ''))
    await body.screenshot({ path: file })
    frames.push({ file, t: c.t })
  }
  await b.close()
  assemble(frames, out, { width: 960, fps: 10, colors: 64, holdMs: 1200 })
  console.log(frames.length, 'distinct frames, captured', caps.length)
})().catch((e) => { console.error(e); process.exit(1) })
