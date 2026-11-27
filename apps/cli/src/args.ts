import type { PermissionMode } from '@harness/core'
import { tEn, type MessageKey, type T } from './i18n/index.js'

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

const USAGE_ROWS: [string, MessageKey][] = [
  ['xari [options] [prompt...]', 'help.usage.interactive'],
  ['xari -p "prompt" [options]', 'help.usage.print'],
  ['cat file | xari -p "explain"', 'help.usage.stdin'],
]

const OPTION_ROWS: [string, MessageKey][] = [
  ['-p, --print <prompt>', 'help.opt.print'],
  ['    --output-format <f>', 'help.opt.outputFormat'],
  ['    --model <id>', 'help.opt.model'],
  ['    --mode <mode>', 'help.opt.mode'],
  ['-c, --continue', 'help.opt.continue'],
  ['-r, --resume <id>', 'help.opt.resume'],
  ['    --cwd <dir>', 'help.opt.cwd'],
  ['    --max-steps <n>', 'help.opt.maxSteps'],
  ['-v, --version', 'help.opt.version'],
  ['-h, --help', 'help.opt.help'],
]

/** `--help`: the commands and flags stay as typed; their descriptions are in the interface language. */
export function usage(t: T = tEn): string {
  const rows = (list: [string, MessageKey][], width: number) => list.map(([left, key]) => `  ${left.padEnd(width)}${t(key)}`)
  return [
    `xari: ${t('help.tagline')}`,
    '',
    t('help.usage'),
    ...rows(USAGE_ROWS, 34),
    '',
    t('help.options'),
    ...rows(OPTION_ROWS, 28),
    '',
    t('help.noUi'),
    t('help.exitCodes'),
  ].join('\n')
}

/** Hand-written so the CLI has no dependency; `--flag value` and `--flag=value` both work. */
export function parseArgs(argv: string[], t: T = tEn): ParseResult {
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
      if (next === undefined || (next.startsWith('-') && next !== '-')) return fail(t('error.needsValue', { flag: name }))
      i++
      return next
    }
    const bool = (): boolean => {
      if (inline !== undefined) throw new Error(t('error.takesNoValue', { flag: arg }))
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
          if (!FORMATS.includes(v as OutputFormat)) return fail(t('error.oneOf', { flag: arg, choices: FORMATS.join(', '), value: v }))
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
          if (!MODES.includes(v as PermissionMode)) return fail(t('error.oneOf', { flag: arg, choices: MODES.join(', '), value: v }))
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
          if (!/^\d+$/.test(v) || Number(v) < 1) return fail(t('error.positiveNumber', { flag: arg, value: v }))
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
          return fail(t('error.unknownOption', { option: arg }))
      }
    } catch (e) {
      return fail((e as Error).message)
    }
  }

  if (args.continue && args.resume) return fail(t('error.continueOrResume'))
  if (formatGiven && args.print === undefined) return fail(t('error.formatNeedsPrint'))
  // Words after -p belong to the prompt too, so `xari -p fix the bug` works unquoted.
  if (args.print !== undefined) args.print = [args.print, ...words].filter(Boolean).join(' ')
  else args.prompt = words.join(' ')
  return { ok: true, args }
}
