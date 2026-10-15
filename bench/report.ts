// Summarizes a results folder: writes summary.json and summary.md next to runs.jsonl.
//
//   pnpm --filter @harness/bench report bench/results/2026-10-11
import fs from 'node:fs'
import path from 'node:path'
import type { RunResult } from './run.js'
import { TASKS } from './tasks.js'

const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv.slice(2).find((a) => a !== '--') ?? '')
const runs: RunResult[] = fs
  .readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0)
const CATS = ['coding', 'tools', 'github-mcp', 'speed'] as const

const models = [...new Set(runs.map((r) => r.model))]
const summary = models.map((model) => {
  const rs = runs.filter((r) => r.model === model)
  // Speed only from runs that finished, so an instant provider error doesn't look fast.
  const done = rs.filter((r) => r.reason === 'done')
  const genMs = sum(done.map((r) => r.modelMs))
  return {
    model,
    runs: rs.length,
    passed: rs.filter((r) => r.pass).length,
    passRate: pct(rs.filter((r) => r.pass).length, rs.length),
    byCategory: Object.fromEntries(
      CATS.map((c) => {
        const cr = rs.filter((r) => r.category === c)
        return [c, { passed: cr.filter((r) => r.pass).length, runs: cr.length }]
      }),
    ),
    medianWallSec: done.length ? +(median(done.map((r) => r.wallMs))! / 1000).toFixed(1) : null,
    medianTtftSec: done.length ? +(median(done.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs])))! / 1000).toFixed(2) : null,
    medianRequests: median(done.map((r) => r.requests)),
    outputTokensPerSec: genMs ? Math.round(sum(done.map((r) => r.completionTokens)) / (genMs / 1000)) : null,
    tokensPerRun: done.length ? Math.round(sum(done.map((r) => r.promptTokens + r.completionTokens)) / done.length) : null,
    toolCallErrorRate: pct(sum(rs.map((r) => r.toolErrors)), sum(rs.map((r) => r.toolCalls))),
    providerErrors: rs.filter((r) => r.reason !== 'done').length,
    costUsd: rs.some((r) => r.cost === null) ? null : +sum(rs.map((r) => r.cost ?? 0)).toFixed(4),
  }
})
summary.sort((a, b) => b.passRate - a.passRate || (a.medianWallSec ?? 1e9) - (b.medianWallSec ?? 1e9))

const perTask = TASKS.filter((t) => runs.some((r) => r.task === t.id)).map((t) => ({
  task: t.id,
  title: t.title,
  category: t.category,
  results: Object.fromEntries(models.map((m) => [m, runs.filter((r) => r.task === t.id && r.model === m).map((r) => r.pass)])),
}))

// The speed tasks are one or two requests each, so their timings mean one thing.
const speed = models.map((model) => {
  const done = (task: string) => runs.filter((r) => r.model === model && r.task === task && r.reason === 'done')
  const ping = done('speed-ping')
  const ttfts = ping.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]))
  const long = done('speed-long-output').filter((r) => r.modelMs > 0)
  const trip = done('speed-tool-roundtrip')
  const sec = (ms: number | null, digits = 1) => (ms === null ? null : +(ms / 1000).toFixed(digits))
  return {
    model,
    pingSec: sec(median(ping.map((r) => r.wallMs)), 2),
    pingTtftSec: sec(median(ttfts), 2),
    longOutputTokPerSec: long.length ? Math.round(median(long.map((r) => r.completionTokens / (r.modelMs / 1000)))!) : null,
    longOutputSec: sec(median(long.map((r) => r.wallMs))),
    toolRoundtripSec: sec(median(trip.map((r) => r.wallMs)), 2),
  }
})
const hasSpeed = runs.some((r) => r.category === 'speed')

const failures = runs.filter((r) => !r.pass).map((r) => ({ model: r.model, task: r.task, rep: r.rep, reason: r.reason, detail: r.detail }))
const reps = Math.max(...runs.map((r) => r.rep))
const started = runs.map((r) => r.startedAt).sort()[0]

fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ date: started, reps, tasks: perTask.length, summary, ...(hasSpeed && { speed }), perTask, failures }, null, 2) + '\n')

const n = (v: number | null, unit = '') => (v === null ? '–' : `${v}${unit}`)
const short = (m: string) => m.replace(/:free$/, '')
const md = [
  `| Model | Pass | Coding | Tools | GitHub MCP | Speed | Median time | First token | Output tok/s | Tokens/run | Tool errors | Cost |`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ...summary.map((s) =>
    [
      `\`${short(s.model)}\``,
      `**${s.passRate}%** (${s.passed}/${s.runs})`,
      ...CATS.map((c) => `${s.byCategory[c].passed}/${s.byCategory[c].runs}`),
      n(s.medianWallSec, ' s'),
      n(s.medianTtftSec, ' s'),
      n(s.outputTokensPerSec),
      n(s.tokensPerRun),
      `${s.toolCallErrorRate}%`,
      s.costUsd === null ? 'free tier' : `$${s.costUsd}`,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
  ),
  ...(hasSpeed
    ? [
        '',
        `| Model | Ping (one word) | Ping first token | Long answer tok/s | Long answer time | One tool call |`,
        `|---|---|---|---|---|---|`,
        ...speed.map((s) =>
          `| \`${short(s.model)}\` | ${n(s.pingSec, ' s')} | ${n(s.pingTtftSec, ' s')} | ${n(s.longOutputTokPerSec)} | ${n(s.longOutputSec, ' s')} | ${n(s.toolRoundtripSec, ' s')} |`,
        ),
      ]
    : []),
  '',
  `| Task | ${models.map((m) => `\`${short(m).split(':')[0]}\``).join(' | ')} |`,
  `|---|${models.map(() => '---').join('|')}|`,
  ...perTask.map((t) => `| ${t.title} (\`${t.task}\`) | ${models.map((m) => t.results[m].map((p) => (p ? '✓' : '✗')).join(' ')).join(' | ')} |`),
].join('\n')
fs.writeFileSync(path.join(dir, 'summary.md'), md + '\n')
console.log(md)
