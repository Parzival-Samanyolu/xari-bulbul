// Records xari-desktop.gif or qaqash.gif: the Electron app under xvfb against the scripted mock model.
// The app must be built for the edition first (both builds write apps/desktop/out):
//   pnpm --filter @harness/desktop build            && node docs/media/scripts/record-desktop.cjs xari
//   pnpm --filter @harness/desktop build:qaqash     && node docs/media/scripts/record-desktop.cjs qaqash
// Needs: xvfb (run via `xvfb-run -a`), ffmpeg, playwright, the electron binary from node_modules.
// Usage: NODE_PATH=$(npm root -g) xvfb-run -a node docs/media/scripts/record-desktop.cjs <xari|qaqash> [outFile]
const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright')
const { sleep, startMock, assemble } = require('./lib.cjs')

const root = path.resolve(__dirname, '../../..')
const edition = process.argv[2] === 'qaqash' ? 'qaqash' : 'xari'
const out = path.resolve(process.argv[3] || path.join(__dirname, '..', edition === 'qaqash' ? 'qaqash.gif' : 'xari-desktop.gif'))
const work = `/tmp/demo-desk-${edition}`
const proj = path.join(work, 'shop-api')
const data = path.join(work, 'data')
const PORT = edition === 'qaqash' ? 47822 : 47812
const electronBin = [path.join(root, 'node_modules/electron/dist/electron'), path.join(root, 'apps/desktop/node_modules/electron/dist/electron'), process.env.ELECTRON_BIN].find((p) => p && fs.existsSync(p))
if (!electronBin) throw new Error('electron binary not found; run pnpm install or set ELECTRON_BIN')

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
  const settings = {
    app: { onboarded: true, layoutChosen: true, lastWorkspace: proj, openWorkspaces: [proj] },
    providers: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, requiresKey: false }],
    models: { default: { providerId: 'mock', modelId: 'mock' } },
    permissions: { mode: 'auto' },
    memory: { autoReview: false },
    tools: { loadUserExtensions: false },
    ...(edition === 'qaqash' ? { bots: [{ id: 'ayla', name: 'Ayla', enabled: true }, { id: 'deniz', name: 'Deniz', enabled: true }] } : {}),
  }
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings))
  const mock = startMock(PORT, edition === 'qaqash' ? 'bot' : 'code')
  await sleep(800)
  const app = await _electron.launch({ executablePath: electronBin, args: [path.join(root, 'apps/desktop'), '--no-sandbox'], env: { ...process.env, HOME: work, HARNESS_DATA_DIR: data, HARNESS_TELEMETRY: 'off' } })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1200, height: 760 })
  await win.waitForTimeout(3500)

  const fdir = path.join(work, 'frames')
  fs.mkdirSync(fdir, { recursive: true })
  const frames = []
  const t0 = Date.now()
  let running = true
  const loop = (async () => {
    while (running) {
      const s = Date.now()
      const file = path.join(fdir, `f${String(frames.length).padStart(4, '0')}.png`)
      try {
        fs.writeFileSync(file, await win.screenshot())
        frames.push({ file, t: s - t0 })
      } catch {}
      await sleep(Math.max(0, 110 - (Date.now() - s)))
    }
  })()
  const bodyHas = async (re, ms = 30000) => {
    const s = Date.now()
    while (Date.now() - s < ms) {
      if (re.test(await win.evaluate(() => document.body.innerText))) return
      await sleep(100)
    }
    throw new Error('timeout waiting for ' + re)
  }
  const type = async (text) => {
    await win.click('textarea')
    await win.keyboard.type(text, { delay: 55 })
  }

  if (edition === 'xari') {
    await sleep(1500)
    await type('add input validation to POST /orders')
    await sleep(500)
    await win.keyboard.press('Enter')
    await bodyHas(/Done\./)
    await sleep(3500)
    if (!fs.readFileSync(path.join(proj, 'src/orders.js'), 'utf8').includes('status(400)')) throw new Error('the demo edit did not land')
  } else {
    await sleep(1500)
    await win.getByText('Ayla', { exact: true }).first().click()
    await sleep(1200)
    await type('plan me a lazy weekend')
    await sleep(500)
    await win.keyboard.press('Enter')
    await bodyHas(/Want me to put it in your calendar/)
    await sleep(2500)
    await win.getByText('Automations', { exact: false }).first().click()
    await sleep(2500)
  }
  running = false
  await loop
  await app.close()
  mock.kill()
  assemble(frames, out, { width: 1000, fps: 9, colors: 128, holdMs: 1200 })
  console.log(frames.length, 'frames')
})().catch((e) => { console.error(e); process.exit(1) })
