import fs from 'node:fs'
import path from 'node:path'
import { EXIT, loadSettingsFile, resolveDataDir, runHeadless, type Session } from '@harness/core'
import pkg from '../package.json'
import { parseArgs, usage, type CliArgs } from './args.js'
import { cliLanguage, tFor, type T } from './i18n/index.js'
import { createHost, type Host } from './host.js'
import { runInteractive } from './tui/index.js'

/** Everything `run` touches outside itself, so tests can drive it without spawning a process. */
export interface CliIO {
  stdin: { isTTY: boolean; read(): Promise<string> }
  stdout: (s: string) => void
  stderr: (s: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  /** Aborts the running turn (Ctrl+C). */
  signal?: AbortSignal
}

/** Parses the command line, runs it and returns the process exit code. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  // The language is known before the command line is read, so usage errors and --help are translated.
  const t = tFor(cliLanguage(loadSettingsFile(resolveDataDir(io.env)).appearance.language, io.env))
  const parsed = parseArgs(argv, t)
  if (!parsed.ok) {
    io.stderr(`xari: ${parsed.error}\n`)
    return EXIT.usage
  }
  const args = parsed.args
  if (args.help) {
    io.stdout(usage(t) + '\n')
    return EXIT.ok
  }
  if (args.version) {
    io.stdout(`${pkg.version}\n`)
    return EXIT.ok
  }

  const cwd = path.resolve(io.cwd, args.cwd ?? '.')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    io.stderr(`xari: ${t('error.notAFolder', { path: cwd })}\n`)
    return EXIT.usage
  }
  // Read piped input before anything else, so a usage error doesn't leave the pipe unread.
  let prompt = ''
  if (args.print !== undefined) {
    const piped = io.stdin.isTTY ? '' : await io.stdin.read()
    prompt = [args.print, piped.trim()].filter(Boolean).join('\n\n')
    if (!prompt) {
      io.stderr(`xari: ${t('error.needsPrompt')}\n`)
      return EXIT.usage
    }
  } else if (!io.stdin.isTTY) {
    io.stderr(`xari: ${t('error.noTerminal')}\n`)
    return EXIT.usage
  }

  const host = await createHost({ cwd, env: io.env, version: pkg.version, mode: args.mode, maxSteps: args.maxSteps })
  try {
    const session = await pickSession(host, args, t)
    if (typeof session === 'string') {
      io.stderr(`xari: ${session}\n`)
      return EXIT.usage
    }
    const hint = host.keyHint(session.meta.model.providerId)
    if (hint) io.stderr(`xari: ${hint}\n`)

    if (args.print === undefined) return await runInteractive(host, { initialPrompt: args.prompt || undefined, session })

    // MCP servers connect in the background; a one-shot run waits a little so their tools exist.
    await host.waitForMcp(10_000)
    // Ctrl+C before the turn started: the abort event already fired, so nothing would hear it.
    if (io.signal?.aborted) return EXIT.interrupted
    const result = await runHeadless({
      prompt: host.expandPrompt(prompt, session.meta.cwd),
      format: args.outputFormat,
      agent: host.agentOptions(session, args.mode),
      out: io.stdout,
      err: io.stderr,
      signal: io.signal,
    })
    return result.exitCode
  } catch (e) {
    io.stderr(`xari: ${(e as Error).message}\n`)
    return EXIT.error
  } finally {
    await host.dispose()
  }
}

/** The chat to use: a resumed or continued one, or a new one. A string is an error message. */
async function pickSession(host: Host, args: CliArgs, t: T): Promise<Session | string> {
  let session: Session | null = null
  if (args.resume) {
    // An id, or the start of one.
    const meta = host.listSessions('').find((m) => m.id === args.resume) ?? host.listSessions('').find((m) => m.id.startsWith(args.resume!))
    session = meta ? await host.loadSession(meta.id) : null
    if (!session) return t('error.noChat', { id: args.resume })
  } else if (args.continue) {
    session = await host.latestSession()
  }
  session ??= host.newSession()
  if (args.model) session.meta.model = host.resolveModel(args.model)
  return session
}

/** Reads all of stdin (only called when it is piped). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The real process: wires Ctrl+C to the signal and exits with `run`'s code. */
export async function main(): Promise<never> {
  const ac = new AbortController()
  let interrupts = 0
  process.on('SIGINT', () => {
    // First Ctrl+C stops the turn cleanly; a second one quits right away.
    if (++interrupts > 1) process.exit(EXIT.interrupted)
    ac.abort(new Error('Interrupted by user'))
  })
  const code = await run(process.argv.slice(2), {
    stdin: { isTTY: !!process.stdin.isTTY, read: readStdin },
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    signal: ac.signal,
  })
  // Let stdout drain before exiting (piped output can still be buffered).
  process.stdout.write('', () => process.exit(ac.signal.aborted && code === EXIT.ok ? EXIT.interrupted : code))
  return new Promise<never>(() => {})
}
