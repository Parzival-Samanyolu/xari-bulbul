/**
 * The app's translation engine: language resolution, message formatting with
 * `{name}` placeholders and plural forms, and locale-aware numbers, sizes and
 * short relative times. UI-agnostic; the desktop catalogue lives in
 * `apps/desktop/src/shared/i18n`.
 */

export const LANGS = ['en', 'az', 'tr', 'ru'] as const
export type Lang = (typeof LANGS)[number]

/** Each language's name in itself, for the language picker. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  az: 'Azərbaycan dili',
  tr: 'Türkçe',
  ru: 'Русский',
}

/** Plural forms keyed by `Intl.PluralRules` category; `other` is the fallback. */
export type Plural = { one: string; other: string; few?: string; many?: string }
export type Message = string | Plural
export type Vars = Record<string, string | number>

function isLang(s: string): s is Lang {
  return (LANGS as readonly string[]).includes(s)
}

/** The UI language: an explicit setting wins, `system` (or anything unknown) takes the first supported system locale, else English. */
export function resolveLang(setting: string | undefined, systemLocales: readonly string[]): Lang {
  if (setting && isLang(setting)) return setting
  if (setting === 'system' || setting === undefined || setting === '') {
    for (const loc of systemLocales) {
      const base = loc.toLowerCase().split(/[-_]/)[0]
      if (isLang(base)) return base
    }
  }
  return 'en'
}

const pluralRules = new Map<Lang, Intl.PluralRules>()
function pluralCategory(lang: Lang, n: number): string {
  let r = pluralRules.get(lang)
  if (!r) pluralRules.set(lang, (r = new Intl.PluralRules(lang)))
  return r.select(n)
}

/** Fills `{name}` placeholders; unknown ones stay as written. Plurals pick their form from `vars.count`. */
export function formatMessage(lang: Lang, msg: Message, vars?: Vars): string {
  let text: string
  if (typeof msg === 'string') text = msg
  else {
    const count = Number(vars?.count ?? 0)
    const cat = pluralCategory(lang, count) as keyof Plural
    text = msg[cat] ?? msg.other
  }
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  )
}

/** A `t(key, vars)` for one language that falls back to English, then to the key itself. */
export function makeT<K extends string>(
  lang: Lang,
  catalogs: Record<Lang, Record<K, Message>>,
): (key: K, vars?: Vars) => string {
  const own = catalogs[lang] as Partial<Record<K, Message>>
  const en = catalogs.en as Partial<Record<K, Message>>
  return (key, vars) => {
    const msg = own[key] ?? en[key]
    if (msg === undefined) return key
    return formatMessage(own[key] !== undefined ? lang : 'en', msg, vars)
  }
}

/** Placeholder names in a message (all plural forms), each once, in first-seen order. */
export function placeholders(msg: Message): string[] {
  const texts = typeof msg === 'string' ? [msg] : [msg.one, msg.few, msg.many, msg.other].filter((s): s is string => !!s)
  const out: string[] = []
  for (const t of texts) for (const m of t.matchAll(/\{(\w+)\}/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

export function formatNumber(lang: Lang, n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(lang, opts).format(n)
}

const BYTE_UNITS: Record<Lang, readonly string[]> = {
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
  az: ['B', 'KB', 'MB', 'GB', 'TB'],
  tr: ['B', 'KB', 'MB', 'GB', 'TB'],
  ru: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'],
}

/** Binary sizes with one decimal at most: `1.5 KB`, `1,5 КБ`. */
export function formatBytes(lang: Lang, bytes: number): string {
  const units = BYTE_UNITS[lang]
  let v = Math.max(0, bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${formatNumber(lang, v, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`
}

const NOW: Record<Lang, string> = { en: 'now', az: 'indi', tr: 'şimdi', ru: 'сейчас' }

/** Short time since `ts`: `now`, `5m`, `3h`, `2d`, `2w` (in English; narrow units elsewhere). */
export function formatAgo(lang: Lang, ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return NOW[lang]
  const steps: [Intl.NumberFormatOptions['unit'], number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
  ]
  let unit = steps[0]
  for (const st of steps) if (s >= st[1]) unit = st
  const n = Math.floor(s / unit[1])
  return new Intl.NumberFormat(lang, { style: 'unit', unit: unit[0], unitDisplay: 'narrow' }).format(n)
}
