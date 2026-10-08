import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { findFiles, loadGitignore } from './fs-walk.js'
import { defineTool, resolvePath, toPosix, truncate } from './types.js'

export const listDirTool = defineTool({
  name: 'list_dir',
  description:
    'List the entries of one directory; folders end with "/". Honors .gitignore. ' +
    'For finding files by name across the project, glob is usually better.',
  input: z.object({ path: z.string().default('.').describe('Directory path; defaults to the workspace root') }),
  kind: 'read',
  readOnly: true,
  subject: (i) => i.path,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => null)
    if (!entries) return { content: `Directory not found: ${abs}`, isError: true }
    const ig = await loadGitignore(ctx.cwd)
    const lines = entries
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .filter((e) => {
        const rel = toPosix(path.relative(ctx.cwd, path.join(abs, e.name)))
        return rel.startsWith('..') || rel === '' || !ig.ignores(e.isDirectory() ? rel + '/' : rel)
      })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return { content: lines.length ? truncate(lines.join('\n'), ctx.toolOutputMaxChars) : '(empty directory)' }
  },
})

export const globTool = defineTool({
  name: 'glob',
  description: [
    'Find files by name pattern, e.g. "src/**/*.ts" or "**/package.json".',
    '- Returns paths relative to the search folder, honoring .gitignore (node_modules and .git are always skipped).',
    '- Use it instead of `find` or `ls -R` in bash.',
    '- Run several glob and grep calls in one response when they are independent; they run in parallel.',
  ].join('\n'),
  input: z.object({
    pattern: z.string().describe('Glob pattern'),
    path: z.string().optional().describe('Directory to search in; defaults to the workspace root'),
  }),
  kind: 'read',
  readOnly: true,
  subject: (i) => i.pattern,
  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.')
    const files = await findFiles(root, input.pattern, { signal: ctx.signal })
    const LIMIT = 500
    const shown = files.slice(0, LIMIT)
    const more = files.length > LIMIT ? `\n(${files.length - LIMIT} more not shown; narrow the pattern)` : ''
    return { content: shown.length ? shown.join('\n') + more : 'No files matched.' }
  },
})

export const grepTool = defineTool({
  name: 'grep',
  description: [
    'Search file contents with a JavaScript regular expression; returns "path:line: text" matches.',
    '- Use it instead of grep or rg in bash.',
    '- Narrow the search with include (a glob such as "**/*.ts") and path. Escape regex characters: "foo\\(" to find "foo(".',
    '- Skips binary files, files over 2 MB and anything ignored by .gitignore.',
    '- For an open-ended search that may need many rounds, delegate it with the task tool instead.',
  ].join('\n'),
  input: z.object({
    pattern: z.string().describe('Regular expression'),
    path: z.string().optional().describe('Directory to search; defaults to the workspace root'),
    include: z.string().optional().describe('Glob of files to search, default "**/*"'),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(2000).optional(),
  }),
  kind: 'read',
  readOnly: true,
  subject: (i) => i.pattern,
  async execute(input, ctx) {
    let re: RegExp
    try {
      re = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
    } catch (e) {
      return { content: `Invalid regex: ${(e as Error).message}`, isError: true }
    }
    const root = resolvePath(ctx.cwd, input.path ?? '.')
    const files = await findFiles(root, input.include ?? '**/*', { signal: ctx.signal })
    const max = input.max_results ?? 200
    const out: string[] = []
    let total = 0
    for (const rel of files) {
      if (ctx.signal.aborted) break
      const abs = path.join(root, rel)
      const stat = await fs.stat(abs).catch(() => null)
      if (!stat || stat.size > 2_000_000) continue
      const buf = await fs.readFile(abs).catch(() => null)
      if (!buf || buf.subarray(0, 8000).includes(0)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          total++
          if (out.length < max) out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`)
        }
      }
    }
    if (!out.length) return { content: 'No matches.' }
    const more = total > out.length ? `\n(${total - out.length} more matches not shown)` : ''
    return { content: truncate(out.join('\n'), ctx.toolOutputMaxChars) + more }
  },
})
