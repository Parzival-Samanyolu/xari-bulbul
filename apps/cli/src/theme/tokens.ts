// Xarı Bülbül colour tokens, the same OKLCH values as the desktop app
// (apps/desktop/src/renderer/src/styles.css; a test keeps the two in sync).
// Brand hue 350 is the plum of the flower's lip; the sepal green appears only in the mark.

export type TokenName =
  | 'bg'
  | 'panel'
  | 'panel-2'
  | 'border'
  | 'control-border'
  | 'text'
  | 'muted'
  | 'accent'
  | 'accent-strong'
  | 'accent-soft'
  | 'sepal'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'add-bg'
  | 'del-bg'
  | 'code-bg'

type Oklch = [l: number, c: number, h: number]

export const TOKENS: Record<'dark' | 'light', Record<TokenName, Oklch>> = {
  dark: {
    bg: [0.17, 0.012, 350],
    panel: [0.205, 0.013, 350],
    'panel-2': [0.245, 0.015, 350],
    border: [0.31, 0.016, 350],
    'control-border': [0.55, 0.02, 350],
    text: [0.93, 0.008, 350],
    muted: [0.72, 0.014, 350],
    accent: [0.76, 0.11, 350],
    'accent-strong': [0.5, 0.14, 350],
    'accent-soft': [0.28, 0.045, 350],
    sepal: [0.86, 0.09, 125],
    ok: [0.76, 0.13, 150],
    warn: [0.82, 0.12, 80],
    danger: [0.7, 0.16, 28],
    info: [0.75, 0.09, 240],
    'add-bg': [0.26, 0.035, 150],
    'del-bg': [0.26, 0.04, 28],
    'code-bg': [0.135, 0.008, 350],
  },
  light: {
    bg: [0.995, 0.002, 350],
    panel: [0.985, 0.004, 350],
    'panel-2': [0.955, 0.008, 350],
    border: [0.89, 0.012, 350],
    'control-border': [0.6, 0.02, 350],
    text: [0.22, 0.015, 350],
    muted: [0.5, 0.018, 350],
    accent: [0.47, 0.15, 350],
    'accent-strong': [0.47, 0.15, 350],
    'accent-soft': [0.945, 0.028, 350],
    sepal: [0.6, 0.11, 125],
    ok: [0.5, 0.13, 150],
    warn: [0.55, 0.12, 70],
    danger: [0.53, 0.18, 28],
    info: [0.5, 0.12, 245],
    'add-bg': [0.955, 0.035, 150],
    'del-bg': [0.955, 0.03, 28],
    'code-bg': [0.97, 0.005, 350],
  },
}

/** OKLCH → sRGB hex (gamut-clipped), per Björn Ottosson's OKLab definition. */
export function oklchToHex([l, c, h]: Oklch): string {
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return '#' + lin.map((x) => Math.round(Math.min(1, Math.max(0, gamma(x))) * 255).toString(16).padStart(2, '0')).join('')
}
