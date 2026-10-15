import fs from 'node:fs/promises'
import { z } from 'zod'
import { withCheck } from './check.js'
import { makeDiff } from './diff.js'
import { defineTool, resolvePath, type ToolContext, type ToolResult } from './types.js'

export interface Edit {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** Applies one exact replacement to `text`; returns the new text or why it can't. */
export function applyEdit(text: string, edit: Edit, file: string): { text: string } | { error: string } {
  if (edit.old_string === edit.new_string) return { error: 'old_string and new_string are identical.' }
  if (edit.old_string === '') return { error: 'old_string is empty. Use write_file to create files.' }
  // Files with CRLF endings: match against LF-normalized old_string too.
  let oldStr = edit.old_string
  let newStr = edit.new_string
  if (!text.includes(oldStr) && text.includes('\r\n')) {
    oldStr = oldStr.replace(/\r?\n/g, '\r\n')
    newStr = newStr.replace(/\r?\n/g, '\r\n')
  }
  const count = text.split(oldStr).length - 1
  if (count === 0) return { error: `old_string not found in ${file}. Re-read the file and match it exactly.` }
  if (count > 1 && !edit.replace_all) {
    return { error: `old_string occurs ${count} times in ${file}. Add more context to make it unique, or set replace_all.` }
  }
  return { text: edit.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr) }
}

/** Reads `path` (which must have been read in this chat), applies `edits` in order, and writes it once. */
export async function editFile(path: string, edits: Edit[], ctx: ToolContext): Promise<ToolResult> {
  const abs = resolvePath(ctx.cwd, path)
  if (!ctx.readFiles.has(abs)) return { content: `Read ${abs} with read_file before editing it.`, isError: true }
  const before = await fs.readFile(abs, 'utf8').catch(() => null)
  if (before === null) return { content: `File not found: ${abs}`, isError: true }
  let after = before
  for (const [i, edit] of edits.entries()) {
    const r = applyEdit(after, edit, abs)
    if ('error' in r) {
      const which = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : ''
      return { content: `${which}${r.error}${edits.length > 1 ? ' No edits were applied.' : ''}`, isError: true }
    }
    after = r.text
  }
  ctx.checkpoint?.(abs, before)
  await fs.writeFile(abs, after, 'utf8')
  const display = makeDiff(abs, before, after)
  return withCheck({ content: `Edited ${abs} (+${display.added} -${display.removed})`, display }, abs, ctx)
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description: [
    'Replace an exact piece of text in an existing file.',
    '- Read the file first in this chat; edits to unread files are refused.',
    '- old_string must match the file byte for byte, including indentation and blank lines. Copy it from read_file output without the line-number prefix.',
    '- old_string must occur exactly once. If it occurs more often, add surrounding lines until it is unique, or set replace_all to change every occurrence (useful for renames).',
    '- Keep edits small and focused. For several changes to one file, use multi_edit.',
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
  execute: (input, ctx) => editFile(input.path, [input], ctx),
})

export const multiEditTool = defineTool({
  name: 'multi_edit',
  description: [
    'Make several exact replacements in one file in a single call.',
    '- Same rules as edit_file for each edit: read the file first; old_string must match exactly and be unique unless replace_all is set.',
    '- Edits apply in order, each to the result of the previous one. Make sure an earlier edit does not change text a later one looks for.',
    '- All or nothing: if any edit fails, the file is left unchanged.',
  ].join('\n'),
  input: z.object({
    path: z.string().describe('File path, absolute or relative to the workspace'),
    edits: z
      .array(
        z.object({
          old_string: z.string().describe('Exact text to replace'),
          new_string: z.string().describe('Replacement text'),
          replace_all: z.boolean().optional().describe('Replace every occurrence'),
        }),
      )
      .min(1)
      .describe('Edits to apply in order'),
  }),
  kind: 'edit',
  readOnly: false,
  subject: (i) => i.path,
  execute: (input, ctx) => editFile(input.path, input.edits, ctx),
})
