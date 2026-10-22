import { spawn } from 'node:child_process'
import { killTree } from './jobs.js'
import { resolveShell } from './shell.js'

export interface ShellRun {
  /** stdout and stderr interleaved, as the user would see them. */
  out: string
  stdout: string
  stderr: string
  /** null when killed or the shell failed to start. */
  code: number | null
  killedFor: 'timeout' | 'abort' | null
  /** Set when the shell couldn't be started. */
  error?: Error
}

export interface ShellRunOptions {
  /** Shell setting (empty = platform default). */
  shell: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Written to the command's stdin, which is then closed. Without it stdin is ignored. */
  stdin?: string
  onData?: (chunk: string) => void
  /** Keep at most this many characters of each stream (the tail matters most). */
  maxChars?: number
}

/** Runs one command in a fresh shell, killing its whole process tree on timeout or abort. */
export function runShell(command: string, o: ShellRunOptions): Promise<ShellRun> {
  const shell = resolveShell(o.shell)
  const cap = o.maxChars ?? 1_000_000
  return new Promise((resolve) => {
    const child = spawn(shell.cmd, shell.args(command), {
      cwd: o.cwd,
      env: o.env ?? process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [o.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const r: ShellRun = { out: '', stdout: '', stderr: '', code: null, killedFor: null }
    const collect = (stream: 'stdout' | 'stderr') => (b: Buffer) => {
      const s = b.toString('utf8')
      r.out = (r.out + s).slice(-cap)
      r[stream] = (r[stream] + s).slice(-cap)
      o.onData?.(s)
    }
    child.stdout!.on('data', collect('stdout'))
    child.stderr!.on('data', collect('stderr'))
    if (o.stdin != null) {
      child.stdin!.on('error', () => {}) // the command may exit without reading it
      child.stdin!.end(o.stdin)
    }
    const timer = setTimeout(() => ((r.killedFor = 'timeout'), killTree(child.pid)), o.timeoutMs)
    const onAbort = () => ((r.killedFor = 'abort'), killTree(child.pid))
    o.signal?.addEventListener('abort', onAbort, { once: true })
    let done = false
    const finish = (code: number | null, err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      r.code = code
      if (err) r.error = err
      resolve(r)
    }
    child.on('error', (e) => finish(null, e))
    child.on('close', (code) => finish(code))
  })
}
