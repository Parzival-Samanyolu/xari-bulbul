// Runs the task suite against models through the Xarı Bülbül engine and writes the results.
//
//   pnpm bench                                   # your favorite models, every task, once
//   pnpm bench -- --reps 3 --tasks gh-find-file,json-edit --models groq:openai/gpt-oss-120b
//
// Uses your settings, keys and MCP servers (HARNESS_DATA_DIR picks another profile). Each run gets
// an empty temp folder, auto mode, no memory, no web tools and no subagents. GitHub MCP tools
// are limited to the ones the server marks read-only, so a run can't change anything on GitHub.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  Agent,
  assembleTools,
  detectSecretBackend,
  KeyStore,
  loadSettingsFile,
  McpManager,
  newSession,
  Permissions,
  ProviderRegistry,
  resolveDataDir,
  UsageTracker,
  type ModelRef,
  type TurnEndReason,
} from '@harness/core'
import { TASKS, type Task, type Trace } from './tasks.js'

const { values: argv } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    models: { type: 'string' },
    tasks: { type: 'string' },
    reps: { type: 'string', default: '1' },
    out: { type: 'string' },
    'timeout-sec': { type: 'string', default: '420' },
  },
})

const SKIP = new Set(['web_search', 'web_fetch', 'task', 'remember', 'forget'])
const MAX_STEPS = 30

export interface RunResult {
  model: string
  providerId: string
  modelId: string
  task: string
  category: Task['category']
  rep: number
  pass: boolean
  detail: string
  /** The model's final reply, trimmed. */
  answer: string
  reason: TurnEndReason | 'timeout' | 'crash'
  error?: string
  wallMs: number
  /** Time to the first streamed token of the first request. */
  ttftMs: number | null
  /** Wall time minus time spent inside tools. */
  modelMs: number
  requests: number
  toolCalls: number
  toolErrors: number
  promptTokens: number
  completionTokens: number
  cost: number | null
  startedAt: string
}

const dataDir = resolveDataDir()
const settings = loadSettingsFile(dataDir)
const keys = new KeyStore(detectSecretBackend(dataDir))
const registry = new ProviderRegistry(settings.providers, (id) => keys.get(id), { retries: settings.agent.requestRetries })
const ref = (s: string): ModelRef => {
  const i = s.indexOf(':')
  return { providerId: s.slice(0, i), modelId: s.slice(i + 1) }
}
const models: ModelRef[] = argv.models ? argv.models.split(',').map(ref) : settings.models.favorites
const tasks = argv.tasks ? TASKS.filter((t) => argv.tasks!.split(',').includes(t.id)) : TASKS
const reps = Number(argv.reps)
const timeoutMs = Number(argv['timeout-sec']) * 1000
if (!models.length) throw new Error('No models: add favorites in the app or pass --models provider:model,…')

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
// pnpm runs scripts inside bench/; INIT_CWD is where the command was typed.
const outDir = argv.out ? path.resolve(process.env.INIT_CWD ?? process.cwd(), argv.out) : path.join(import.meta.dirname, 'results', stamp)
fs.mkdirSync(outDir, { recursive: true })
const runsFile = path.join(outDir, 'runs.jsonl')

const mcp = new McpManager({ clientVersion: 'bench', secret: (id) => keys.get(`mcp:${id}`) })
await mcp.sync(settings.mcp.servers)
const mcpTools = mcp.tools().filter((t) => t.readOnly)
// GitHub tasks get the MCP tools on top of the built-ins; the rest only the built-ins, so a
// provider's request size limit doesn't hide how a model codes.
const baseTools = assembleTools([]).tools.filter((t) => !SKIP.has(t.name))
const withMcp = assembleTools([], mcpTools).tools.filter((t) => !SKIP.has(t.name))
console.log(`${models.length} models × ${tasks.length} tasks × ${reps} → ${outDir}`)
console.log(`tools: ${baseTools.length} built-in, ${mcpTools.length} read-only MCP`)
if (tasks.some((t) => t.category === 'github-mcp') && !mcpTools.some((t) => t.name.startsWith('mcp__github__')))
  console.warn('warning: GitHub MCP is not connected; github-mcp tasks will fail')

async function runOne(model: ModelRef, task: Task, rep: number): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xb-bench-${task.id}-`)).normalize('NFC')
  for (const [f, body] of Object.entries(task.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  const runSettings = { ...settings, agent: { ...settings.agent, maxStepsPerTurn: MAX_STEPS, customInstructions: '' } }
  const trace: Trace = { text: '', tools: [] }
  const r = {
    model: `${model.providerId}:${model.modelId}`,
    ...model,
    task: task.id,
    category: task.category,
    rep,
    ttftMs: null as number | null,
    requests: 0,
    toolCalls: 0,
    toolErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0 as number | null,
    startedAt: new Date().toISOString(),
  }
  let toolMs = 0
  let error: string | undefined
  const started = Date.now()
  const agent = new Agent({
    session: newSession(dir, model),
    registry,
    tools: task.category === 'github-mcp' ? withMcp : baseTools,
    settings: runSettings,
    usage: new UsageTracker(null),
    permissions: new Permissions({ ...settings.permissions, mode: 'auto', allow: [], deny: [] }, dir),
    secret: (id) => keys.get(id),
    askPermission: async () => ({ type: 'deny' }),
    onEvent: (e) => {
      if ((e.type === 'text' || e.type === 'reasoning' || e.type === 'tool_start') && r.ttftMs === null) r.ttftMs = Date.now() - started
      if (e.type === 'text') trace.text += e.delta
      if (e.type === 'stream_reset') trace.text = ''
      if (e.type === 'message' && e.message.role === 'assistant') trace.text = ''
      if (e.type === 'tool_end') {
        trace.tools.push({ name: e.name, ok: !e.result.isError })
        r.toolCalls++
        if (e.result.isError) r.toolErrors++
        toolMs += e.durationMs
      }
      if (e.type === 'usage') {
        r.requests++
        r.promptTokens += e.record.promptTokens
        r.completionTokens += e.record.completionTokens
        r.cost = r.cost === null || e.record.cost === null ? null : r.cost + e.record.cost
      }
      // Provider errors can name your account (e.g. Groq's org id); results are meant to be shared.
      if (e.type === 'error') error = e.message.replace(/\borg_[A-Za-z0-9]+/g, 'org_[redacted]')
    },
  })
  let reason: RunResult['reason']
  let timer: NodeJS.Timeout | undefined
  try {
    reason = await Promise.race([
      agent.send(task.prompt),
      new Promise<'timeout'>((res) => (timer = setTimeout(() => (agent.stop(), res('timeout')), timeoutMs))),
    ])
  } catch (e) {
    reason = 'crash'
    error = (e as Error).message
  } finally {
    clearTimeout(timer)
  }
  const wallMs = Date.now() - started
  // The last assistant message is the answer; `text` events of earlier steps were reset above.
  const last = [...agent.session.messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
  if (last && typeof last.content === 'string') trace.text = last.content
  let verdict: { pass: boolean; detail: string }
  try {
    verdict = reason === 'done' ? task.check(dir, trace) : { pass: false, detail: `ended: ${reason}${error ? ` (${error.slice(0, 150)})` : ''}` }
  } catch (e) {
    verdict = { pass: false, detail: `check crashed: ${(e as Error).message}` }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { ...r, ...verdict, answer: trace.text.trim().slice(-500), reason, error, wallMs, modelMs: Math.max(0, wallMs - toolMs) }
}

// Providers rate-limit per key, so each model runs its tasks one at a time; models run side by side.
const results: RunResult[] = []
await Promise.all(
  models.map(async (m) => {
    for (let rep = 1; rep <= reps; rep++)
      for (const t of tasks) {
        const res = await runOne(m, t, rep)
        results.push(res)
        fs.appendFileSync(runsFile, JSON.stringify(res) + '\n')
        console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${res.model}  ${t.id}#${rep}  ${(res.wallMs / 1000).toFixed(1)}s  ${res.pass ? '' : res.detail}`)
      }
  }),
)
await mcp.close()
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed. Raw results: ${runsFile}`)
