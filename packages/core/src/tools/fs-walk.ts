import fs from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import ignore, { type Ignore } from 'ignore'
import { toPosix } from './types.js'

export const ALWAYS_IGNORED = ['**/.git/**', '**/node_modules/**', '**/.DS_Store']

/** Build an ignore matcher from the root .gitignore (nested .gitignores are not supported yet). */
export async function loadGitignore(root: string): Promise<Ignore> {
  const ig = ignore()
  const text = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '')
  if (text) ig.add(text)
  return ig
}

/** Find files under `root` matching `pattern`, honoring .gitignore. Returns paths relative to root. */
export async function findFiles(root: string, pattern: string, opts: { limit?: number; signal?: AbortSignal } = {}) {
  const ig = await loadGitignore(root)
  const entries = await fg(pattern, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ALWAYS_IGNORED,
    suppressErrors: true,
  })
  const out: string[] = []
  for (const e of entries) {
    if (opts.signal?.aborted) break
    const rel = toPosix(e)
    if (ig.ignores(rel)) continue
    out.push(rel)
  }
  return out
}
