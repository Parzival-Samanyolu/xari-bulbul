import { hashName } from './faces.js'

// Pixel-art avatars: turning a picture into a small sprite (background cleared, cropped,
// downscaled, alpha snapped, palette quantized, outlined), and a keyless creature sprite from a
// seed. Pure RGBA math, so the renderer runs it on canvas pixels and tests run it directly.

/** RGBA pixels, row by row (the layout of canvas ImageData). */
export interface Pixels {
  width: number
  height: number
  data: Uint8ClampedArray
}

export const PIXEL_GRID = 32
export const PIXEL_COLORS = 16

const blank = (width: number, height: number): Pixels => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })

const dist2 = (d: Uint8ClampedArray, i: number, r: number, g: number, b: number) => (d[i] - r) ** 2 + (d[i + 1] - g) ** 2 + (d[i + 2] - b) ** 2

/**
 * Makes a plain background transparent: the pixels joined to the edge whose color is close to
 * the edge's most common color. Left as is when the edge has no dominant color (a busy scene)
 * or when clearing would leave almost nothing.
 */
export function clearBackground(img: Pixels, tolerance = 48): Pixels {
  const { width: w, height: h, data } = img
  const edge: number[] = []
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x)
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1)
  // The edge's dominant color, in coarse buckets; already transparent edges need no clearing.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  let clear = 0
  for (const p of edge) {
    const i = p * 4
    if (data[i + 3] < 128) {
      clear++
      continue
    }
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    b.n++
    b.r += data[i]
    b.g += data[i + 1]
    b.b += data[i + 2]
    buckets.set(key, b)
  }
  if (clear > edge.length / 2) return img
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0]
  if (!top || top.n < edge.length * 0.35) return img
  const [r, g, b] = [top.r / top.n, top.g / top.n, top.b / top.n]
  const tol2 = tolerance * tolerance
  const out = new Uint8ClampedArray(data)
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  for (const p of edge) {
    if (!seen[p] && (data[p * 4 + 3] < 128 || dist2(data, p * 4, r, g, b) <= tol2)) {
      seen[p] = 1
      stack.push(p)
    }
  }
  let cleared = 0
  while (stack.length) {
    const p = stack.pop()!
    out[p * 4 + 3] = 0
    cleared++
    const x = p % w
    const y = (p - x) / w
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const q = ny * w + nx
      if (seen[q]) continue
      seen[q] = 1
      if (data[q * 4 + 3] < 128 || dist2(data, q * 4, r, g, b) <= tol2) stack.push(q)
    }
  }
  return cleared > w * h * 0.97 ? img : { width: w, height: h, data: out }
}

/** The square around the opaque pixels, with `pad` (a share of its side) around them. The whole picture when nothing is opaque. */
export function cropToContent(img: Pixels, pad = 0.06): Pixels {
  const { width: w, height: h, data } = img
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] >= 128) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return img
  const side = Math.ceil(Math.max(x1 - x0 + 1, y1 - y0 + 1) * (1 + pad * 2))
  const ox = Math.round((x0 + x1 + 1) / 2 - side / 2)
  const oy = Math.round((y0 + y1 + 1) / 2 - side / 2)
  const out = blank(side, side)
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const sx = ox + x
      const sy = oy + y
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
      out.data.set(data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * side + x) * 4)
    }
  return out
}

/** Area-average downscale, weighting color by alpha so cleared background doesn't bleed into edges. */
export function downscale(img: Pixels, width: number, height: number): Pixels {
  const { width: sw, height: sh, data } = img
  const acc = new Float64Array(width * height * 5)
  for (let y = 0; y < sh; y++) {
    const ty = Math.min(height - 1, Math.floor((y * height) / sh))
    for (let x = 0; x < sw; x++) {
      const tx = Math.min(width - 1, Math.floor((x * width) / sw))
      const i = (y * sw + x) * 4
      const a = data[i + 3] / 255
      const t = (ty * width + tx) * 5
      acc[t] += data[i] * a
      acc[t + 1] += data[i + 1] * a
      acc[t + 2] += data[i + 2] * a
      acc[t + 3] += a
      acc[t + 4] += 1
    }
  }
  const out = blank(width, height)
  for (let p = 0; p < width * height; p++) {
    const t = p * 5
    const a = acc[t + 3]
    if (!acc[t + 4] || !a) continue
    out.data[p * 4] = acc[t] / a
    out.data[p * 4 + 1] = acc[t + 1] / a
    out.data[p * 4 + 2] = acc[t + 2] / a
    out.data[p * 4 + 3] = (a / acc[t + 4]) * 255
  }
  return out
}

/** Every pixel fully opaque or fully clear, for crisp sprite edges. */
export function snapAlpha(img: Pixels, threshold = 128): Pixels {
  const data = new Uint8ClampedArray(img.data)
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= threshold ? 255 : 0
  return { ...img, data }
}

/** Median-cut palette of at most `colors` colors over the opaque pixels. */
export function palette(img: Pixels, colors = PIXEL_COLORS): [number, number, number][] {
  const px: [number, number, number][] = []
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] >= 128) px.push([img.data[i], img.data[i + 1], img.data[i + 2]])
  if (!px.length) return []
  const boxes: [number, number, number][][] = [px]
  const range = (box: [number, number, number][]) => {
    let best = 0,
      span = -1
    for (let c = 0; c < 3; c++) {
      let lo = 255,
        hi = 0
      for (const p of box) {
        if (p[c] < lo) lo = p[c]
        if (p[c] > hi) hi = p[c]
      }
      if (hi - lo > span) (span = hi - lo), (best = c)
    }
    return { channel: best, span }
  }
  while (boxes.length < colors) {
    // Split the box with the widest color range (ties: the bigger one).
    let pick = -1,
      pickSpan = 0,
      pickChannel = 0
    boxes.forEach((box, i) => {
      if (box.length < 2) return
      const r = range(box)
      if (r.span > pickSpan || (r.span === pickSpan && pick >= 0 && box.length > boxes[pick].length)) (pick = i), (pickSpan = r.span), (pickChannel = r.channel)
    })
    if (pick < 0 || pickSpan === 0) break
    const box = boxes[pick].sort((a, b) => a[pickChannel] - b[pickChannel])
    const mid = box.length >> 1
    boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid))
  }
  return boxes.map((box) => {
    const sum = box.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
    return sum.map((v) => Math.round(v / box.length)) as [number, number, number]
  })
}

/** Each opaque pixel mapped to the nearest of a median-cut palette of `colors` colors. */
export function quantize(img: Pixels, colors = PIXEL_COLORS): Pixels {
  const pal = palette(img, colors)
  const data = new Uint8ClampedArray(img.data)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    let best = 0,
      bestD = Infinity
    for (let k = 0; k < pal.length; k++) {
      const d = dist2(data, i, pal[k][0], pal[k][1], pal[k][2])
      if (d < bestD) (bestD = d), (best = k)
    }
    data[i] = pal[best][0]
    data[i + 1] = pal[best][1]
    data[i + 2] = pal[best][2]
  }
  return { ...img, data }
}

/** A 1px dark outline in the clear pixels around the sprite, tinted by the pixel it borders. */
export function outline(img: Pixels): Pixels {
  const { width: w, height: h, data } = img
  const out = new Uint8ClampedArray(data)
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 128
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) continue
      // The average of the bordering pixels, so mirrored sprites get mirrored outlines.
      const ns = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].filter(([nx, ny]) => opaque(nx, ny))
      if (!ns.length) continue
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) out[i + c] = (ns.reduce((s, [nx, ny]) => s + data[(ny * w + nx) * 4 + c], 0) / ns.length) * [0.28, 0.25, 0.3][c]
      out[i + 3] = 255
    }
  return { width: w, height: h, data: out }
}

export interface PixelateOptions {
  /** Side of the square sprite in pixels. */
  grid?: number
  colors?: number
  /** Clear a plain background. */
  transparent?: boolean
  outline?: boolean
}

/** A picture → a square pixel-art sprite. */
export function pixelate(img: Pixels, opts: PixelateOptions = {}): Pixels {
  const grid = opts.grid ?? PIXEL_GRID
  const cleared = opts.transparent === false ? img : clearBackground(img)
  const hasClear = cleared.data.some((v, i) => i % 4 === 3 && v < 128)
  // Leave a pixel of room around the sprite for its outline.
  const inner = opts.outline !== false && hasClear ? grid - 2 : grid
  let out = downscale(cropToContent(cleared, hasClear ? 0.02 : 0), inner, inner)
  if (inner !== grid) {
    const padded = blank(grid, grid)
    for (let y = 0; y < inner; y++) padded.data.set(out.data.subarray(y * inner * 4, (y + 1) * inner * 4), ((y + 1) * grid + 1) * 4)
    out = padded
  }
  out = quantize(snapAlpha(out), opts.colors ?? PIXEL_COLORS)
  return opts.outline !== false && hasClear ? outline(out) : out
}

// ---------------------------------------------------------------- creature sprites

/** Mulberry32: a small seeded random generator. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}


// Left halves (columns 0–7 of 16; the right half mirrors them). 0 empty, 1 maybe body, 2 body,
// 3 maybe an ear or a foot, E an eye. Column 0 and the edge rows stay empty for the outline.
const BODIES = [
  // round
  ['00000000', '00000330', '00001222', '00012222', '00122E22', '00122E22', '00122222', '01122222', '01122222', '00122222', '00122222', '00012222', '00001222', '00003300', '00003300', '00000000'],
  // tall, with ears
  ['00000000', '00030000', '00033000', '00012222', '00012E22', '00012E22', '00012222', '00112222', '01112222', '00012222', '00012222', '00012222', '00012222', '00003030', '00003030', '00000000'],
  // wide and squat
  ['00000000', '00000000', '00300000', '00330000', '00122222', '0122E222', '0122E222', '01222222', '01222222', '01222222', '01222222', '00122222', '00033003', '00033003', '00000000', '00000000'],
  // ghostly
  ['00000000', '00000000', '00001122', '00012222', '00122E22', '00122E22', '00122222', '00122222', '01122222', '00122222', '00122222', '00122222', '00122222', '00121212', '00101010', '00000000'],
]

type RGB = [number, number, number]

/**
 * A small symmetric creature from a seed (a bot's name, plus a counter for each reroll). The same
 * seed always gives the same sprite. 16×16, outlined, on a clear background.
 */
export function creatureSprite(seed: string): Pixels {
  const rand = seededRandom(hashName(seed) ^ 0x9e3779b9)
  const size = 16
  const half = 8
  const body = BODIES[Math.floor(rand() * BODIES.length)]
  const hue = Math.floor(rand() * 360)
  const accentHue = (hue + 150 + Math.floor(rand() * 60)) % 360
  const sat = 0.45 + rand() * 0.25
  const base = hsl(hue, sat, 0.64)
  const light = hsl(hue, sat, 0.78)
  const dark = hsl(hue, sat * 0.9, 0.5)
  const belly = hsl(hue, sat * 0.6, 0.86)
  const accent = hsl(accentHue, 0.6, 0.62)
  const ink: RGB = [43, 31, 40]
  const blush: RGB = [236, 143, 160]
  const fill = 0.55 + rand() * 0.3
  const hasBelly = rand() < 0.6
  const hasBlush = rand() < 0.5
  const bigEyes = rand() < 0.45
  const spots = rand() < 0.3
  const accentLimbs = rand() < 0.5
  const mouth = Math.floor(rand() * 3) // 0 none, 1 dot, 2 smile

  // Left half only (mirrored when drawn): 0 empty, 1 body, 2 eye.
  const cells: number[][] = body.map((row) => [...row].map((c) => (c === 'E' ? 2 : c === '2' ? 1 : c === '1' ? +(rand() < fill) : c === '3' ? +(rand() < 0.7) : 0)))
  const eyeRows = cells.flatMap((row, y) => (row.includes(2) ? [y] : []))
  // Big eyes are two pixels wide, toward the middle.
  if (bigEyes) for (const y of eyeRows) cells[y][cells[y].indexOf(2) + 1] = 2
  const eyeTop = eyeRows[0] ?? 5
  const eyeBottom = eyeRows.at(-1) ?? eyeTop
  const top = cells.findIndex((row) => row.some(Boolean))
  const bottom = size - 1 - [...cells].reverse().findIndex((row) => row.some(Boolean))

  const out = blank(size, size)
  const put = (x: number, y: number, [r, g, b]: RGB) => {
    for (const px of [x, size - 1 - x]) {
      const i = (y * size + px) * 4
      out.data[i] = r
      out.data[i + 1] = g
      out.data[i + 2] = b
      out.data[i + 3] = 255
    }
  }
  const on = (x: number, y: number) => y >= 0 && y < size && x >= 0 && x < half && !!cells[y][x]
  for (let y = 0; y < size; y++)
    for (let x = 0; x < half; x++) {
      const c = cells[y][x]
      if (!c) continue
      if (c === 2) {
        // A light catch on the top outer pixel of big eyes.
        put(x, y, bigEyes && y === eyeTop && x === cells[y].indexOf(2) ? [255, 255, 255] : ink)
        continue
      }
      let color = base
      if (!on(x, y - 1) && y <= top + 2) color = light
      else if (!on(x, y + 1) || y >= bottom - 1) color = dark
      if (hasBelly && x >= 6 && y > eyeBottom + 1 && y < bottom - 1) color = belly
      if (spots && color === base && (x * 3 + y * 5) % 7 === 0) color = accent
      // Ears and feet: the rows above the face and below the body.
      if (accentLimbs && (y < eyeTop - 2 || y >= bottom - 1) && x < 6) color = accent
      put(x, y, color)
    }
  if (hasBlush) {
    const ex = cells[eyeBottom].indexOf(2)
    if (ex > 0 && on(ex - 1, eyeBottom + 1)) put(ex - 1, eyeBottom + 1, blush)
  }
  const my = eyeBottom + 2
  if (mouth && on(7, my)) {
    put(7, my, ink)
    if (mouth === 2 && on(6, my - 1) && cells[my - 1][6] !== 2) put(6, my - 1, ink)
  }
  return outline(out)
}
