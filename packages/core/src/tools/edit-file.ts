import fs from 'node:fs/promises'
import { z } from 'zod'
import { makeDiff } from './diff.js'
import { defineTool, resolvePath } from './types.js'

export const editFileTool = defineTool({
  name: 'edit_file',
  description: [
    'Replace an exact piece of text in an existing file.',
    '- Read the file first in this chat; edits to unread files are refused.',
    '- old_string must match the file byte for byte, including indentation and blank lines. Copy it from read_file output without the line-number prefix.',
    '- old_string must occur exactly once. If it occurs more often, add surrounding lines until it is unique, or set replace_all to change every occurrence (useful for renames).',
    '- Keep edits small and focused; make several edit_file calls rather than rewriting large blocks.',
    '- Preserve the file\'s style: indentation, quotes, line endings. Do not add comments that only narrate the change.',
  ].join('\n'),
  input: z.object({
    path: z.string().describe('File path, absolute or relative to the workspace'),
    old_string: z.string().describe('Exact text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace every occurrence'),
  }),
  kind: 'edit',
  readOnly: false,
  subject: (i) => i.path,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    if (!ctx.readFiles.has(abs)) return { content: `Read ${abs} with read_file before editing it.`, isError: true }
    const before = await fs.readFile(abs, 'utf8').catch(() => null)
    if (before === null) return { content: `File not found: ${abs}`, isError: true }
    if (input.old_string === input.new_string) return { content: 'old_string and new_string are identical.', isError: true }
    if (input.old_string === '') return { content: 'old_string is empty. Use write_file to create files.', isError: true }

    // Files with CRLF endings: match against LF-normalized old_string too.
    let oldStr = input.old_string
    let newStr = input.new_string
    if (!before.includes(oldStr) && before.includes('\r\n')) {
      oldStr = oldStr.replace(/\r?\n/g, '\r\n')
      newStr = newStr.replace(/\r?\n/g, '\r\n')
    }
    const count = before.split(oldStr).length - 1
    if (count === 0) return { content: `old_string not found in ${abs}. Re-read the file and match it exactly.`, isError: true }
    if (count > 1 && !input.replace_all) {
      return {
        content: `old_string occurs ${count} times in ${abs}. Add more context to make it unique, or set replace_all.`,
        isError: true,
      }
    }
    const after = input.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, () => newStr)
    await fs.writeFile(abs, after, 'utf8')
    const display = makeDiff(abs, before, after)
    return { content: `Edited ${abs} (+${display.added} -${display.removed})`, display }
  },
})
