// Runs a program without a shell, with a time limit, and keeps the tail of its output.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_CHARS = 200_000

/** The first existing file among `candidates`, or a name on PATH. */
export function findBinary(name, candidates = [], envVar) {
  const override = envVar && process.env[envVar]?.trim()
  if (override) return override
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase())
      if (isFile(file)) return file
    }
  }
  for (const c of candidates) {
    const file = c.replace(/^~(?=$|[\\/])/, os.homedir())
    if (isFile(file)) return file
  }
  return null
}

/** Folders matching `<parent>/<prefix>*` (newest version last), for installs with a version in the path. */
export function versionedDirs(parent, prefix) {
  try {
    return fs
      .readdirSync(parent)
      .filter((d) => d.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((d) => path.join(parent, d))
  } catch {
    return []
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Runs `bin args` and resolves with { code, stdout, stderr, out, timedOut, aborted, error }.
 * Never rejects: a missing program comes back as `error`.
 */
export function run(bin, args, { cwd, timeoutMs = 120_000, signal, env } = {}) {
  return new Promise((resolve) => {
    const r = { code: null, stdout: '', stderr: '', out: '', timedOut: false, aborted: false, error: null }
    let child
    try {
      child = spawn(bin, args, { cwd, env: env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      r.error = e
      return resolve(r)
    }
    const keep = (key) => (b) => {
      const s = b.toString('utf8')
      r[key] = (r[key] + s).slice(-MAX_CHARS)
      r.out = (r.out + s).slice(-MAX_CHARS)
    }
    child.stdout.on('data', keep('stdout'))
    child.stderr.on('data', keep('stderr'))
    const kill = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref()
    }
    const timer = setTimeout(() => ((r.timedOut = true), kill()), timeoutMs)
    const onAbort = () => ((r.aborted = true), kill())
    signal?.addEventListener('abort', onAbort, { once: true })
    let done = false
    const finish = (code, err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      r.code = code
      if (err) r.error = err
      resolve(r)
    }
    child.on('error', (e) => finish(null, e))
    child.on('close', (code) => finish(code))
  })
}

/** Keeps the start and end of long text, so errors at the end aren't lost. */
export function clip(text, max = 30_000) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.4)
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters cut] …\n\n${text.slice(-(max - head))}`
}

/** A tool result for a run that didn't finish normally, or null. */
export function failure(r, what, missingHint) {
  if (r.error?.code === 'ENOENT') return { content: `${what} was not found. ${missingHint}`, isError: true }
  if (r.error) return { content: `${what} could not start: ${r.error.message}`, isError: true }
  if (r.aborted) return { content: `${what} was stopped.`, isError: true }
  if (r.timedOut) return { content: `${what} took too long and was stopped.\n\n${clip(r.out.trim())}`, isError: true }
  return null
}
