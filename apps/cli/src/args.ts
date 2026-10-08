import { parseArgs } from 'node:util'
import type { HeadlessFormat, PermissionMode } from '@harness/core'
import { parseMode } from './ui/format.js'

export interface CliArgs {
  command: 'chat' | 'exec' | 'login' | 'version' | 'help'
  prompt?: string
  model?: string
  mode?: PermissionMode
  continue: boolean
  /** A session id (prefix), or true to pick one. */
  resume?: string | true
  format: HeadlessFormat
  cwd?: string
  theme?: 'dark' | 'light'
  provider?: string
  /** Skip user extensions, project tools and MCP servers. */
  bare: boolean
}

export class UsageError extends Error {}

export const HELP = `xb — Xarı Bülbül in your terminal

Usage
  xb [prompt]                 start a chat (optionally with a first message)
  xb -p "prompt"              run one turn without the UI and print the answer
  xb exec "prompt"            same as -p
  xb login [provider]         save an API key in the OS keychain and test it

Options
  -m, --model <p:model>       model, e.g. openrouter:openrouter/free or ollama-cloud:glm-5.3
      --mode <mode>           ask | auto-edit | plan | full-auto
  -c, --continue              continue the latest chat in this folder
  -r, --resume [id]           resume a chat (pick one if no id is given)
      --output-format <f>     text | json | stream-json  (with -p)
      --cwd <dir>             work in another folder
      --theme <dark|light>    override terminal background detection
      --bare                  no user extensions, project tools or MCP servers
  -v, --version               show the version
  -h, --help                  show this help

Keys come from the OS keychain (shared with the desktop app) or <PROVIDER>_API_KEY,
e.g. OPENROUTER_API_KEY. HARNESS_DATA_DIR selects a separate profile.

Exit codes (with -p): 0 done · 1 error · 2 bad usage · 3 budget reached · 4 step limit · 130 interrupted`

export function parseCliArgs(argv: string[]): CliArgs {
  // `--resume` takes an optional value, which parseArgs cannot express: peel it off first.
  const rest: string[] = []
  let resume: string | true | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-r' || a === '--resume') {
      const next = argv[i + 1]
      if (next && /^[0-9a-f-]{4,}$/i.test(next)) {
        resume = next
        i++
      } else resume = true
    } else if (a.startsWith('--resume=')) resume = a.slice('--resume='.length) || true
    else rest.push(a)
  }

  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        print: { type: 'boolean', short: 'p' },
        model: { type: 'string', short: 'm' },
        mode: { type: 'string' },
        continue: { type: 'boolean', short: 'c' },
        'output-format': { type: 'string' },
        cwd: { type: 'string' },
        theme: { type: 'string' },
        bare: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  const v = parsed.values
  const pos = parsed.positionals

  const format = (v['output-format'] ?? 'text') as HeadlessFormat
  if (!['text', 'json', 'stream-json'].includes(format)) throw new UsageError(`--output-format must be text, json or stream-json (got "${format}")`)
  let mode: PermissionMode | undefined
  if (v.mode) {
    const m = parseMode(v.mode)
    if (!m) throw new UsageError(`--mode must be ask, auto-edit, plan or full-auto (got "${v.mode}")`)
    mode = m
  }
  if (v.theme && v.theme !== 'dark' && v.theme !== 'light') throw new UsageError('--theme must be dark or light')

  const base = {
    model: v.model,
    mode,
    continue: !!v.continue,
    resume,
    format,
    cwd: v.cwd,
    theme: v.theme as CliArgs['theme'],
    bare: !!v.bare,
  }
  if (v.help) return { ...base, command: 'help' }
  if (v.version) return { ...base, command: 'version' }
  if (pos[0] === 'login') return { ...base, command: 'login', provider: pos[1] }
  if (pos[0] === 'exec') {
    const prompt = pos.slice(1).join(' ')
    return { ...base, command: 'exec', prompt }
  }
  if (v.print) return { ...base, command: 'exec', prompt: pos.join(' ').trim() }
  return { ...base, command: 'chat', prompt: pos.join(' ').trim() || undefined }
}
