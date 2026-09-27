import fs from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, resolvePath, truncate } from './types.js'

const MAX_LINES = 2000

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file. Returns lines prefixed with line numbers ("  12→text"). ' +
    `Reads up to ${MAX_LINES} lines by default; use offset/limit for large files. ` +
    'You must read a file before editing it.',
  input: z.object({
    path: z.string().describe('File path, absolute or relative to the workspace'),
    offset: z.number().int().min(1).optional().describe('1-based line to start from'),
    limit: z.number().int().min(1).optional().describe('Number of lines to read'),
  }),
  kind: 'read',
  readOnly: true,
  subject: (i) => i.path,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return { content: `File not found: ${abs}`, isError: true }
    if (stat.isDirectory()) return { content: `${abs} is a directory. Use list_dir instead.`, isError: true }
    const buf = await fs.readFile(abs)
    if (buf.subarray(0, 8000).includes(0)) return { content: `${abs} looks like a binary file.`, isError: true }
    ctx.readFiles.add(abs)
    const lines = buf.toString('utf8').split(/\r?\n/)
    const start = (input.offset ?? 1) - 1
    const end = Math.min(lines.length, start + (input.limit ?? MAX_LINES))
    const width = String(end).length
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(width)}→${l}`)
      .join('\n')
    const more = end < lines.length ? `\n\n(${lines.length - end} more lines; use offset=${end + 1} to continue)` : ''
    return { content: truncate(body || '(empty file)', ctx.toolOutputMaxChars) + more }
  },
})
