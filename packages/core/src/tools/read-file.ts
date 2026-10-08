import fs from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, resolvePath, truncate } from './types.js'

const MAX_LINES = 2000

export const readFileTool = defineTool({
  name: 'read_file',
  description: [
    'Read a text file from the local filesystem.',
    '- Output lines are numbered ("    12→text"). The number and arrow are not part of the file: never copy them into edit_file.',
    `- Up to ${MAX_LINES} lines are returned by default. For long files, pass offset (1-based line) and limit to read a window; the result says where to continue.`,
    '- Paths may be absolute or relative to the workspace. Binary files and directories are refused (use list_dir for directories).',
    '- When you need several files, request them in the same response: independent reads run in parallel.',
    '- You must read a file in this chat before you edit or overwrite it. Read it again if it may have changed since.',
  ].join('\n'),
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
