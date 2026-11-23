import type { PermissionMode } from '@harness/core'

export type OutputFormat = 'text' | 'json' | 'stream-json'

export interface CliArgs {
  /** `-p`: the prompt for a non-interactive run ('' when it comes from stdin only). Unset = interactive. */
  print?: string
  outputFormat: OutputFormat
  model?: string
  mode?: PermissionMode
  continue: boolean
  resume?: string
  cwd?: string
  maxSteps?: number
  version: boolean
  help: boolean
  /** Positional words: the first message of an interactive chat. */
  prompt: string
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string }

const MODES: PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'auto']
const FORMATS: OutputFormat[] = ['text', 'json', 'stream-json']

export const USAGE = `xari: Xarı in the terminal

Usage:
  xari [options] [prompt...]        interactive chat (the prompt is sent first)
  xari -p "prompt" [options]        one non-interactive turn, then exit
  cat file | xari -p "explain"      stdin is added to the prompt

Options:
  -p, --print <prompt>        run once without a UI and print the answer
      --output-format <f>     text (default), json or stream-json (with -p)
      --model <id>            provider/model (e.g. groq/openai/gpt-oss-120b) or a model id
      --mode <mode>           permission mode: ask, acceptEdits, plan or auto
  -c, --continue              continue the latest chat in this folder
  -r, --resume <id>           resume a chat by id
      --cwd <dir>             work in this folder (default: the current one)
      --max-steps <n>         most model steps in one turn
  -v, --version               print the version
  -h, --help                  show this help

Without a UI to ask, -p denies anything that needs approval; use --mode auto to allow it.
Exit codes: 0 done, 1 error, 2 usage, 3 budget, 4 step limit, 130 interrupted.`

/** Hand-written so the CLI has no dependency; `--flag value` and `--flag=value` both work. */
export function parseArgs(argv: string[]): ParseResult {
  const args: CliArgs = { outputFormat: 'text', continue: false, version: false, help: false, prompt: '' }
  const words: string[] = []
  let formatGiven = false
  const fail = (error: string): ParseResult => ({ ok: false, error })

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    if (arg === '--') {
      words.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      words.push(arg)
      continue
    }
    // `--name=value` and `-pvalue` carry their value; otherwise the next word is the value.
    let inline: string | undefined
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    if (eq > 0) {
      inline = arg.slice(eq + 1)
      arg = arg.slice(0, eq)
    } else if (/^-[pr]./.test(arg)) {
      inline = arg.slice(2)
      arg = arg.slice(0, 2)
    }
    const value = (name: string): string | ParseResult => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith('-') && next !== '-')) return fail(`${name} needs a value`)
      i++
      return next
    }
    const bool = (): boolean => {
      if (inline !== undefined) throw new Error(`${arg} takes no value`)
      return true
    }
    try {
      switch (arg) {
        case '-p':
        case '--print': {
          // The prompt may come from stdin alone, so a missing value is fine.
          const next = argv[i + 1]
          if (inline !== undefined) args.print = inline
          else if (next !== undefined && !next.startsWith('-')) {
            args.print = next
            i++
          } else args.print = ''
          break
        }
        case '--output-format': {
          const v = value(arg)
          if (typeof v !== 'string') return v
          if (!FORMATS.includes(v as OutputFormat)) return fail(`--output-format must be one of: ${FORMATS.join(', ')} (got "${v}")`)
          args.outputFormat = v as OutputFormat
          formatGiven = true
          break
        }
        case '--model': {
          const v = value(arg)
          if (typeof v !== 'string') return v
          args.model = v
          break
        }
        case '--mode': {
          const v = value(arg)
          if (typeof v !== 'string') return v
          if (!MODES.includes(v as PermissionMode)) return fail(`--mode must be one of: ${MODES.join(', ')} (got "${v}")`)
          args.mode = v as PermissionMode
          break
        }
        case '-c':
        case '--continue':
          args.continue = bool()
          break
        case '-r':
        case '--resume': {
          const v = value(arg)
          if (typeof v !== 'string') return v
          args.resume = v
          break
        }
        case '--cwd': {
          const v = value(arg)
          if (typeof v !== 'string') return v
          args.cwd = v
          break
        }
        case '--max-steps': {
          const v = value(arg)
          if (typeof v !== 'string') return v
          if (!/^\d+$/.test(v) || Number(v) < 1) return fail(`--max-steps must be a positive whole number (got "${v}")`)
          args.maxSteps = Number(v)
          break
        }
        case '-v':
        case '--version':
          args.version = bool()
          break
        case '-h':
        case '--help':
          args.help = bool()
          break
        default:
          return fail(`unknown option "${arg}". Run "xari --help" for the list.`)
      }
    } catch (e) {
      return fail((e as Error).message)
    }
  }

  if (args.continue && args.resume) return fail('use either --continue or --resume, not both')
  if (formatGiven && args.print === undefined) return fail('--output-format only works with -p/--print')
  // Words after -p belong to the prompt too, so `xari -p fix the bug` works unquoted.
  if (args.print !== undefined) args.print = [args.print, ...words].filter(Boolean).join(' ')
  else args.prompt = words.join(' ')
  return { ok: true, args }
}
