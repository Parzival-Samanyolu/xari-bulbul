import { memo, type ReactNode } from 'react'
import type { BotFace as Face, BotPet, BotShape } from '@harness/core/bots'

// Bot faces as plain SVG on a 100×100 grid: deterministic, no images, crisp from 16 to 96 px.
// Each face fills with the bot's color and gets a darker ring of the same hue, so it stands out
// on light backgrounds too; the eyes are dark enough for every swatch.

const INK = '#2b1f28'

/** Mixes a #rrggbb color toward black (amount > 0) or white (amount < 0). */
export function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const target = amount >= 0 ? 0 : 255
  const a = Math.abs(amount)
  const ch = (v: number) => Math.round(v + (target - v) * a)
  const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(ch)
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** A polygon with rounded corners (radius r) as a path. */
function rounded(points: [number, number][], r: number): string {
  const n = points.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const [px, py] = points[(i - 1 + n) % n]
    const [cx, cy] = points[i]
    const [nx, ny] = points[(i + 1) % n]
    const toward = (x: number, y: number) => {
      const len = Math.hypot(x - cx, y - cy)
      const k = Math.min(r, len / 2) / len
      return [cx + (x - cx) * k, cy + (y - cy) * k].map((v) => v.toFixed(2)).join(' ')
    }
    d += `${i === 0 ? 'M' : 'L'}${toward(px, py)} Q${cx} ${cy} ${toward(nx, ny)} `
  }
  return `${d}Z`
}

/** A closed shape from a radius function over the angle. */
function polar(fn: (t: number) => number, cx = 50, cy = 50, steps = 96): string {
  const pts: string[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const r = fn(t)
    pts.push(`${(cx + r * Math.sin(t)).toFixed(2)} ${(cy - r * Math.cos(t)).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
}

const ring = (n: number, r: number, start = -Math.PI / 2, cx = 50, cy = 50): [number, number][] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos(start + (i / n) * Math.PI * 2), cy + r * Math.sin(start + (i / n) * Math.PI * 2)])

const starPoints = (): [number, number][] =>
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 22 : 46
    const t = -Math.PI / 2 + (i / 10) * Math.PI * 2
    return [50 + r * Math.cos(t), 54 + r * Math.sin(t)]
  })

interface ShapeDef {
  d: string
  /** Eye center height, and half the distance between the eyes. */
  eyeY: number
  eyeX: number
  eye: number
  mouth?: 'smile' | 'o' | 'grin'
  mouthY?: number
}

const SHAPES: Record<BotShape, ShapeDef> = {
  blob: { d: 'M52 7C73 6 92 22 93 46C94 70 79 92 53 93C28 94 7 79 7 54C7 29 27 8 52 7Z', eyeY: 47, eyeX: 15, eye: 7, mouth: 'smile', mouthY: 66 },
  round: { d: 'M50 7A43 43 0 1 1 49.99 7Z', eyeY: 47, eyeX: 15, eye: 7, mouth: 'grin', mouthY: 66 },
  squircle: { d: 'M50 7C86 7 93 14 93 50C93 86 86 93 50 93C14 93 7 86 7 50C7 14 14 7 50 7Z', eyeY: 46, eyeX: 16, eye: 7 },
  shield: {
    d: rounded(
      [
        [50, 6],
        [90, 18],
        [88, 56],
        [50, 95],
        [12, 56],
        [10, 18],
      ],
      12,
    ),
    eyeY: 44,
    eyeX: 15,
    eye: 7,
    mouth: 'smile',
    mouthY: 63,
  },
  drop: { d: 'M50 5C62 24 87 42 87 63C87 82 71 95 50 95C29 95 13 82 13 63C13 42 38 24 50 5Z', eyeY: 62, eyeX: 14, eye: 6.5, mouth: 'o', mouthY: 78 },
  flower: { d: polar((t) => 40 + 5.5 * Math.cos(8 * t)), eyeY: 47, eyeX: 14, eye: 6.5, mouth: 'smile', mouthY: 64 },
  triangle: {
    d: rounded(
      [
        [50, 8],
        [94, 88],
        [6, 88],
      ],
      14,
    ),
    eyeY: 62,
    eyeX: 12,
    eye: 6,
  },
  hexagon: { d: rounded(ring(6, 46, -Math.PI / 2), 10), eyeY: 47, eyeX: 15, eye: 7, mouth: 'grin', mouthY: 65 },
  cloud: {
    d: 'M27 84C14 84 6 75 6 64C6 53 14 45 25 45C26 30 37 19 52 19C66 19 77 29 79 42C89 43 95 52 95 63C95 75 86 84 74 84Z',
    eyeY: 58,
    eyeX: 14,
    eye: 6.5,
    mouth: 'smile',
    mouthY: 72,
  },
  star: { d: rounded(starPoints(), 6), eyeY: 54, eyeX: 9, eye: 5 },
  ghost: {
    d: 'M16 50C16 27 31 9 50 9C69 9 84 27 84 50V86C84 90 80 92 77 89L71 83L64 90C62 92 59 92 57 90L50 83L43 90C41 92 38 92 36 90L29 83L23 89C20 92 16 90 16 86Z',
    eyeY: 44,
    eyeX: 13,
    eye: 7,
    mouth: 'o',
    mouthY: 62,
  },
}

function Eyes({ y, x, r, color = INK }: { y: number; x: number; r: number; color?: string }) {
  return (
    <>
      {[50 - x, 50 + x].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy={y} rx={r * 0.82} ry={r} fill={color} />
          <circle cx={cx + r * 0.3} cy={y - r * 0.38} r={r * 0.3} fill="#fff" />
        </g>
      ))}
    </>
  )
}

function Mouth({ kind, y }: { kind: ShapeDef['mouth']; y: number }) {
  if (kind === 'o') return <ellipse cx={50} cy={y} rx={3.6} ry={4.2} fill={INK} />
  if (kind === 'grin') return <path d={`M41 ${y - 2}Q50 ${y + 9} 59 ${y - 2}Z`} fill={INK} />
  if (kind === 'smile') return <path d={`M42 ${y - 2}Q50 ${y + 5} 58 ${y - 2}`} fill="none" stroke={INK} strokeWidth={3.4} strokeLinecap="round" />
  return null
}

function ShapeFace({ shape, color }: { shape: BotShape; color: string }) {
  const s = SHAPES[shape] ?? SHAPES.round
  return (
    <>
      <path d={s.d} fill={color} stroke={shade(color, 0.42)} strokeWidth={3} strokeLinejoin="round" />
      <Eyes y={s.eyeY} x={s.eyeX} r={s.eye} />
      {s.mouth && <Mouth kind={s.mouth} y={s.mouthY ?? s.eyeY + 18} />}
    </>
  )
}

function PetFace({ pet, color }: { pet: BotPet; color: string }) {
  const edge = shade(color, 0.42)
  const light = shade(color, -0.6)
  const dark = shade(color, 0.55)
  const line = { stroke: edge, strokeWidth: 3, strokeLinejoin: 'round' as const }
  const nose = (y: number) => <path d={`M45 ${y}Q50 ${y - 1.5} 55 ${y}Q53 ${y + 5} 50 ${y + 5.5}Q47 ${y + 5} 45 ${y}Z`} fill={INK} />
  const parts: Record<BotPet, ReactNode> = {
    cat: (
      <>
        <path d="M14 46L18 9L42 26Z" fill={color} {...line} />
        <path d="M86 46L82 9L58 26Z" fill={color} {...line} />
        <path d="M20 34L22 17L34 27Z" fill={light} />
        <path d="M80 34L78 17L66 27Z" fill={light} />
        <ellipse cx={50} cy={57} rx={40} ry={34} fill={color} {...line} />
        <ellipse cx={50} cy={70} rx={16} ry={11} fill={light} />
        <Eyes y={52} x={16} r={6.5} />
        {nose(64)}
        <path d="M30 68H12M30 73L14 78M70 68H88M70 73L86 78" stroke={edge} strokeWidth={2} strokeLinecap="round" />
      </>
    ),
    dog: (
      <>
        <ellipse cx={50} cy={53} rx={36} ry={37} fill={color} {...line} />
        <path d="M18 22C6 26 4 52 12 66C20 60 26 42 26 28Z" fill={dark} {...line} />
        <path d="M82 22C94 26 96 52 88 66C80 60 74 42 74 28Z" fill={dark} {...line} />
        <ellipse cx={50} cy={70} rx={20} ry={15} fill={light} />
        <Eyes y={48} x={14} r={6.5} />
        <ellipse cx={50} cy={64} rx={7} ry={5} fill={INK} />
        <path d="M50 69V74M43 75Q50 80 57 75" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
      </>
    ),
    bunny: (
      <>
        <ellipse cx={35} cy={26} rx={10} ry={23} fill={color} {...line} />
        <ellipse cx={65} cy={26} rx={10} ry={23} fill={color} {...line} />
        <ellipse cx={35} cy={28} rx={4.5} ry={15} fill={light} />
        <ellipse cx={65} cy={28} rx={4.5} ry={15} fill={light} />
        <circle cx={50} cy={64} r={31} fill={color} {...line} />
        <Eyes y={60} x={13} r={5.8} />
        {nose(70)}
        <path d="M50 75.5Q46 80 42 78M50 75.5Q54 80 58 78" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
      </>
    ),
    bear: (
      <>
        <circle cx={22} cy={25} r={14} fill={color} {...line} />
        <circle cx={78} cy={25} r={14} fill={color} {...line} />
        <circle cx={22} cy={25} r={7} fill={light} />
        <circle cx={78} cy={25} r={7} fill={light} />
        <circle cx={50} cy={56} r={38} fill={color} {...line} />
        <ellipse cx={50} cy={70} rx={17} ry={13} fill={light} />
        <Eyes y={50} x={15} r={6.5} />
        <ellipse cx={50} cy={65} rx={6.5} ry={4.5} fill={INK} />
        <path d="M44 74Q50 79 56 74" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
      </>
    ),
    fox: (
      <>
        <path d="M12 8L40 30H60L88 8L84 52Q78 80 50 92Q22 80 16 52Z" fill={color} {...line} />
        <path d="M20 18L34 30L22 36Z" fill={dark} />
        <path d="M80 18L66 30L78 36Z" fill={dark} />
        <path d="M17 54Q34 56 50 74Q66 56 83 54Q78 80 50 91Q22 80 17 54Z" fill={light} />
        <Eyes y={50} x={16} r={6} />
        <path d="M45 76Q50 74 55 76Q53 81 50 82Q47 81 45 76Z" fill={INK} />
      </>
    ),
    frog: (
      <>
        <circle cx={29} cy={31} r={16} fill={color} {...line} />
        <circle cx={71} cy={31} r={16} fill={color} {...line} />
        <ellipse cx={50} cy={62} rx={44} ry={30} fill={color} {...line} />
        <circle cx={29} cy={31} r={10} fill="#fff" />
        <circle cx={71} cy={31} r={10} fill="#fff" />
        <circle cx={30} cy={32} r={5.5} fill={INK} />
        <circle cx={72} cy={32} r={5.5} fill={INK} />
        <path d="M26 64Q50 82 74 64" fill="none" stroke={INK} strokeWidth={3.4} strokeLinecap="round" />
        <circle cx={22} cy={64} r={5} fill={light} opacity={0.7} />
        <circle cx={78} cy={64} r={5} fill={light} opacity={0.7} />
      </>
    ),
    owl: (
      <>
        <path d="M14 10L34 26Q50 20 66 26L86 10L86 58Q84 92 50 93Q16 92 14 58Z" fill={color} {...line} />
        <path d="M30 80Q50 66 70 80Q66 90 50 91Q34 90 30 80Z" fill={light} opacity={0.75} />
        <circle cx={33} cy={48} r={15} fill={light} />
        <circle cx={67} cy={48} r={15} fill={light} />
        <circle cx={33} cy={48} r={7.5} fill={INK} />
        <circle cx={67} cy={48} r={7.5} fill={INK} />
        <circle cx={35.5} cy={45} r={2.4} fill="#fff" />
        <circle cx={69.5} cy={45} r={2.4} fill="#fff" />
        <path d="M44 60L56 60L50 71Z" fill={dark} stroke={dark} strokeWidth={2} strokeLinejoin="round" />
      </>
    ),
    panda: (
      <>
        <circle cx={22} cy={24} r={14} fill={dark} {...line} />
        <circle cx={78} cy={24} r={14} fill={dark} {...line} />
        <circle cx={50} cy={56} r={39} fill={shade(color, -0.78)} {...line} />
        <ellipse cx={33} cy={52} rx={11} ry={14} transform="rotate(25 33 52)" fill={dark} />
        <ellipse cx={67} cy={52} rx={11} ry={14} transform="rotate(-25 67 52)" fill={dark} />
        <circle cx={34} cy={51} r={4.6} fill="#fff" />
        <circle cx={66} cy={51} r={4.6} fill="#fff" />
        <circle cx={35} cy={51.5} r={2.6} fill={INK} />
        <circle cx={65} cy={51.5} r={2.6} fill={INK} />
        <ellipse cx={50} cy={67} rx={6.5} ry={4.5} fill={INK} />
        <path d="M44 75Q50 80 56 75" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
      </>
    ),
  }
  return <>{parts[pet] ?? parts.cat}</>
}

interface Props {
  face: Face
  size: number
  /** The picture's data URL, for image faces. */
  image?: string
  /** For a standalone face (a picker tile): its accessible name. Decorative when unset. */
  label?: string
  /** Shown instead of a picture that isn't available. */
  fallback?: string
}

/** One bot face at `size` px. */
export const BotFaceView = memo(function BotFaceView({ face, size, image, label, fallback }: Props) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  if (face.kind === 'image' || face.kind === 'emoji') {
    const text = face.kind === 'emoji' ? face.emoji : fallback || '?'
    return (
      <span
        className="bot-face bot-face-disc"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55), background: face.color, borderColor: shade(face.color, 0.42) }}
        {...a11y}
      >
        {face.kind === 'image' && image ? <img src={image} alt="" /> : text}
      </span>
    )
  }
  return (
    <svg className="bot-face" width={size} height={size} viewBox="0 0 100 100" {...a11y}>
      {face.kind === 'pet' ? <PetFace pet={face.pet} color={face.color} /> : <ShapeFace shape={face.shape} color={face.color} />}
    </svg>
  )
})
