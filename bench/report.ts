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
const CATS = ['coding', 'tools', 'github-mcp'] as const

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

const failures = runs.filter((r) => !r.pass).map((r) => ({ model: r.model, task: r.task, rep: r.rep, reason: r.reason, detail: r.detail }))
const reps = Math.max(...runs.map((r) => r.rep))
const started = runs.map((r) => r.startedAt).sort()[0]

fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ date: started, reps, tasks: perTask.length, summary, perTask, failures }, null, 2) + '\n')

const n = (v: number | null, unit = '') => (v === null ? '–' : `${v}${unit}`)
const short = (m: string) => m.replace(/:free$/, '')
const md = [
  `| Model | Pass | Coding | Tools | GitHub MCP | Median time | First token | Output tok/s | Tokens/run | Tool errors | Cost |`,
  `|---|---|---|---|---|---|---|---|---|---|---|`,
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
  '',
  `| Task | ${models.map((m) => `\`${short(m).split(':')[0]}\``).join(' | ')} |`,
  `|---|${models.map(() => '---').join('|')}|`,
  ...perTask.map((t) => `| ${t.title} (\`${t.task}\`) | ${models.map((m) => t.results[m].map((p) => (p ? '✓' : '✗')).join(' ')).join(' | ')} |`),
].join('\n')
fs.writeFileSync(path.join(dir, 'summary.md'), md + '\n')
console.log(md)
