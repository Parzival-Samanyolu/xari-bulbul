import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { makeDiff } from './diff.js'
import { defineTool, resolvePath } from './types.js'

export const writeFileTool = defineTool({
  name: 'write_file',
  description: [
    'Create a file, or replace a whole file\'s content.',
    '- Prefer edit_file for changes to existing files; use this for new files or complete rewrites.',
    '- Overwriting an existing file requires reading it first in this chat.',
    '- Parent folders are created as needed.',
    '- Do not create documentation or README files unless the user asked for them.',
  ].join('\n'),
  input: z.object({
    path: z.string().describe('File path, absolute or relative to the workspace'),
    content: z.string().describe('Full file content'),
  }),
  kind: 'edit',
  readOnly: false,
  subject: (i) => i.path,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    const before = await fs.readFile(abs, 'utf8').catch(() => null)
    if (before !== null && !ctx.readFiles.has(abs)) {
      return { content: `${abs} already exists. Read it before overwriting.`, isError: true }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, input.content, 'utf8')
    ctx.readFiles.add(abs)
    const display = makeDiff(abs, before ?? '', input.content)
    return {
      content: before === null ? `Created ${abs}` : `Overwrote ${abs} (+${display.added} -${display.removed})`,
      display,
    }
  },
})
