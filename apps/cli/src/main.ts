#!/usr/bin/env node
// Dev/test runner for the Xarı Bülbül engine. The real product is the desktop app.
//   OPENROUTER_API_KEY=... pnpm cli [--model openrouter:anthropic/claude-sonnet-5] [--mode ask|acceptEdits|plan|auto] [--cwd DIR] ["prompt"]
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  Agent,
  MemoryStore,
  Permissions,
  ProviderRegistry,
  SessionStore,
  UsageTracker,
  builtinTools,
  defaultSettings,
  expandSlashCommand,
  loadExtensions,
  newSession,
  type PermissionMode,
} from '@harness/core'

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m` }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
function parseModel(s: string) {
  const i = s.indexOf(':')
  return i < 0 ? { providerId: 'openrouter', modelId: s } : { providerId: s.slice(0, i), modelId: s.slice(i + 1) }
}

const settings = defaultSettings()
// pnpm runs scripts inside the package dir; INIT_CWD is where the user actually was.
const cwd = path.resolve(arg('cwd') ?? process.env.INIT_CWD ?? process.cwd())
settings.permissions.mode = (arg('mode') as PermissionMode) ?? 'ask'
const model = parseModel(arg('model') ?? `${settings.models.default.providerId}:${settings.models.default.modelId}`)
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))

const dataDir = path.join(os.homedir(), '.harness', 'cli')
// Keys come from env: OPENROUTER_API_KEY, OLLAMA_CLOUD_API_KEY, <CUSTOM_ID>_API_KEY
const registry = new ProviderRegistry(settings.providers, (id) => process.env[`${id.toUpperCase().replace(/-/g, '_')}_API_KEY`])
const usage = new UsageTracker(path.join(dataDir, 'usage.jsonl'))
const store = new SessionStore(path.join(dataDir, 'sessions'))
const ext = await loadExtensions(cwd, { user: settings.tools.loadUserExtensions, project: settings.tools.loadProjectExtensions })
for (const e of ext.errors) console.log(c.red(`extension error ${e.file}: ${e.error}`))
await registry.models(model.providerId).catch((e) => console.log(c.yellow(`could not load model list: ${e.message}`)))

const rl = readline.createInterface({ input: stdin, output: stdout })
const permissions = new Permissions(settings.permissions, cwd)
const agent = new Agent({
  session: newSession(cwd, model),
  registry,
  tools: [...builtinTools(), ...ext.tools],
  settings,
  usage,
  permissions,
  memory: new MemoryStore(path.join(dataDir, 'memory'), settings.memory.maxChars),
  onSave: (s) => store.save(s),
  askPermission: async (req) => {
    stdout.write('\n')
    // Destructive commands (no suggested rule) need an explicit "y" and can't be allowed always.
    const oneTime = !req.suggestedRule
    const choices = oneTime ? '[y]es / [n]o' : '[y]es / [a]lways / [n]o'
    const a = (await rl.question(c.yellow(`Allow ${req.tool}: ${req.subject}? (${req.reason}) ${choices}: `))).trim().toLowerCase()
    if (a === 'a' && !oneTime) return { type: 'allowAlways' }
    if (a === 'y' || (a === '' && !oneTime)) return { type: 'allow' }
    return { type: 'deny', feedback: a.length > 1 ? a : undefined }
  },
  onEvent: (e) => {
    switch (e.type) {
      case 'text': stdout.write(e.delta); break
      case 'reasoning': stdout.write(c.dim(e.delta)); break
      case 'stream_reset': stdout.write('\n'); break
      case 'tool_start': stdout.write(`\n${c.cyan(`● ${e.name}`)} ${c.dim(e.subject)}\n`); break
      case 'tool_end': {
        const first = e.result.content.split('\n').slice(0, 4).join('\n')
        stdout.write(`${e.result.isError ? c.red(first) : c.dim(first)}\n`)
        break
      }
      case 'usage': {
        const s = e.summary.session
        stdout.write(c.dim(`\n  [${e.record.promptTokens}↑ ${e.record.completionTokens}↓ · session ${s.requests} req, ${s.promptTokens + s.completionTokens} tok, $${s.cost.toFixed(4)} · ctx ${Math.round((e.contextTokens / e.contextLength) * 100)}%]\n`))
        break
      }
      case 'todos': stdout.write(e.todos.map((t) => `  ${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'} ${t.content}`).join('\n') + '\n'); break
      case 'notice': stdout.write(c.yellow(`\n${e.text}\n`)); break
      case 'error': stdout.write(c.red(`\nError: ${e.message}\n`)); break
      case 'turn_end': stdout.write(c.dim(`\n(${e.reason})\n`)); break
    }
  },
})

process.on('SIGINT', () => (agent.running ? agent.stop() : process.exit(0)))

console.log(c.green('Xarı Bülbül dev CLI'), c.dim(`${model.providerId}:${model.modelId} · ${settings.permissions.mode} · ${cwd}`))
console.log(c.dim('Commands: /model <provider:model>, /mode <mode>, /usage, /compact, /exit. Ctrl+C stops a turn.'))

if (positional.length) {
  await agent.send(positional.join(' '))
  rl.close()
  process.exit(0)
}

while (true) {
  const line = (await rl.question(c.green('\n› '))).trim()
  if (!line) continue
  if (line === '/exit') break
  if (line.startsWith('/model ')) { agent.setModel(parseModel(line.slice(7).trim())); await registry.models(agent.model.providerId).catch(() => {}); console.log(c.dim(`model → ${agent.model.providerId}:${agent.model.modelId}`)); continue }
  if (line.startsWith('/mode ')) { permissions.setMode(line.slice(6).trim() as PermissionMode); console.log(c.dim(`mode → ${permissions.mode}`)); continue }
  if (line === '/usage') { const s = usage.summary(agent.session.meta.id); console.log(JSON.stringify({ session: s.session, today: s.today }, null, 2)); continue }
  if (line === '/compact') { console.log(c.dim((await agent.compact()) ? 'compacted' : 'nothing to compact')); continue }
  await agent.send(expandSlashCommand(line, ext.commands) ?? line)
}
rl.close()
