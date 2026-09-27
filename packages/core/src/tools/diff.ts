import { createTwoFilesPatch } from 'diff'
import type { ToolDisplay } from './types.js'

export function makeDiff(file: string, before: string, after: string): Extract<ToolDisplay, { kind: 'diff' }> {
  const patch = createTwoFilesPatch(file, file, before, after, '', '', { context: 3 })
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { kind: 'diff', path: file, patch, added, removed }
}
