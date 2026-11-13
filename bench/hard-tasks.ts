// The hard tier: small fixtures (so runs stay cheap) with hidden tests, decoys and root causes
// that sit a module or two away from the symptom. Each check runs a test the model never saw.
import type { Task } from './tasks.js'
import { hiddenTest, nodeTest, read } from './task-utils.js'

/** Runs the visible test (which must be unchanged), then the hidden one. */
function visibleThenHidden(dir: string, mustContain: string, hidden: string) {
  if (!read(dir, 'test.js')?.includes(mustContain)) return { pass: false, detail: 'test.js was changed' }
  const v = nodeTest(dir)
  if (!v.pass) return { pass: false, detail: `test.js: ${v.detail}` }
  const h = hiddenTest(dir, hidden)
  return h.pass ? { pass: true, detail: 'visible and hidden tests pass' } : { pass: false, detail: `hidden: ${h.detail}` }
}

const ASYNC_MAIN = (body: string) => `;(async () => {
${body}
  console.log('ok')
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
`

export const HARD_TASKS: Task[] = [
  {
    id: 'hard-csv-parse',
    category: 'hard',
    title: 'RFC 4180 CSV parser with hidden edge cases',
    prompt: `Implement \`parseCSV(text)\` in csv.js (CommonJS). It returns an array of rows, each an array of strings.
- Fields are separated by commas; rows end with LF or CRLF.
- A field may be wrapped in double quotes. Inside quotes, commas, CR, LF and CRLF are literal, and \`""\` is one literal quote.
- A quote inside an unquoted field is literal (\`ab"c\` is the field \`ab"c\`).
- One trailing line break at the very end does not add a row. A blank line anywhere else is a row with one empty field.
- An empty string returns [].
- Throw an Error for an unterminated quoted field, and for anything after a closing quote other than a comma, a line break or the end of input.
\`node test.js\` has a few examples; the full test suite is hidden. Don't change test.js.`,
    files: {
      'csv.js': `function parseCSV(text) {
  throw new Error('not implemented')
}
module.exports = { parseCSV }
`,
      'test.js': `const assert = require('node:assert')
const { parseCSV } = require('./csv')
assert.deepStrictEqual(parseCSV('a,b\\nc,d'), [['a', 'b'], ['c', 'd']])
assert.deepStrictEqual(parseCSV('"x,y",z\\n'), [['x,y', 'z']])
assert.deepStrictEqual(parseCSV(''), [])
console.log('ok')
`,
    },
    check: (dir) =>
      visibleThenHidden(
        dir,
        `parseCSV('"x,y",z\\n')`,
        `const assert = require('node:assert')
const { parseCSV: p } = require('./csv')
const eq = (input, want) => assert.deepStrictEqual(p(input), want, 'parseCSV(' + JSON.stringify(input) + ')')
eq('a,b\\r\\nc,d\\r\\n', [['a', 'b'], ['c', 'd']])
eq('a,,c', [['a', '', 'c']])
eq(',', [['', '']])
eq('a,', [['a', '']])
eq('a,"",b', [['a', '', 'b']])
eq('"say ""hi""",x', [['say "hi"', 'x']])
eq('""""', [['"']])
eq('"line1\\nline2",z', [['line1\\nline2', 'z']])
eq('"line1\\r\\nline2"', [['line1\\r\\nline2']])
eq('a\\n\\nb', [['a'], [''], ['b']])
eq('a,b\\n\\n', [['a', 'b'], ['']])
eq('\\n', [['']])
eq('ab"c,d', [['ab"c', 'd']])
eq('"a"\\r\\n"b"', [['a'], ['b']])
eq('"a",\\n', [['a', '']])
eq('x\\r\\ny\\nz', [['x'], ['y'], ['z']])
for (const bad of ['"unterminated', 'a,"b', '"a"b,c', '"a" ,b', '"a\\n'])
  assert.throws(() => p(bad), Error, 'should throw for ' + JSON.stringify(bad))
`,
      ),
  },
  {
    id: 'hard-semver-range',
    category: 'hard',
    title: 'npm-style semver ranges, prereleases included',
    prompt: `Implement \`satisfies(version, range)\` in semver.js (CommonJS): does the version match the range? Return true or false.
Versions are MAJOR.MINOR.PATCH with an optional \`-prerelease\` of dot-separated identifiers. Order follows SemVer 2.0: numeric identifiers compare as numbers, numeric sorts before alphanumeric, a longer set wins when all earlier identifiers are equal, and \`1.0.0-alpha < 1.0.0\`.
Ranges:
- Comparators: \`>1.2.3\`, \`>=1.2.3\`, \`<1.2.3\`, \`<=1.2.3\`, \`=1.2.3\` and bare \`1.2.3\` (always full versions).
- Space-separated comparators must all match; \`||\` separates alternatives.
- \`^1.2.3\` is \`>=1.2.3 <2.0.0\`, \`^0.2.3\` is \`>=0.2.3 <0.3.0\`, \`^0.0.3\` is \`>=0.0.3 <0.0.4\`, \`^1.2\` is \`>=1.2.0 <2.0.0\`.
- \`~1.2.3\` is \`>=1.2.3 <1.3.0\`, \`~1.2\` is \`>=1.2.0 <1.3.0\`, \`~1\` is \`>=1.0.0 <2.0.0\`.
- X-ranges: \`*\`, \`1\`, \`1.x\`, \`1.2\`, \`1.2.x\` (missing or x parts match anything).
- Hyphen ranges: \`1.2.3 - 2.3.4\` is \`>=1.2.3 <=2.3.4\`.
- Prereleases (as in npm): a version with a prerelease only matches an alternative if one of that alternative's comparators has a prerelease on the same MAJOR.MINOR.PATCH. So \`*\` doesn't match \`1.0.0-beta\`, and \`>=1.2.3-alpha\` matches \`1.2.3-beta\` but not \`1.2.4-beta\`.
\`node test.js\` has a few examples; the full test suite is hidden. Don't change test.js.`,
    files: {
      'semver.js': `function satisfies(version, range) {
  throw new Error('not implemented')
}
module.exports = { satisfies }
`,
      'test.js': `const assert = require('node:assert')
const { satisfies } = require('./semver')
assert.strictEqual(satisfies('1.4.0', '^1.2.0'), true)
assert.strictEqual(satisfies('2.0.0', '^1.2.0'), false)
assert.strictEqual(satisfies('1.2.9', '~1.2.3'), true)
assert.strictEqual(satisfies('3.1.0', '<1.0.0 || >=3.0.0'), true)
console.log('ok')
`,
    },
    check: (dir) =>
      visibleThenHidden(
        dir,
        `satisfies('3.1.0', '<1.0.0 || >=3.0.0'), true`,
        `const assert = require('node:assert')
const { satisfies } = require('./semver')
const cases = [
  ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.2.2', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
  ['1.9.9', '^1.2', true], ['1.1.9', '^1.2', false],
  ['1.3.0', '~1.2.3', false], ['1.2.5', '~1.2', true], ['1.3.0', '~1.2', false], ['1.9.0', '~1', true], ['2.0.0', '~1', false],
  ['1.9.0', '1.x', true], ['2.0.0', '1.x', false], ['1.2.7', '1.2', true], ['1.3.0', '1.2', false], ['1.2.7', '1.2.x', true],
  ['1.0.0', '1', true], ['3.4.5', '*', true], ['3.4.5-beta', '*', false],
  ['2.3.4', '1.2.3 - 2.3.4', true], ['2.3.5', '1.2.3 - 2.3.4', false], ['1.2.3', '1.2.3 - 2.3.4', true],
  ['1.5.0', '>=1.2.0 <1.6.0', true], ['1.6.0', '>=1.2.0 <1.6.0', false],
  ['2.0.0', '<1.0.0 || >=3.0.0', false], ['0.9.0', '<1.0.0 || >=3.0.0', true],
  ['1.0.0', '=1.0.0', true], ['1.0.0', '1.0.0', true], ['1.0.1', '1.0.0', false], ['1.0.0', '>1.0.0', false], ['1.0.0', '<=1.0.0', true],
  ['1.2.3-alpha.10', '>=1.2.3-alpha.2', true],
  ['1.2.3-alpha.beta', '>1.2.3-alpha.1', true],
  ['1.2.3-alpha', '>=1.2.3-alpha.1', false],
  ['1.2.3-beta', '>=1.2.3-alpha', true],
  ['1.2.4-beta', '>=1.2.3-alpha', false],
  ['1.2.3', '>1.2.3-rc.1', true],
  ['1.2.3-rc.1', '<1.2.3', false],
  ['1.2.3-rc.1', '^1.2.3-rc.0', true], ['1.2.3-rc.1', '^1.2.0', false],
  ['1.2.3-rc.1', '>=1.0.0 <2.0.0 || >=1.2.3-rc.0', true],
  ['1.0.0-2', '>1.0.0-1', true], ['1.0.0-10', '>1.0.0-9', true], ['1.0.0-a', '>1.0.0-9', true],
]
for (const [v, r, want] of cases) assert.strictEqual(satisfies(v, r), want, 'satisfies(' + JSON.stringify(v) + ', ' + JSON.stringify(r) + ')')
`,
      ),
  },
  {
    id: 'hard-debug-pricing',
    category: 'hard',
    title: 'Wrong invoice caused by state two modules away',
    prompt: '`node test.js` fails: the second invoice in the report is too low. Find the root cause and fix it there. Don\'t change test.js.',
    files: {
      'src/pricing/defaults.js': `// Store-wide pricing defaults. Customers can override any of these per order.
module.exports = {
  taxRate: 0.2,
  discount: 0,
  shipping: 4.99,
  freeShippingOver: 50,
}
`,
      'src/pricing/rules.js': `const defaults = require('./defaults')

// Applies per-order overrides on top of the store defaults. Undefined overrides are ignored.
function rulesFor(overrides = {}) {
  const rules = defaults
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) rules[k] = v
  return rules
}

module.exports = { rulesFor }
`,
      'src/pricing/price.js': `const { rulesFor } = require('./rules')
const { roundCents } = require('../util/money')

function priceOrder(order, customer) {
  const rules = rulesFor({ discount: customer.discount, taxRate: customer.taxExempt ? 0 : undefined })
  const subtotal = order.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0)
  const discounted = subtotal * (1 - rules.discount)
  const shipping = discounted >= rules.freeShippingOver ? 0 : rules.shipping
  const tax = discounted * rules.taxRate
  return {
    subtotal: roundCents(subtotal),
    discount: roundCents(subtotal - discounted),
    shipping,
    tax: roundCents(tax),
    total: roundCents(discounted + tax + shipping),
  }
}

module.exports = { priceOrder }
`,
      'src/util/money.js': `// Rounds to cents.
// FIXME: Math.round(1.005 * 100) is 100, not 101 (binary floating point). Could this be the invoice bug?
function roundCents(x) {
  return Math.round(x * 100) / 100
}

module.exports = { roundCents }
`,
      'src/customers.js': `module.exports = {
  acme: { name: 'Acme', discount: 0.1 },
  bob: { name: 'Bob' },
  school: { name: 'School', taxExempt: true },
}
`,
      'src/report.js': `const customers = require('./customers')
const { priceOrder } = require('./pricing/price')

function report(orders) {
  return orders
    .map((o) => {
      const c = customers[o.customer]
      return c.name + ': ' + priceOrder(o, c).total.toFixed(2)
    })
    .join('\\n')
}

module.exports = { report }
`,
      'test.js': `const assert = require('node:assert')
const { report } = require('./src/report')
const orders = [
  { customer: 'acme', lines: [{ unitPrice: 10, qty: 3 }] },
  { customer: 'bob', lines: [{ unitPrice: 12.5, qty: 2 }] },
]
assert.strictEqual(report(orders), 'Acme: 37.39\\nBob: 34.99')
console.log('ok')
`,
    },
    check: (dir) =>
      visibleThenHidden(
        dir,
        `'Acme: 37.39\\nBob: 34.99'`,
        `const assert = require('node:assert')
const defaults = require('./src/pricing/defaults')
const before = JSON.stringify(defaults)
const { rulesFor } = require('./src/pricing/rules')
const { report } = require('./src/report')
const o = (customer, unitPrice, qty) => ({ customer, lines: [{ unitPrice, qty }] })
assert.strictEqual(report([o('school', 12.5, 2), o('bob', 12.5, 2), o('acme', 10, 3), o('bob', 30, 2)]), 'School: 29.99\\nBob: 34.99\\nAcme: 37.39\\nBob: 72.00')
assert.strictEqual(rulesFor({ discount: 0.5 }).discount, 0.5)
assert.strictEqual(rulesFor({}).discount, 0, 'rulesFor({}) after rulesFor({ discount: 0.5 })')
assert.strictEqual(rulesFor({ taxRate: undefined }).taxRate, 0.2, 'undefined overrides are ignored')
assert.strictEqual(JSON.stringify(defaults), before, 'the store defaults were changed')
`,
      ),
  },
  {
    id: 'hard-debug-search',
    category: 'hard',
    title: 'Stale search results from an event bus bug',
    prompt: 'Search returns stale results: in `node test.js`, after the preview panel is closed and the layout is reset, renamed documents can\'t be found under their new title. Find the root cause and fix it so this kind of bug can\'t happen again. Don\'t change test.js.',
    files: {
      'src/bus.js': `// A tiny shared event bus.
const listeners = new Map()

function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, [])
  listeners.get(event).push(fn)
}

function off(event, fn) {
  const list = listeners.get(event) || []
  list.splice(list.indexOf(fn), 1)
}

function emit(event, ...args) {
  for (const fn of [...(listeners.get(event) || [])]) fn(...args)
}

module.exports = { on, off, emit }
`,
      'src/store.js': `const bus = require('./bus')

const docs = new Map()

function put(id, title) {
  docs.set(id, { id, title })
  bus.emit('change', id)
}

const get = (id) => docs.get(id)

module.exports = { put, get }
`,
      'src/search-index.js': `const bus = require('./bus')
const store = require('./store')

// word -> Set of doc ids
const index = new Map()

// FIXME: NFKD splits "İ" into I + a combining dot. Does that break Turkish titles?
const normalize = (w) => w.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()

function reindex(id) {
  for (const ids of index.values()) ids.delete(id)
  const doc = store.get(id)
  if (!doc) return
  for (const w of doc.title.split(/\\s+/).filter(Boolean).map(normalize)) {
    if (!index.has(w)) index.set(w, new Set())
    index.get(w).add(id)
  }
}

const start = () => bus.on('change', reindex)
const search = (word) => [...(index.get(normalize(word)) || [])]

module.exports = { start, search }
`,
      'src/widgets/preview.js': `const bus = require('../bus')
const store = require('../store')

// Shows the title of the last changed document.
function createPreview() {
  const view = { text: '' }
  const onChange = (id) => {
    view.text = store.get(id)?.title ?? ''
  }
  view.mount = () => bus.on('change', onChange)
  view.unmount = () => bus.off('change', onChange)
  return view
}

module.exports = { createPreview }
`,
      'src/app.js': `const store = require('./store')
const searchIndex = require('./search-index')
const { createPreview } = require('./widgets/preview')

function createApp() {
  const preview = createPreview()
  preview.mount()
  searchIndex.start()
  const panels = [preview]
  return {
    preview,
    addDoc: (id, title) => store.put(id, title),
    rename: (id, title) => store.put(id, title),
    search: (word) => searchIndex.search(word),
    closePreview: () => preview.unmount(),
    // Closes every panel so the default layout can be restored.
    resetLayout: () => panels.forEach((p) => p.unmount()),
  }
}

module.exports = { createApp }
`,
      'test.js': `const assert = require('node:assert')
const { createApp } = require('./src/app')
const app = createApp()
app.addDoc(1, 'hello world')
assert.deepStrictEqual(app.search('hello'), [1])
app.closePreview()
app.resetLayout()
app.rename(1, 'goodbye moon')
assert.deepStrictEqual(app.search('goodbye'), [1])
assert.deepStrictEqual(app.search('hello'), [])
console.log('ok')
`,
    },
    check: (dir) =>
      visibleThenHidden(
        dir,
        `app.resetLayout()\napp.rename(1, 'goodbye moon')`,
        `const assert = require('node:assert')
const bus = require('./src/bus')
const seen = []
const a = () => seen.push('a')
const b = () => seen.push('b')
const never = () => {}
bus.on('x', a)
bus.on('x', b)
bus.off('x', never)
bus.off('y', never)
bus.emit('x')
assert.deepStrictEqual(seen, ['a', 'b'], 'off() with a listener that was never added removed another one')
bus.off('x', a)
bus.off('x', a)
seen.length = 0
bus.emit('x')
assert.deepStrictEqual(seen, ['b'], 'calling off() twice removed another listener')
`,
      ),
  },
  {
    id: 'hard-callbacks-to-async',
    category: 'hard',
    title: 'Convert a five-module project from callbacks to promises',
    prompt: `Convert this project from callbacks to promises. Every exported function in db.js, users.js, profile.js, teams.js and audit.js (except db.reset) must return a Promise and take no callback; use async/await. Keep the behavior the same, including errors: a missing key still rejects with an error whose code is 'NOT_FOUND', and the code that handles that today must keep handling it. test.js already uses the new API and must pass; don't change it.`,
    files: {
      'db.js': `// In-memory key-value store with a Node-style callback API.
const data = new Map()

function notFound(key) {
  const err = new Error('not found: ' + key)
  err.code = 'NOT_FOUND'
  return err
}

function get(key, cb) {
  setImmediate(() => (data.has(key) ? cb(null, structuredClone(data.get(key))) : cb(notFound(key))))
}

function put(key, value, cb) {
  setImmediate(() => {
    data.set(key, structuredClone(value))
    cb(null)
  })
}

function del(key, cb) {
  setImmediate(() => (data.delete(key) ? cb(null) : cb(notFound(key))))
}

function list(prefix, cb) {
  setImmediate(() => cb(null, [...data.keys()].filter((k) => k.startsWith(prefix)).sort()))
}

function reset() {
  data.clear()
}

module.exports = { get, put, del, list, reset }
`,
      'users.js': `const db = require('./db')

function getUser(id, cb) {
  db.get('user:' + id, cb)
}

function createUser(id, name, cb) {
  db.get('user:' + id, (err) => {
    if (!err) return cb(new Error('user exists: ' + id))
    if (err.code !== 'NOT_FOUND') return cb(err)
    db.put('user:' + id, { id, name }, (err) => cb(err, err ? undefined : { id, name }))
  })
}

function renameUser(id, name, cb) {
  getUser(id, (err, user) => {
    if (err) return cb(err)
    user.name = name
    db.put('user:' + id, user, (err) => cb(err, err ? undefined : user))
  })
}

module.exports = { getUser, createUser, renameUser }
`,
      'profile.js': `const users = require('./users')

// "Guest" for unknown users; other errors are passed on.
function displayName(id, cb) {
  users.getUser(id, (err, user) => {
    if (err && err.code === 'NOT_FOUND') return cb(null, 'Guest')
    if (err) return cb(err)
    cb(null, user.name)
  })
}

module.exports = { displayName }
`,
      'teams.js': `const db = require('./db')
const profile = require('./profile')

function addMember(teamId, userId, cb) {
  db.get('team:' + teamId, (err, team) => {
    if (err && err.code !== 'NOT_FOUND') return cb(err)
    team = team || { id: teamId, members: [] }
    if (team.members.includes(userId)) return cb(null, team)
    team.members.push(userId)
    db.put('team:' + teamId, team, (err) => cb(err, err ? undefined : team))
  })
}

// Display names of the members, in the order they joined.
function memberNames(teamId, cb) {
  db.get('team:' + teamId, (err, team) => {
    if (err) return cb(err)
    const names = new Array(team.members.length)
    let left = team.members.length
    if (!left) return cb(null, [])
    team.members.forEach((userId, i) => {
      profile.displayName(userId, (err, name) => {
        if (left < 0) return
        if (err) {
          left = -1
          return cb(err)
        }
        names[i] = name
        if (--left === 0) cb(null, names)
      })
    })
  })
}

module.exports = { addMember, memberNames }
`,
      'audit.js': `const db = require('./db')

let seq = 0

function log(event, cb) {
  const key = 'audit:' + String(++seq).padStart(6, '0')
  db.put(key, { event, at: seq }, (err) => cb(err, err ? undefined : key))
}

// The last n events, newest first.
function recent(n, cb) {
  db.list('audit:', (err, keys) => {
    if (err) return cb(err)
    const pick = keys.slice(-n).reverse()
    const out = []
    const next = (i) => {
      if (i === pick.length) return cb(null, out)
      db.get(pick[i], (err, e) => {
        if (err) return cb(err)
        out.push(e.event)
        next(i + 1)
      })
    }
    next(0)
  })
}

module.exports = { log, recent }
`,
      'test.js': `const assert = require('node:assert')
const users = require('./users')
const profile = require('./profile')
${ASYNC_MAIN(`  await users.createUser('u1', 'Ada')
  assert.deepStrictEqual(await users.getUser('u1'), { id: 'u1', name: 'Ada' })
  assert.strictEqual(await profile.displayName('u1'), 'Ada')`)}`,
    },
    check: (dir) =>
      visibleThenHidden(
        dir,
        `await users.createUser('u1', 'Ada')`,
        `const assert = require('node:assert')
const fs = require('node:fs')
for (const f of ['db.js', 'users.js', 'profile.js', 'teams.js', 'audit.js'])
  assert.ok(!/\\b(cb|callback)\\s*\\(/.test(fs.readFileSync(f, 'utf8')), f + ' still calls a callback')
const db = require('./db')
const users = require('./users')
const profile = require('./profile')
const teams = require('./teams')
const audit = require('./audit')
const isNotFound = (e) => e && e.code === 'NOT_FOUND'
${ASYNC_MAIN(`  db.reset()
  const g = db.get('missing')
  assert.ok(g && typeof g.then === 'function', 'db.get returns a promise')
  await assert.rejects(g, isNotFound)
  await assert.rejects(db.del('missing'), isNotFound)
  await db.put('k', { a: 1 })
  assert.deepStrictEqual(await db.get('k'), { a: 1 })
  assert.deepStrictEqual(await db.list('k'), ['k'])
  await db.del('k')
  await users.createUser('u1', 'Ada')
  await assert.rejects(users.createUser('u1', 'Ada'), /exists/)
  assert.deepStrictEqual(await users.renameUser('u1', 'Ada L.'), { id: 'u1', name: 'Ada L.' })
  await assert.rejects(users.renameUser('nope', 'x'), isNotFound)
  await assert.rejects(users.getUser('nope'), isNotFound)
  assert.strictEqual(await profile.displayName('nobody'), 'Guest')
  await users.createUser('u2', 'Grace')
  for (const u of ['u2', 'ghost', 'u1', 'u2']) await teams.addMember('t', u)
  assert.deepStrictEqual((await db.get('team:t')).members, ['u2', 'ghost', 'u1'])
  assert.deepStrictEqual(await teams.memberNames('t'), ['Grace', 'Guest', 'Ada L.'])
  await assert.rejects(teams.memberNames('no-such-team'), isNotFound)
  for (const e of ['a', 'b', 'c', 'd']) await audit.log(e)
  assert.deepStrictEqual(await audit.recent(3), ['d', 'c', 'b'])
  assert.deepStrictEqual(await audit.recent(10), ['d', 'c', 'b', 'a'])`)}`,
      ),
  },
  {
    id: 'hard-change-signature',
    category: 'hard',
    title: 'Change a function signature at every call site',
    prompt: `Change \`formatMoney\` in money.js to take a single options object: \`formatMoney({ amount, currency, locale })\`.
\`locale\` is optional: 'en' (the default, today's output, e.g. '€12.50', '-$3.00') or 'de' (comma as the decimal separator, then a space and the symbol: '12,50 €', '-3,00 $', '1200 ¥').
Calling it the old way, with a number as the first argument, must throw a TypeError.
Update every caller in the project so its output stays exactly the same. \`node test.js\` checks a few of them; don't change test.js.`,
    files: {
      'money.js': `const CURRENCIES = {
  USD: { symbol: '$', decimals: 2 },
  EUR: { symbol: '€', decimals: 2 },
  GBP: { symbol: '£', decimals: 2 },
  JPY: { symbol: '¥', decimals: 0 },
}

// formatMoney(12.5, 'EUR') -> '€12.50'
function formatMoney(amount, currency) {
  const c = CURRENCIES[currency]
  if (!c) throw new Error('unknown currency: ' + currency)
  const sign = amount < 0 ? '-' : ''
  return sign + c.symbol + Math.abs(amount).toFixed(c.decimals)
}

module.exports = { formatMoney, CURRENCIES }
`,
      'cart.js': `const { formatMoney } = require('./money')

function cartSummary(cart) {
  const total = cart.items.reduce((s, i) => s + i.price * i.qty, 0)
  const lines = cart.items.map((i) => \`\${i.qty} × \${i.name} @ \${formatMoney(i.price, cart.currency)}\`)
  return [...lines, \`Total: \${formatMoney(total, cart.currency)}\`].join('\\n')
}

module.exports = { cartSummary }
`,
      'invoice.js': `const { formatMoney: fmt } = require('./money')

function invoiceLines(inv) {
  return inv.lines.map((l) => ({ text: l.text, amount: fmt(l.price * l.qty, inv.currency) }))
}

function invoiceTotal(inv) {
  const net = inv.lines.reduce((s, l) => s + l.price * l.qty, 0)
  const credit = inv.credit ? fmt(-inv.credit, inv.currency) : null
  return { net: fmt(net, inv.currency), credit, due: fmt(net - (inv.credit || 0), inv.currency) }
}

module.exports = { invoiceLines, invoiceTotal }
`,
      'emails/receipt.js': `const money = require('../money')

function receipt(order) {
  return 'Thanks, ' + order.name + '!\\n' + 'You paid ' + money.formatMoney(order.total, order.currency) + '.'
}

module.exports = { receipt }
`,
      'reports/daily.js': `const format = require('../money').formatMoney

// rows: [{ day, sum }], all in one currency.
function dailyReport(rows, currency) {
  const cells = rows.map((r) => [r.day, format.apply(null, [r.sum, currency])])
  const best = rows.reduce((a, b) => (b.sum > a.sum ? b : a), rows[0])
  return { cells, best: best ? \`\${best.day} (\${format(best.sum, currency)})\` : 'none' }
}

module.exports = { dailyReport }
`,
      'reports/price-tag.js': `const { formatMoney } = require('../money')

const RATES = { EUR: 1, USD: 1.1, GBP: 0.85, JPY: 160 }

// An EUR price shown in every currency.
function priceTag(eur) {
  return Object.keys(RATES)
    .map((cur) => formatMoney(eur * RATES[cur], cur))
    .join(' / ')
}

module.exports = { priceTag }
`,
      'test.js': `const assert = require('node:assert')
const { formatMoney } = require('./money')
const { cartSummary } = require('./cart')
assert.strictEqual(formatMoney({ amount: 12.5, currency: 'EUR' }), '€12.50')
assert.strictEqual(formatMoney({ amount: 12.5, currency: 'EUR', locale: 'de' }), '12,50 €')
assert.strictEqual(cartSummary({ currency: 'GBP', items: [{ name: 'Tea', price: 3.5, qty: 2 }] }), '2 × Tea @ £3.50\\nTotal: £7.00')
console.log('ok')
`,
    },
    check: (dir) =>
      visibleThenHidden(
        dir,
        `'2 × Tea @ £3.50\\nTotal: £7.00'`,
        `const assert = require('node:assert')
const { formatMoney } = require('./money')
const { cartSummary } = require('./cart')
const { invoiceLines, invoiceTotal } = require('./invoice')
const { receipt } = require('./emails/receipt')
const { dailyReport } = require('./reports/daily')
const { priceTag } = require('./reports/price-tag')
assert.throws(() => formatMoney(12.5, 'EUR'), TypeError, 'the old call style must throw a TypeError')
assert.throws(() => formatMoney({ amount: 1, currency: 'XYZ' }), Error)
assert.strictEqual(formatMoney({ amount: -3, currency: 'USD' }), '-$3.00')
assert.strictEqual(formatMoney({ amount: -3, currency: 'USD', locale: 'de' }), '-3,00 $')
assert.strictEqual(formatMoney({ amount: 1200, currency: 'JPY', locale: 'de' }), '1200 ¥')
assert.strictEqual(formatMoney({ amount: 1200, currency: 'JPY', locale: 'en' }), '¥1200')
assert.strictEqual(cartSummary({ currency: 'GBP', items: [{ name: 'Tea', price: 3.5, qty: 2 }, { name: 'Mug', price: 8, qty: 1 }] }), '2 × Tea @ £3.50\\n1 × Mug @ £8.00\\nTotal: £15.00')
const inv = { currency: 'USD', credit: 5, lines: [{ text: 'Hours', price: 40, qty: 2.5 }, { text: 'Fee', price: 9.99, qty: 1 }] }
assert.deepStrictEqual(invoiceLines(inv), [{ text: 'Hours', amount: '$100.00' }, { text: 'Fee', amount: '$9.99' }])
assert.deepStrictEqual(invoiceTotal(inv), { net: '$109.99', credit: '-$5.00', due: '$104.99' })
assert.deepStrictEqual(invoiceTotal({ ...inv, credit: 0 }), { net: '$109.99', credit: null, due: '$109.99' })
assert.strictEqual(receipt({ name: 'Ada', total: 1234, currency: 'JPY' }), 'Thanks, Ada!\\nYou paid ¥1234.')
assert.deepStrictEqual(dailyReport([{ day: 'Mon', sum: 10 }, { day: 'Tue', sum: 25.5 }], 'EUR'), { cells: [['Mon', '€10.00'], ['Tue', '€25.50']], best: 'Tue (€25.50)' })
assert.deepStrictEqual(dailyReport([], 'EUR'), { cells: [], best: 'none' })
assert.strictEqual(priceTag(10), '€10.00 / $11.00 / £8.50 / ¥1600')
`,
      ),
  },
]
