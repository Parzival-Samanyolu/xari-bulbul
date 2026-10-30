// Large downloads for local models: resumable (a cancelled or broken download keeps its `.part`
// and continues with a Range request), checked against a sha256 before the file is moved into
// place, and refused up front when the disk is too full.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface DownloadOptions {
  signal?: AbortSignal
  /** Bytes of this file received so far (including a resumed part), and its total. */
  onProgress?: (received: number, total: number) => void
  fetch?: typeof fetch
  /** Free bytes on the disk holding `dir`; injected for tests. */
  freeSpace?: (dir: string) => number | null
}

/** Free bytes for the current user on the disk holding `dir`, or null when unknown. */
export function freeSpace(dir: string): number | null {
  try {
    let d = dir
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d)
    const s = fs.statfsSync(d)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

const GB = (n: number) => `${(n / 1e9).toFixed(1)} GB`

/** Leave this much free after a download. */
const DISK_MARGIN = 500 * 1024 ** 2

/** Throws when `needed` more bytes wouldn't fit on the disk holding `dir`. */
export function checkDiskSpace(dir: string, needed: number, free: (dir: string) => number | null = freeSpace): void {
  const have = free(dir)
  if (have != null && have < needed + DISK_MARGIN) throw new Error(`Not enough disk space: this needs ${GB(needed)} and ${GB(have)} is free.`)
}

const partSize = (p: string) => {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

async function hashFile(file: string, hash: crypto.Hash): Promise<void> {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
}

/**
 * Streams `url` to `dest` through `dest.part`. With a part already there it asks for the rest
 * (falls back to a fresh download when the server ignores Range). A sha256 mismatch deletes the
 * part and throws; an abort or network error keeps it, so the next call resumes.
 */
export async function downloadResumable(url: string, sha256: string, dest: string, size: number, opts: DownloadOptions = {}): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let have = partSize(part)
  if (have > size) {
    fs.rmSync(part, { force: true })
    have = 0
  }
  checkDiskSpace(path.dirname(dest), size - have, opts.freeSpace)
  const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {}
  const res = await (opts.fetch ?? fetch)(url, { signal: opts.signal, headers })
  if (res.status === 416 && have === size) {
    // The part is already complete; just verify it below.
  } else if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${path.basename(dest)}`)
  }
  const resumed = res.status === 206
  if (!resumed && res.status !== 416) have = 0
  const hash = crypto.createHash('sha256')
  if (have > 0) await hashFile(part, hash)
  if (res.status !== 416) {
    const out = fs.openSync(part, resumed ? 'a' : 'w')
    let received = have
    try {
      const reader = res.body!.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        fs.writeSync(out, value)
        received += value.byteLength
        opts.onProgress?.(received, size)
      }
    } finally {
      fs.closeSync(out)
    }
  }
  const got = hash.digest('hex')
  if (got !== sha256.toLowerCase()) {
    fs.rmSync(part, { force: true })
    throw new Error(`Checksum mismatch for ${path.basename(dest)}: expected ${sha256}, got ${got}. The file was deleted.`)
  }
  fs.renameSync(part, dest)
}
