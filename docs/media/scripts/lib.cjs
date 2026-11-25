// Shared helpers for the demo recordings: start the mock model, frame timeline -> optimised GIF via ffmpeg.
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startMock(port, mode) {
  return spawn(process.execPath, [path.join(__dirname, 'mock-model.cjs'), String(port), mode], { stdio: 'ignore' })
}

/** frames: [{ file, t }] with t in ms since start; holdMs keeps the last frame visible before looping. */
function assemble(frames, out, { width = 960, fps = 10, colors = 96, holdMs = 1500 } = {}) {
  const list = []
  frames.forEach((f, i) => {
    const next = frames[i + 1]
    const dur = next ? (next.t - f.t) / 1000 : holdMs / 1000
    list.push(`file '${f.file}'`, `duration ${Math.max(dur, 0.02).toFixed(3)}`)
  })
  list.push(`file '${frames[frames.length - 1].file}'`)
  const listFile = path.join(path.dirname(frames[0].file), 'list.txt')
  fs.writeFileSync(listFile, list.join('\n'))
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', vf, '-loop', '0', out], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed')
  const kb = Math.round(fs.statSync(out).size / 1024)
  const secs = ((frames[frames.length - 1].t - frames[0].t + holdMs) / 1000).toFixed(1)
  console.log(`${out}: ${kb} KB, ~${secs}s`)
}

module.exports = { sleep, startMock, assemble }
