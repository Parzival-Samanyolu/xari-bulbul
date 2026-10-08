import { render } from 'ink'
import { EXIT, Permissions, runHeadless, type ProviderRegistry, type Session, type KeyStore } from '@harness/core'
import { HELP, parseCliArgs, UsageError, type CliArgs } from './args.js'
import { Host } from './host.js'
import { ORCHID_ASCII, orchidAnsi } from './theme/logo.js'
import { detectColorLevel, makePalette, queryTerminalTheme, themeFromEnv, ThemeContext } from './theme/palette.js'
import { App } from './ui/App.js'
import { shortPath } from './ui/format.js'
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

export interface Io {
  stdout: NodeJS.WritableStream & { isTTY?: boolean; columns?: number }
  stderr: NodeJS.WritableStream
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  env: NodeJS.ProcessEnv
  cwd: string
  /** Tests inject keys and a registry with mock providers. */
  keys?: KeyStore
  registry?: ProviderRegistry
}

const processIo = (): Io => ({ stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, cwd: process.env.INIT_CWD || process.cwd() })

/**
 * Reads piped input. With `firstChunkMs`, gives up if nothing arrives in time: some callers leave
 * stdin open as an idle pipe, and a run with a prompt should not hang on it.
 */
function readStdin(stdin: NodeJS.ReadableStream, firstChunkMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let timer: NodeJS.Timeout | undefined
    const finish = () => {
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.off('end', finish)
      stdin.off('error', reject)
      stdin.pause()
      resolve(data)
    }
    const onData = (chunk: Buffer | string) => {
      clearTimeout(timer)
      data += chunk.toString()
    }
    if (firstChunkMs !== undefined) timer = setTimeout(finish, firstChunkMs)
    stdin.on('data', onData)
    stdin.once('end', finish)
    stdin.once('error', reject)
    stdin.resume()
  })
}

function makeHost(args: CliArgs, io: Io): Host {
  return new Host({ cwd: args.cwd ?? io.cwd, version: VERSION, env: io.env, keys: io.keys, registry: io.registry })
}

/** Picks the session: --continue, --resume <id>, or a fresh one. */
function pickSession(host: Host, args: CliArgs): { session: Session; resumed: boolean } | { error: string } {
  if (typeof args.resume === 'string') {
    const s = host.findSession(args.resume)
    return s ? { session: s, resumed: true } : { error: `No chat matches "${args.resume}".` }
  }
  if (args.continue) {
    const s = host.latest()
    return s ? { session: s, resumed: true } : { error: `No earlier chat in ${shortPath(host.cwd)}.` }
  }
  const model = args.model ? host.parseModel(args.model) : undefined
  return { session: host.newSession(model), resumed: false }
}

export async function runCli(argv: string[], io: Io = processIo()): Promise<number> {
  let args: CliArgs
  // `pnpm xb -- -p …` passes the separator through.
  if (argv[0] === '--') argv = argv.slice(1)
  try {
    args = parseCliArgs(argv)
  } catch (e) {
    io.stderr.write(`xb: ${(e as Error).message}\nRun xb --help for usage.\n`)
    return EXIT.usage
  }

  if (args.command === 'help') {
    io.stdout.write(HELP + '\n')
    return 0
  }
  if (args.command === 'version') return version(io)
  if (args.command === 'login') return login(args, io)
  if (args.command === 'exec') return exec(args, io)
  return chat(args, io)
}

function version(io: Io): number {
  if (!io.stdout.isTTY) {
    io.stdout.write(`xb ${VERSION}\n`)
    return 0
  }
  const level = detectColorLevel(io.env, true)
  const art = level === 3 ? orchidAnsi('large') : ORCHID_ASCII.join('\n')
  io.stdout.write(`\n${art}\n\n  Xarı Bülbül ${VERSION} (xb)\n  github.com/Parzival-Samanyolu/xari-bulbul\n\n`)
  return 0
}

async function exec(args: CliArgs, io: Io): Promise<number> {
  let prompt = args.prompt ?? ''
  if (!io.stdin.isTTY) {
    const piped = (await readStdin(io.stdin, prompt ? 300 : undefined)).trim()
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped
  }
  if (!prompt) {
    io.stderr.write('xb: no prompt. Usage: xb -p "what to do"  (or pipe text in)\n')
    return EXIT.usage
  }
  const host = makeHost(args, io)
  try {
    await host.start({ bare: args.bare })
    const picked = pickSession(host, args)
    if ('error' in picked) {
      io.stderr.write(`xb: ${picked.error}\n`)
      return EXIT.usage
    }
    const session = picked.session
    if (args.model && picked.resumed) session.meta.model = host.parseModel(args.model)
    const problem = host.problem(session.meta.model)
    if (problem) {
      io.stderr.write(`xb: ${problem}\n`)
      return EXIT.usage
    }
    await host.registry.models(session.meta.model.providerId).catch(() => {})
    const mode = args.mode ?? host.settings.permissions.mode
    const ac = new AbortController()
    const onSig = () => ac.abort()
    process.once('SIGINT', onSig)
    try {
      const res = await runHeadless({
        prompt,
        format: args.format,
        agent: {
          session,
          registry: host.registry,
          tools: host.tools,
          settings: host.settings,
          usage: host.usage,
          permissions: new Permissions({ ...host.settings.permissions, mode }, session.meta.cwd),
          memory: host.memory,
          secret: (id) => host.keys.get(id),
          onSave: (s) => host.store.save(s),
        },
        out: (s) => io.stdout.write(s),
        err: (s) => io.stderr.write(s),
        signal: ac.signal,
      })
      return res.exitCode
    } finally {
      process.off('SIGINT', onSig)
    }
  } finally {
    await host.dispose()
  }
}

/** Reads a line without echoing it (for API keys). */
function readSecret(io: Io, prompt: string): Promise<string> {
  const stdin = io.stdin as NodeJS.ReadStream
  io.stdout.write(prompt)
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return readStdin(stdin).then((s) => s.trim())
  return new Promise((resolve) => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8').replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          io.stdout.write('\n')
          return resolve(value.trim())
        }
        if (ch === '\x03') {
          stdin.setRawMode(false)
          io.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\x7f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1)
            io.stdout.write('\b \b')
          }
        } else if (ch >= ' ') {
          value += ch
          io.stdout.write('•')
        }
      }
    }
    stdin.on('data', onData)
  })
}

async function login(args: CliArgs, io: Io): Promise<number> {
  const host = makeHost(args, io)
  try {
    const providers = host.settings.providers.filter((p) => p.requiresKey)
    const id = args.provider ?? host.settings.models.default.providerId
    if (id === 'brave' || id === 'tavily') return loginSearch(host, id, io)
    const provider = host.provider(id)
    if (!provider) {
      io.stderr.write(`xb: unknown provider "${id}". Providers: ${host.settings.providers.map((p) => p.id).join(', ')}\n`)
      return EXIT.usage
    }
    if (!provider.requiresKey) {
      io.stdout.write(`${provider.name} needs no key.\n`)
      return 0
    }
    io.stdout.write(`Providers that use keys: ${providers.map((p) => p.id).join(', ')}\n`)
    const key = await readSecret(io, `API key for ${provider.name} (input hidden): `)
    if (!key) {
      io.stderr.write('No key entered; nothing changed.\n')
      return EXIT.usage
    }
    host.setKey(id, key)
    io.stdout.write(`Saved in ${host.keys.storage === 'file' ? 'the data folder (no keychain found)' : 'the OS keychain'}. Testing…\n`)
    const res = await host.testProvider(id)
    io.stdout.write(`${res.ok ? '✔' : '✗'} ${res.message}\n`)
    if (host.keys.source(id) === 'env') io.stdout.write(`Note: ${id.toUpperCase().replace(/-/g, '_')}_API_KEY is set in your environment and takes precedence.\n`)
    return res.ok ? 0 : EXIT.error
  } finally {
    await host.dispose()
  }
}

/** Web search keys: stored like API keys, then tested with one search. */
async function loginSearch(host: Host, id: 'brave' | 'tavily', io: Io): Promise<number> {
  const name = id === 'brave' ? 'Brave Search' : 'Tavily'
  const key = await readSecret(io, `${name} API key (input hidden): `)
  if (!key) {
    io.stderr.write('No key entered; nothing changed.\n')
    return EXIT.usage
  }
  host.setKey(id, key)
  const res = await host.testSearch(id)
  io.stdout.write(`${res.ok ? '✔' : '✗'} ${res.message}\n`)
  if (res.ok && host.settings.tools.webSearch.backend !== id) io.stdout.write(`Search now uses ${name} (tools.webSearch.backend).\n`)
  return res.ok ? 0 : EXIT.error
}

async function chat(args: CliArgs, io: Io): Promise<number> {
  if (!io.stdout.isTTY || !io.stdin.isTTY) {
    io.stderr.write('xb: the chat needs a terminal. For scripts and pipes use: xb -p "prompt"\n')
    return EXIT.usage
  }
  const host = makeHost(args, io)
  await host.start({ bare: args.bare })
  const picked = pickSession(host, args)
  if ('error' in picked) {
    io.stderr.write(`xb: ${picked.error}\n`)
    await host.dispose()
    return EXIT.usage
  }
  if (args.model && picked.resumed) picked.session.meta.model = host.parseModel(args.model)

  const configured = args.theme ?? (host.settings.cli.theme !== 'auto' ? host.settings.cli.theme : null)
  const detected = configured ?? themeFromEnv(io.env) ?? (await queryTerminalTheme())
  const palette = makePalette(detected ?? 'dark', detectColorLevel(io.env, true), !!detected)

  let last: Session = picked.session
  const instance = render(
    <ThemeContext.Provider value={palette}>
      <App
        host={host}
        session={picked.session}
        mode={args.mode ?? host.settings.permissions.mode}
        resumed={picked.resumed}
        prompt={args.prompt}
        openResume={args.resume === true}
        onExit={(s) => (last = s)}
      />
    </ThemeContext.Provider>,
    { exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } },
  )
  await instance.waitUntilExit()
  if (last.messages.length) io.stdout.write(`\nChat saved. Continue it with: xb --resume ${last.meta.id.slice(0, 8)}\n`)
  await host.dispose()
  return 0
}
