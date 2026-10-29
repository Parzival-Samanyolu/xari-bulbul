// Read-only file access for the desktop's Files panel: one directory at a time, confined to
// the folders the user has open.
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { loadGitignore } from '../tools/fs-walk.js'
import { toPosix } from '../tools/types.js'

/** Never listed, whatever .gitignore says: version control, dependencies and caches. */
export const TREE_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', '.DS_Store', '__pycache__', '.venv', '.mypy_cache', '.pytest_cache', '.next', '.turbo'])

/** Entries listed per directory; the rest are counted as hidden. */
export const MAX_DIR_ENTRIES = 500

/** Bytes of a file shown in a preview. */
export const MAX_PREVIEW_BYTES = 256 * 1024

export interface DirEntry {
  name: string
  /** Absolute path. */
  path: string
  dir: boolean
}

export interface DirListing {
  entries: DirEntry[]
  /** Entries left out because the directory has more than the cap. */
  hidden: number
}

export interface FilePreview {
  path: string
  size: number
  /** Up to MAX_PREVIEW_BYTES of the file as text; empty for binary files. */
  text: string
  truncated: boolean
  binary: boolean
}

/** `p` with symlinks resolved; for a path that doesn't exist, its nearest existing parent is resolved. */
function real(p: string): string {
  const abs = path.resolve(p)
  try {
    return realpathSync.native(abs).normalize('NFC')
  } catch {
    const parent = path.dirname(abs)
    return parent === abs ? abs.normalize('NFC') : path.join(real(parent), path.basename(abs))
  }
}

/** The root in `roots` that contains `p` (after resolving symlinks), or null when it's outside all of them. */
export function rootFor(roots: string[], p: string): string | null {
  const target = real(p)
  for (const root of roots) {
    const r = real(root)
    const rel = path.relative(r, target)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return root
  }
  return null
}

/** Lists `dir` (inside `root`): folders first, then files, by name; .gitignore'd and noisy entries are skipped. */
export async function listDir(root: string, dir: string, limit = MAX_DIR_ENTRIES): Promise<DirListing> {
  const ig = await loadGitignore(root)
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries: DirEntry[] = []
  for (const d of dirents) {
    if (TREE_SKIP.has(d.name)) continue
    const abs = path.join(dir, d.name)
    let isDir = d.isDirectory()
    if (d.isSymbolicLink()) {
      // Show symlinks by what they point at, but only follow ones that stay inside the folder.
      const st = await fs.stat(abs).catch(() => null)
      if (!st || !rootFor([root], abs)) continue
      isDir = st.isDirectory()
    } else if (!isDir && !d.isFile()) continue
    const rel = toPosix(path.relative(root, abs))
    if (ig.ignores(isDir ? `${rel}/` : rel)) continue
    entries.push({ name: d.name, path: abs, dir: isDir })
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1))
  return { entries: entries.slice(0, limit), hidden: Math.max(0, entries.length - limit) }
}

/** The start of a file for a read-only preview. */
export async function readPreview(file: string, max = MAX_PREVIEW_BYTES): Promise<FilePreview> {
  const st = await fs.stat(file)
  if (!st.isFile()) throw new Error(`Not a file: ${file}`)
  const fh = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(st.size, max))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const bytes = buf.subarray(0, bytesRead)
    const binary = bytes.subarray(0, 8000).includes(0)
    return { path: file, size: st.size, text: binary ? '' : bytes.toString('utf8'), truncated: st.size > bytesRead, binary }
  } finally {
    await fh.close()
  }
}
