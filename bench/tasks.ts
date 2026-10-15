import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface Trace {
  text: string
  /** Every tool call the model made, in order. */
  tools: { name: string; ok: boolean }[]
}

export interface Task {
  id: string
  category: 'coding' | 'tools' | 'github-mcp' | 'speed'
  title: string
  prompt: string
  /** Files written into an empty folder before the run. */
  files?: Record<string, string>
  check: (dir: string, t: Trace) => { pass: boolean; detail: string }
}

/** Runs `node test.js` in the task folder; passing means exit code 0. */
function nodeTest(dir: string, file = 'test.js'): { pass: boolean; detail: string } {
  try {
    execFileSync(process.execPath, [file], { cwd: dir, stdio: 'pipe', timeout: 20_000 })
    return { pass: true, detail: 'tests pass' }
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string }
    return { pass: false, detail: (err.stderr?.toString() || err.message).trim().split('\n').slice(0, 3).join(' ').slice(0, 200) }
  }
}

const read = (dir: string, f: string) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8')
  } catch {
    return null
  }
}

const usedGithub = (t: Trace) => t.tools.some((c) => c.name.startsWith('mcp__github__') && c.ok)

/** A GitHub answer only counts if it came from the GitHub MCP tools. */
function githubAnswer(t: Trace, ok: boolean, expected: string) {
  if (!usedGithub(t)) return { pass: false, detail: 'no successful GitHub MCP call' }
  return { pass: ok, detail: ok ? 'correct' : `expected ${expected}, got: ${t.text.trim().slice(-120)}` }
}

/** A ~600-line file of small functions; `clampPercent` sits near line 450. */
const BIG_UTILS = (() => {
  const fns: string[] = []
  for (let i = 0; i < 100; i++)
    fns.push(`// Scales n by ${i + 2} and adds ${i}.
function scale${i}(n) {
  const k = ${i + 2}
  return n * k + ${i}
}
`)
  fns.splice(
    75,
    0,
    `// Clamps x to 0..100 and drops the fraction.
function clampPercent(x) {
  const c = Math.min(100, Math.max(0, x))
  return Math.floor(c)
}
`,
  )
  const names = [...fns.join('').matchAll(/^function (\w+)/gm)].map((m) => m[1])
  return `'use strict'\n\n${fns.join('\n')}\nmodule.exports = {\n${names.map((n) => `  ${n},`).join('\n')}\n}\n`
})()
const withoutClamp = (s: string) => s.replace(/function clampPercent\(x\) \{[\s\S]*?\n\}\n/, '').replace(/\/\/ Clamps x[^\n]*\n/, '')

const CSV_TABLE = (rows: { name: string; qty: number }[]) => rows.map((r) => r.name.padEnd(8) + String(r.qty).padStart(3)).join('\n')

export const TASKS: Task[] = [
  {
    id: 'fix-off-by-one',
    category: 'coding',
    title: 'Fix an off-by-one bug',
    prompt: '`node test.js` fails. Find the bug in range.js and fix it. Do not change test.js.',
    files: {
      'range.js': `// Sum of the integers from a to b, both included.
function sumRange(a, b) {
  let total = 0
  for (let i = a; i < b; i++) total += i
  return total
}
module.exports = { sumRange }
`,
      'test.js': `const assert = require('node:assert')
const { sumRange } = require('./range')
assert.strictEqual(sumRange(1, 3), 6)
assert.strictEqual(sumRange(5, 5), 5)
assert.strictEqual(sumRange(-2, 2), 0)
console.log('ok')
`,
    },
    check: (dir) => {
      const r = nodeTest(dir)
      if (r.pass && !read(dir, 'test.js')?.includes('sumRange(-2, 2), 0')) return { pass: false, detail: 'test.js was changed' }
      return r
    },
  },
  {
    id: 'implement-slugify',
    category: 'coding',
    title: 'Implement a function from tests',
    prompt: 'Implement `slugify` in slug.js so that `node test.js` passes. Do not change test.js.',
    files: {
      'slug.js': `function slugify(text) {
  throw new Error('not implemented')
}
module.exports = { slugify }
`,
      'test.js': `const assert = require('node:assert')
const { slugify } = require('./slug')
assert.strictEqual(slugify('Hello World'), 'hello-world')
assert.strictEqual(slugify('  Trim  me  '), 'trim-me')
assert.strictEqual(slugify('Çay & Şeker!'), 'cay-seker')
assert.strictEqual(slugify('a--b__c'), 'a-b-c')
assert.strictEqual(slugify('Ünïcödé 2026'), 'unicode-2026')
console.log('ok')
`,
    },
    check: (dir) => nodeTest(dir),
  },
  {
    id: 'parse-duration',
    category: 'coding',
    title: 'Write a parser to a spec',
    prompt: `Create duration.js exporting \`parseDuration(str)\` (CommonJS). It turns strings like "1h30m", "45s", "2d", "1h 5m 10s" into a number of seconds.
Units: d, h, m, s. Whitespace between parts is allowed. Throw an Error for an empty string, unknown units, or anything else that doesn't match. Write a quick test of your own and run it.`,
    check: (dir) => {
      fs.writeFileSync(
        path.join(dir, '.bench-test.js'),
        `const assert = require('node:assert')
const { parseDuration: p } = require('./duration')
assert.strictEqual(p('1h30m'), 5400)
assert.strictEqual(p('45s'), 45)
assert.strictEqual(p('2d'), 172800)
assert.strictEqual(p('1h 5m 10s'), 3910)
assert.strictEqual(p('0s'), 0)
for (const bad of ['', '5x', 'abc', '10']) assert.throws(() => p(bad), 'should throw for ' + JSON.stringify(bad))
`,
      )
      return nodeTest(dir, '.bench-test.js')
    },
  },
  {
    id: 'rename-across-files',
    category: 'coding',
    title: 'Rename a function across files',
    prompt: 'Rename the function `getUsr` to `getUser` everywhere in this project (definition and every use). `node test.js` must still pass afterwards.',
    files: {
      'users.js': `const users = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }]
function getUsr(id) {
  return users.find((u) => u.id === id) ?? null
}
module.exports = { getUsr }
`,
      'greet.js': `const { getUsr } = require('./users')
module.exports = (id) => \`Hello, \${getUsr(id)?.name ?? 'stranger'}\`
`,
      'admin/report.js': `const { getUsr } = require('../users')
module.exports = (ids) => ids.map((id) => getUsr(id)).filter(Boolean).length
`,
      'test.js': `const assert = require('node:assert')
const fs = require('node:fs')
const greet = require('./greet')
const report = require('./admin/report')
assert.strictEqual(greet(1), 'Hello, Ada')
assert.strictEqual(greet(9), 'Hello, stranger')
assert.strictEqual(report([1, 2, 3]), 2)
for (const f of ['users.js', 'greet.js', 'admin/report.js']) assert.ok(!fs.readFileSync(f, 'utf8').includes('getUsr'), f + ' still mentions getUsr')
console.log('ok')
`,
    },
    check: (dir) => nodeTest(dir),
  },
  {
    id: 'json-edit',
    category: 'coding',
    title: 'Edit package.json precisely',
    prompt: 'In package.json: bump the version to the next minor version, add a script "lint" that runs "eslint .", and remove the "left-pad" dependency. Keep everything else as it is.',
    files: {
      'package.json': JSON.stringify(
        { name: 'demo', version: '1.4.2', private: true, scripts: { test: 'node test.js' }, dependencies: { 'left-pad': '^1.3.0', zod: '^4.0.0' } },
        null,
        2,
      ),
    },
    check: (dir) => {
      try {
        const p = JSON.parse(read(dir, 'package.json') ?? '')
        const ok = p.version === '1.5.0' && p.scripts?.lint === 'eslint .' && p.scripts?.test === 'node test.js' && !p.dependencies?.['left-pad'] && p.dependencies?.zod === '^4.0.0' && p.name === 'demo'
        return { pass: ok, detail: ok ? 'correct' : JSON.stringify(p).slice(0, 200) }
      } catch (e) {
        return { pass: false, detail: `invalid JSON: ${(e as Error).message}` }
      }
    },
  },
  {
    id: 'debug-stack-trace',
    category: 'coding',
    title: 'Fix the root cause of a crash',
    prompt: `\`node app.js\` crashes with:

\`\`\`
TypeError: Cannot read properties of undefined (reading 'symbol')
    at module.exports (format.js:2:22)
    at Object.<anonymous> (app.js:3:13)
\`\`\`

Find the root cause and fix it there. Don't paper over it with a guard where it throws.`,
    files: {
      'config.js': `module.exports = {\n  curency: { code: 'EUR', symbol: '€' },\n  decimals: 2,\n}\n`,
      'format.js': `module.exports = (amount, cfg) =>\n  cfg.currency.symbol + amount.toFixed(cfg.decimals) + ' ' + cfg.currency.code\n`,
      'app.js': `const cfg = require('./config')\nconst format = require('./format')\nconsole.log(format(12.5, cfg))\n`,
    },
    check: (dir) => {
      if (read(dir, 'format.js') !== `module.exports = (amount, cfg) =>\n  cfg.currency.symbol + amount.toFixed(cfg.decimals) + ' ' + cfg.currency.code\n`)
        return { pass: false, detail: 'format.js was changed instead of the cause' }
      try {
        const out = execFileSync(process.execPath, ['app.js'], { cwd: dir, stdio: 'pipe', timeout: 20_000 }).toString().trim()
        return { pass: out === '€12.50 EUR', detail: out === '€12.50 EUR' ? 'correct' : `output: ${out.slice(0, 80)}` }
      } catch (e) {
        return { pass: false, detail: (e as Error).message.slice(0, 200) }
      }
    },
  },
  {
    id: 'fix-async-bug',
    category: 'coding',
    title: 'Fix an async bug',
    prompt: '`node test.js` fails: `runAll` in jobs.js returns an empty array. Fix jobs.js so the test passes. Do not change test.js.',
    files: {
      'jobs.js': `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function work(id) {
  await sleep(60 - id * 10)
  return id * id
}

async function runAll(ids) {
  const results = []
  ids.forEach(async (id) => {
    results.push(await work(id))
  })
  return results
}

module.exports = { runAll, work }
`,
      'test.js': `const assert = require('node:assert')
const { runAll } = require('./jobs')
;(async () => {
  assert.deepStrictEqual(await runAll([1, 2, 3, 4, 5]), [1, 4, 9, 16, 25])
  assert.deepStrictEqual(await runAll([]), [])
  console.log('ok')
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
`,
    },
    check: (dir) => {
      const r = nodeTest(dir)
      if (r.pass && !read(dir, 'test.js')?.includes('[1, 4, 9, 16, 25]')) return { pass: false, detail: 'test.js was changed' }
      return r
    },
  },
  {
    id: 'large-file-edit',
    category: 'coding',
    title: 'Change one function in a long file',
    prompt: 'In utils.js, `clampPercent` drops the fraction. It should round to the nearest integer instead (still clamped to 0..100). Change only that function; leave the rest of the file exactly as it is.',
    files: { 'utils.js': BIG_UTILS },
    check: (dir) => {
      const now = read(dir, 'utils.js') ?? ''
      if (withoutClamp(now) !== withoutClamp(BIG_UTILS)) return { pass: false, detail: 'other lines of utils.js changed' }
      fs.writeFileSync(
        path.join(dir, '.bench-test.js'),
        `const assert = require('node:assert')
const u = require('./utils')
assert.strictEqual(u.clampPercent(12.6), 13)
assert.strictEqual(u.clampPercent(12.4), 12)
assert.strictEqual(u.clampPercent(49.5), 50)
assert.strictEqual(u.clampPercent(150), 100)
assert.strictEqual(u.clampPercent(-3.7), 0)
assert.strictEqual(u.scale70(1), 142)
`,
      )
      return nodeTest(dir, '.bench-test.js')
    },
  },
  {
    id: 'add-cli-flag',
    category: 'coding',
    title: 'Add a flag to a small CLI',
    prompt: 'Add a `--json` flag to cli.js: `node cli.js --json data.csv` prints the rows as a JSON array like `[{"name":"apple","qty":3}]` instead of the table. The flag may come before or after the file name. Without the flag the output must stay exactly the same.',
    files: {
      'cli.js': `const fs = require('node:fs')
const { parseCsv } = require('./lib/parse')
const { renderTable } = require('./lib/render')

const file = process.argv[2]
const rows = parseCsv(fs.readFileSync(file, 'utf8'))
console.log(renderTable(rows))
`,
      'lib/parse.js': `function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\\n')
  const cols = head.split(',')
  return lines.map((l) => {
    const cells = l.split(',')
    return { [cols[0]]: cells[0], [cols[1]]: Number(cells[1]) }
  })
}
module.exports = { parseCsv }
`,
      'lib/render.js': `function renderTable(rows) {
  return rows.map((r) => r.name.padEnd(8) + String(r.qty).padStart(3)).join('\\n')
}
module.exports = { renderTable }
`,
      'data.csv': 'name,qty\napple,3\npear,12\nfig,7\n',
    },
    check: (dir) => {
      const rows = [
        { name: 'apple', qty: 3 },
        { name: 'pear', qty: 12 },
        { name: 'fig', qty: 7 },
      ]
      const run = (args: string[]) => execFileSync(process.execPath, ['cli.js', ...args], { cwd: dir, stdio: 'pipe', timeout: 20_000 }).toString().trim()
      try {
        const plain = run(['data.csv'])
        if (plain !== CSV_TABLE(rows)) return { pass: false, detail: `table output changed: ${JSON.stringify(plain).slice(0, 160)}` }
        for (const args of [['--json', 'data.csv'], ['data.csv', '--json']]) {
          const out = run(args)
          let parsed: unknown
          try {
            parsed = JSON.parse(out)
          } catch {
            return { pass: false, detail: `${args.join(' ')}: not JSON: ${out.slice(0, 80)}` }
          }
          if (JSON.stringify(parsed) !== JSON.stringify(rows)) return { pass: false, detail: `${args.join(' ')}: ${out.slice(0, 80)}` }
        }
        return { pass: true, detail: 'correct' }
      } catch (e) {
        return { pass: false, detail: (e as Error).message.slice(0, 200) }
      }
    },
  },
  {
    id: 'count-todos',
    category: 'tools',
    title: 'Search the project and report a number',
    prompt: 'How many `TODO` comments are there in the .js files under src/ (including subfolders)? Reply with just the number on the last line.',
    files: {
      'src/a.js': '// TODO: one\nconst a = 1 // TODO two\n',
      'src/lib/b.js': '/* TODO three */\nfunction b() {}\n// todo lowercase does not count\n',
      'src/lib/deep/c.js': '// TODO four\n// TODO five\n',
      'src/notes.md': 'TODO not a js file\n',
      'other/d.js': '// TODO outside src\n',
    },
    check: (_dir, t) => {
      const last = t.text.trim().split('\n').pop() ?? ''
      // Every number on the last line must be 5 ("There are 5 TODOs. 5" is fine, "4 or 5" isn't).
      const nums = last.match(/\d+/g) ?? []
      const ok = nums.length > 0 && nums.every((x) => x === '5')
      return { pass: ok, detail: ok ? 'correct' : `expected 5, last line: ${last.slice(0, 80)}` }
    },
  },
  {
    id: 'run-and-capture',
    category: 'tools',
    title: 'Run a script and save its output',
    prompt: 'Run gen.js with node and save exactly what it prints into out.txt.',
    files: { 'gen.js': `let s = 0\nfor (let i = 1; i <= 50; i++) if (i % 7 === 0) s += i * i\nconsole.log('checksum=' + s.toString(36))\n` },
    check: (dir) => {
      const out = read(dir, 'out.txt')?.trim()
      return { pass: out === 'checksum=5ak', detail: out === 'checksum=5ak' ? 'correct' : `out.txt: ${out?.slice(0, 80) ?? 'missing'}` }
    },
  },
  {
    id: 'find-config-value',
    category: 'tools',
    title: 'Trace a config value through files',
    prompt: 'Which port does the API server listen on in production (NODE_ENV=production, deployed with deploy/prod.env)? Read how the config is loaded. Reply with just the number on the last line.',
    files: {
      'src/config.js': `// Loads config/default.json, then merges config/<NODE_ENV>.json over it.
// String values like "\${VAR:-fallback}" are replaced with the environment variable VAR, or the fallback.
const fs = require('node:fs')
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {})
const merge = (a, b) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' ? merge(a[k] ?? {}, v) : v
  return out
}
const expand = (v) =>
  typeof v === 'string' ? v.replace(/\\$\\{(\\w+):-([^}]*)\\}/g, (_, name, fb) => process.env[name] ?? fb)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  : v
module.exports = expand(merge(read('config/default.json'), read(\`config/\${process.env.NODE_ENV}.json\`)))
`,
      'config/default.json': JSON.stringify({ api: { host: '127.0.0.1', port: '${API_PORT:-3000}' }, db: { port: '${DB_PORT:-5432}' } }, null, 2),
      'config/production.json': JSON.stringify({ api: { host: '0.0.0.0' }, log: { level: 'warn' } }, null, 2),
      'config/test.json': JSON.stringify({ api: { port: 3999 } }, null, 2),
      'deploy/prod.env': 'NODE_ENV=production\n# API_PORT=8080  (old load balancer, removed in March)\nAPI_PORT=8443\nDB_PORT=6432\n',
      'deploy/staging.env': 'NODE_ENV=staging\nAPI_PORT=8444\n',
      'examples/production.json': JSON.stringify({ api: { port: 9000 } }, null, 2),
      'docker-compose.yml': 'services:\n  api:\n    build: .\n    ports:\n      - "3000:3000"\n',
    },
    check: (_dir, t) => {
      const last = t.text.trim().split('\n').pop() ?? ''
      const nums = last.match(/\d+/g) ?? []
      const ok = nums.length > 0 && nums.every((x) => x === '8443')
      return { pass: ok, detail: ok ? 'correct' : `expected 8443, last line: ${last.slice(0, 80)}` }
    },
  },
  {
    id: 'background-job',
    category: 'tools',
    title: 'Start, read and stop a background process',
    prompt: 'server.js is a long-running process. Start it, wait for the line that starts with "ready", tell me its token, then stop the process. Reply with the token on the last line.',
    files: {
      'server.js': `require('node:fs').writeFileSync(__dirname + '/server.pid', String(process.pid))
console.log('starting…')
setTimeout(() => {
  let t = 7
  for (let i = 0; i < 1000; i++) t = (t * 31 + i) % 1000003
  console.log('ready token=' + t.toString(36))
}, 3000)
setInterval(() => {}, 1000)
`,
    },
    check: (dir, t) => {
      // "Then stop it" is checked directly: the process must be gone when the turn ends.
      let running = false
      const pid = Number(read(dir, 'server.pid'))
      const alive = () => {
        try {
          return process.kill(pid, 0)
        } catch {
          return false
        }
      }
      // A process that was just signalled can take a moment to exit.
      for (let i = 0; pid && i < 10 && alive(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      if (pid && alive()) {
        running = true
        process.kill(pid)
      }
      let tok = 7
      for (let i = 0; i < 1000; i++) tok = (tok * 31 + i) % 1000003
      const want = tok.toString(36)
      const last = t.text.trim().split('\n').pop() ?? ''
      if (!last.includes(want)) return { pass: false, detail: `expected ${want}, last line: ${last.slice(0, 80)}` }
      return { pass: !running, detail: running ? 'right token, but the process was left running' : 'correct' }
    },
  },
  {
    id: 'gh-repo-facts',
    category: 'github-mcp',
    title: 'Look up a repo on GitHub',
    prompt: 'Use the GitHub tools to find the latest release tag of Parzival-Samanyolu/xari-bulbul and the SPDX id of its license. Answer on the last line as: TAG=<tag> LICENSE=<spdx>',
    check: (_dir, t) => githubAnswer(t, /TAG=v?0\.2\.6\b/.test(t.text) && /LICENSE=MIT\b/.test(t.text), 'TAG=v0.2.6 LICENSE=MIT'),
  },
  {
    id: 'gh-find-file',
    category: 'github-mcp',
    title: 'Find code in a GitHub repo',
    prompt: 'Use the GitHub tools to find which file in the repo Parzival-Samanyolu/xari-bulbul defines `class McpManager`. Reply with the file path on the last line.',
    check: (_dir, t) => githubAnswer(t, (t.text.trim().split('\n').pop() ?? '').includes('packages/core/src/mcp/manager.ts'), 'packages/core/src/mcp/manager.ts'),
  },
  {
    id: 'gh-read-file',
    category: 'github-mcp',
    title: 'Read a file from GitHub',
    prompt: 'Use the GitHub tools to read packaging/arch/PKGBUILD in Parzival-Samanyolu/xari-bulbul (main branch). What is the value of pkgname? Reply with just the value on the last line.',
    check: (_dir, t) => githubAnswer(t, /^\W*xari-bulbul-bin\W*$/.test(t.text.trim().split('\n').pop() ?? ''), 'xari-bulbul-bin'),
  },
  {
    id: 'speed-ping',
    category: 'speed',
    title: 'Speed: one-word reply',
    prompt: 'Reply with exactly the word pong and nothing else. Do not use any tools.',
    check: (_dir, t) => {
      const ok = t.text.trim().replace(/[`*.!"']/g, '').toLowerCase() === 'pong' && !t.tools.length
      return { pass: ok, detail: ok ? 'correct' : `reply: ${t.text.trim().slice(0, 80)}` }
    },
  },
  {
    id: 'speed-long-output',
    category: 'speed',
    title: 'Speed: long answer, no tools',
    prompt: 'Without using any tools, write a 400-word explanation of how a hash map handles collisions (chaining and open addressing). Plain prose, no code.',
    check: (_dir, t) => {
      const words = t.text.trim().split(/\s+/).filter(Boolean).length
      const ok = words >= 250 && !t.tools.length
      return { pass: ok, detail: ok ? `${words} words` : `${words} words, ${t.tools.length} tool calls` }
    },
  },
  {
    id: 'speed-tool-roundtrip',
    category: 'speed',
    title: 'Speed: one tool call',
    prompt: 'Read value.txt and reply with just its contents.',
    files: { 'value.txt': 'kestrel-4127\n' },
    check: (_dir, t) => {
      const ok = (t.text.trim().split('\n').pop() ?? '').includes('kestrel-4127')
      return { pass: ok, detail: ok ? 'correct' : `reply: ${t.text.trim().slice(0, 80)}` }
    },
  },
]
