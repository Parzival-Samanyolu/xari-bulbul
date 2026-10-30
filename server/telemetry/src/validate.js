// Strict validation of an incoming batch. Anything that doesn't match is
// rejected whole: we never store partial or unexpected data.

export const LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  maxEvents: 100,
  maxProps: 20,
  maxStringLength: 500,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVENT_NAME = /^[a-z0-9_.:-]{1,64}$/
const PROP_KEY = /^[A-Za-z0-9_.:-]{1,64}$/
const APP_VERSION = /^[0-9A-Za-z.+-]{1,32}$/
const OS = /^(darwin|win32|linux|freebsd|openbsd|sunos|aix)$/
const ARCH = /^(arm64|x64|ia32|arm|ppc64|s390x|riscv64|loong64)$/

const TOP_KEYS = new Set(['installId', 'appVersion', 'os', 'arch', 'events'])
const EVENT_KEYS = new Set(['name', 'ts', 'props'])

// Client timestamps are accepted from 2024-01-01 up to a day in the future.
const MIN_TS = Date.UTC(2024, 0, 1)
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

// Events with a known shape are checked against it: listed props only, of the listed type.
// 'n' = a finite number >= 0, 's' = a string, 'b' = a boolean. A '?' suffix makes it optional.
// Older clients never send these names, so they are unaffected.
const SLUG = /^[A-Za-z0-9._:/@+-]{1,200}$/
const KNOWN_EVENTS = {
  'usage.model': {
    provider: 's', model: 's', turns: 'n', input: 'n', output: 'n', cached: 'n', errors: 'n', 'cost?': 'n',
  },
  'app.session': { minutes: 'n', chats: 'n' },
  'app.snapshot': {
    'os_version?': 's', 'locale?': 's', 'ram?': 's', 'cpus?': 's', 'screen?': 's', 'packaged?': 'b',
    'layout?': 's', 'theme?': 's', 'mode?': 's', 'provider?': 's', 'providers?': 'n', 'mcp?': 'n',
    'plugins?': 'n', 'skills?': 'n', 'bots?': 'n', 'features?': 's', 'role?': 's', 'experience?': 's',
  },
}
const SHAPES = Object.fromEntries(Object.entries(KNOWN_EVENTS).map(([name, spec]) => [name, Object.fromEntries(
  Object.entries(spec).map(([k, t]) => [k.replace(/\?$/, ''), { type: t, optional: k.endsWith('?') }]),
)]))

function checkShape(name, props) {
  const shape = SHAPES[name]
  if (!shape) return null
  const p = props ?? {}
  for (const k of Object.keys(p)) if (!shape[k]) return `unknown prop ${k} for ${name}`
  for (const [k, { type, optional }] of Object.entries(shape)) {
    const v = p[k]
    if (v === undefined) {
      if (optional) continue
      return `${name} needs ${k}`
    }
    if (type === 'n' && !(typeof v === 'number' && v >= 0)) return `${name}.${k} must be a number >= 0`
    if (type === 'b' && typeof v !== 'boolean') return `${name}.${k} must be a boolean`
    if (type === 's' && !(typeof v === 'string' && (SLUG.test(v) || (k === 'features' && /^[a-z0-9_,]{0,200}$/.test(v)) || (k === 'screen' && v === '<1280'))))
      return `${name}.${k} must be a short slug`
  }
  return null
}

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/**
 * @param {unknown} body parsed JSON
 * @param {number} now server time in ms
 * @returns {{ ok: true, batch: object } | { ok: false, error: string }}
 */
export function validateBatch(body, now = Date.now()) {
  if (!isPlainObject(body)) return fail('body must be an object')
  for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) return fail(`unknown field ${k}`)
  const { installId, appVersion, os, arch, events } = body
  if (typeof installId !== 'string' || !UUID.test(installId)) return fail('installId must be a uuid')
  if (typeof appVersion !== 'string' || !APP_VERSION.test(appVersion)) return fail('bad appVersion')
  if (typeof os !== 'string' || !OS.test(os)) return fail('bad os')
  if (typeof arch !== 'string' || !ARCH.test(arch)) return fail('bad arch')
  if (!Array.isArray(events) || events.length === 0) return fail('events must be a non-empty array')
  if (events.length > LIMITS.maxEvents) return fail(`at most ${LIMITS.maxEvents} events per batch`)

  const out = []
  for (const ev of events) {
    if (!isPlainObject(ev)) return fail('event must be an object')
    for (const k of Object.keys(ev)) if (!EVENT_KEYS.has(k)) return fail(`unknown event field ${k}`)
    if (typeof ev.name !== 'string' || !EVENT_NAME.test(ev.name)) return fail('bad event name')
    if (typeof ev.ts !== 'number' || !Number.isInteger(ev.ts) || ev.ts < MIN_TS || ev.ts > now + FUTURE_SLACK_MS)
      return fail('bad event ts')
    let props = null
    if (ev.props !== undefined) {
      const r = validateProps(ev.props)
      if (typeof r === 'string') return fail(r)
      props = r
    }
    const shapeError = checkShape(ev.name, props)
    if (shapeError) return fail(shapeError)
    out.push({ name: ev.name, ts: ev.ts, props })
  }
  return { ok: true, batch: { installId: installId.toLowerCase(), appVersion, os, arch, events: out } }
}

function validateProps(props) {
  if (!isPlainObject(props)) return 'props must be a flat object'
  const keys = Object.keys(props)
  if (keys.length > LIMITS.maxProps) return `at most ${LIMITS.maxProps} props`
  const clean = {}
  for (const k of keys) {
    if (!PROP_KEY.test(k) || k === '__proto__') return 'bad prop key'
    const v = props[k]
    if (typeof v === 'string') {
      if (v.length > LIMITS.maxStringLength) return `prop strings at most ${LIMITS.maxStringLength} chars`
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'prop numbers must be finite'
    } else if (typeof v !== 'boolean') {
      return 'prop values must be string, number or boolean'
    }
    clean[k] = v
  }
  return keys.length ? clean : null
}

const fail = (error) => ({ ok: false, error })
