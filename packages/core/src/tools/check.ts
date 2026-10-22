import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_SEC = 30
const MAX_LINES = 20
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml']

interface Run {
  code: number | null
  out: string
}

class CheckTimeout extends Error {}

function runCheck(cmd: string, args: string[], cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Run | null> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, signal, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
      // Too slow: say so, so the model knows the file wasn't checked.
      if (e?.killed && !signal?.aborted) return reject(new CheckTimeout())
      // Not installed or aborted: no verdict.
      if (e && (typeof e.code === 'string' || e.killed)) return resolve(null)
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

/** The nearest folder from `file` up to `root` that has `name` in it. */
function findUp(file: string, root: string, names: string[]): string | null {
  let dir = path.dirname(file)
  const top = path.resolve(root)
  for (;;) {
    if (names.some((n) => fs.existsSync(path.join(dir, n)))) return dir
    if (dir === top || path.dirname(dir) === dir) return null
    dir = path.dirname(dir)
  }
}

function onPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, cmd + e))))
}

function clip(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim())
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join('\n') : lines.join('\n')
}

/**
 * A quick check of one edited file with whatever the project already has: eslint, ruff, or the
 * language's own syntax check. Returns the problems, or null when the file is clean or nothing
 * could check it. Never throws.
 */
export async function checkFile(abs: string, root: string, signal?: AbortSignal, timeoutSec = DEFAULT_TIMEOUT_SEC): Promise<string | null> {
  const run = (cmd: string, args: string[], cwd: string, sig?: AbortSignal) => runCheck(cmd, args, cwd, sig, timeoutSec * 1000)
  try {
    const ext = path.extname(abs).toLowerCase()
    if (ext === '.json') {
      try {
        JSON.parse(fs.readFileSync(abs, 'utf8'))
        return null
      } catch (e) {
        return `JSON syntax error: ${(e as Error).message}`
      }
    }
    if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
      const project = findUp(abs, root, ESLINT_CONFIGS)
      const bin = project && path.join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint')
      if (bin && fs.existsSync(bin)) {
        const r = await run(bin, ['--no-color', '--format', 'unix', abs], project!, signal)
        // eslint exits 1 for lint errors and 2 when it can't run (bad config): only report the first.
        if (r?.code === 1 && r.out) return clip(r.out)
        return null
      }
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const r = await run(process.execPath, ['--check', abs], path.dirname(abs), signal)
        if (r && r.code !== 0 && r.out) return clip(r.out)
      }
      return null
    }
    if (ext === '.py') {
      const r = onPath('ruff')
        ? await run('ruff', ['check', '--quiet', '--output-format', 'concise', '--no-cache', abs], root, signal)
        : await run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', abs], root, signal)
      if (r && r.code !== 0 && r.out) return clip(r.out)
      return null
    }
    return null
  } catch (e) {
    if (e instanceof CheckTimeout) return `${TIMED_OUT_PREFIX}${timeoutSec}s; run the project's lint or typecheck yourself.`
    return null
  }
}

const TIMED_OUT_PREFIX = 'Checks timed out after '

/** Appends a file's problems to an edit result, when checks are on and there are any. */
export async function withCheck<T extends { content: string }>(
  result: T,
  abs: string,
  ctx: { cwd: string; signal: AbortSignal; checkAfterEdit?: boolean; checkTimeoutSec?: number },
): Promise<T> {
  if (!ctx.checkAfterEdit) return result
  const problems = await checkFile(abs, ctx.cwd, ctx.signal, ctx.checkTimeoutSec)
  if (!problems) return result
  if (problems.startsWith(TIMED_OUT_PREFIX)) return { ...result, content: `${result.content}\n\n${problems}` }
  return { ...result, content: `${result.content}\n\nThe file has problems after this edit (fix them if your change caused them):\n${problems}` }
}
