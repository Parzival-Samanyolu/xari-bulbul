import fs from 'node:fs'
import path from 'node:path'
import { makeDiff } from '../tools/diff.js'
import { toPosix } from '../tools/types.js'
import type { Checkpoint } from './store.js'

/** Files bigger than this are listed without a diff. */
export const MAX_DIFF_BYTES = 1_000_000

/** One file a chat changed: how it was before the chat's first edit to it, against what's on disk now. */
export interface FileChange {
  /** Absolute path. */
  path: string
  /** Path relative to the chat's folder (with /), or the absolute path when it's outside. */
  rel: string
  status: 'added' | 'modified' | 'deleted'
  /** `at` of every checkpoint that holds the file, oldest first. Reverting them newest first restores it. */
  turns: number[]
  /** Unified diff; empty when `note` says why there is none. */
  patch: string
  added: number
  removed: number
  /** Why there's no diff (binary or too large). */
  note?: string
}

type Read = (file: string) => string | null

const readDisk: Read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const isBinary = (s: string) => s.slice(0, 8000).includes('\0')

/**
 * Builds the per-file diff of a chat's checkpoints against the working tree. Each file is compared
 * from its content before the earliest turn that touched it; files that are back to that content
 * are left out.
 */
export function checkpointChanges(checkpoints: Checkpoint[], cwd: string, read: Read = readDisk): FileChange[] {
  const byFile = new Map<string, { before: string | null; turns: number[] }>()
  for (const cp of [...checkpoints].sort((a, b) => a.at - b.at)) {
    for (const [file, before] of Object.entries(cp.files)) {
      const seen = byFile.get(file)
      if (seen) seen.turns.push(cp.at)
      else byFile.set(file, { before, turns: [cp.at] })
    }
  }
  const out: FileChange[] = []
  for (const [file, { before, turns }] of byFile) {
    const now = read(file)
    if (now === before) continue
    const status = before === null ? 'added' : now === null ? 'deleted' : 'modified'
    const relRaw = path.relative(cwd, file)
    const rel = relRaw && !relRaw.startsWith('..') && !path.isAbsolute(relRaw) ? toPosix(relRaw) : file
    const base = { path: file, rel, status, turns } as const
    const a = before ?? ''
    const b = now ?? ''
    if (isBinary(a) || isBinary(b)) out.push({ ...base, patch: '', added: 0, removed: 0, note: 'Binary file' })
    else if (Buffer.byteLength(a) > MAX_DIFF_BYTES || Buffer.byteLength(b) > MAX_DIFF_BYTES)
      out.push({ ...base, patch: '', added: 0, removed: 0, note: 'Too large to show' })
    else {
      const d = makeDiff(rel, a, b)
      out.push({ ...base, patch: d.patch, added: d.added, removed: d.removed })
    }
  }
  return out.sort((x, y) => x.rel.localeCompare(y.rel))
}
