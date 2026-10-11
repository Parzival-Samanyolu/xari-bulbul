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
  category: 'coding' | 'tools' | 'github-mcp'
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
    id: 'gh-repo-facts',
    category: 'github-mcp',
    title: 'Look up a repo on GitHub',
    prompt: 'Use the GitHub tools to find the latest release tag of Parzival-Samanyolu/xari-bulbul and the SPDX id of its license. Answer on the last line as: TAG=<tag> LICENSE=<spdx>',
    check: (_dir, t) => githubAnswer(t, /TAG=v?0\.2\.5\b/.test(t.text) && /LICENSE=MIT\b/.test(t.text), 'TAG=v0.2.5 LICENSE=MIT'),
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
]
