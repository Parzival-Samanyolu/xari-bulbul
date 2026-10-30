// The llama.cpp runtime (`llama-server`), pinned to one release.
//
// What ggml-org/llama.cpp publishes (checked for b11960 = v0.8.0, 28 Oct 2026): self-contained
// tar.gz builds for macOS arm64 (Metal) and x64, Linux and Windows builds per backend. Linux and
// Windows x64 use the Vulkan build: its GPU backend is a separately loaded library, so it uses an
// NVIDIA/AMD/Intel GPU when there is one and runs on the CPU otherwise. Sizes and sha256 come from
// the release API's `digest` field and were checked against downloads. Elsewhere, a `llama-server`
// already on PATH is used (macOS: `brew install llama.cpp`).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { downloadResumable, type DownloadOptions } from './download.js'

export const LLAMA_RELEASE = 'b11960'
export const LLAMA_VERSION = '0.8.0'
const RELEASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}`

export interface LlamaBinary {
  url: string
  sha256: string
  size: number
  archive: 'tar.gz' | 'zip'
  /** Path of llama-server inside the archive. */
  bin: string
}

/** Prebuilt llama-server per `${platform}-${arch}`. Missing = use one on PATH. */
export const LLAMA_BINARIES: Record<string, LlamaBinary> = {
  'darwin-arm64': {
    url: `${RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: '58e5a5e1d7c2bf66cedd9c29e0323f3e570660a70a1e2156d32eed08f4cc1e3c',
    size: 16_465_074,
    archive: 'tar.gz',
    bin: `llama-${LLAMA_RELEASE}/llama-server`,
  },
  'darwin-x64': {
    url: `${RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: 'd1e6c9ddcaed9a3b1bb8f3d946bdb3481c7b919357a4029dcb747762397f1da5',
    size: 12_205_764,
    archive: 'tar.gz',
    bin: `llama-${LLAMA_RELEASE}/llama-server`,
  },
  'linux-x64': {
    url: `${RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: '164199e978304bb32a8a6c24b8efa015528ddf286821596eab676c90b375feac',
    size: 35_474_467,
    archive: 'tar.gz',
    bin: `llama-${LLAMA_RELEASE}/llama-server`,
  },
  'win32-x64': {
    url: `${RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-win-vulkan-x64.zip`,
    sha256: 'bac6914b5e83523eb008c6789eaa12669f93fbc196c3b9e8237b6672323b33e9',
    size: 37_345_851,
    archive: 'zip',
    bin: 'llama-server.exe',
  },
}

export function llamaDirs(dataDir: string) {
  const root = path.join(dataDir, 'llama')
  return { root, bin: path.join(root, 'bin'), models: path.join(root, 'models'), manifest: path.join(root, 'models.json') }
}

export function llamaBinaryFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): LlamaBinary | null {
  return LLAMA_BINARIES[`${platform}-${arch}`] ?? null
}

const isExecutable = (p: string) => {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A llama-server on PATH (Homebrew's `llama.cpp` formula installs one). */
export function findLlamaOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  // Apps started from the Dock may lack Homebrew's folders.
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  const name = platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  for (const dir of dirs) if (isExecutable(path.join(dir, name))) return path.join(dir, name)
  return null
}

export interface LlamaRuntimeStatus {
  /** The llama-server in use: the downloaded one first, else one on PATH. */
  binary: { path: string; source: 'download' | 'path' } | null
  canDownload: boolean
  /** Download size of this system's build, in bytes. */
  downloadSize: number | null
  /** The pinned release ("b11960") and its version ("0.8.0"). */
  release: string
  version: string
}

export function llamaRuntimeStatus(dataDir: string, opts: { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv } = {}): LlamaRuntimeStatus {
  const entry = llamaBinaryFor(opts.platform, opts.arch)
  const downloaded = entry && path.join(llamaDirs(dataDir).bin, entry.bin)
  const own = !!downloaded && isExecutable(downloaded)
  const onPath = own ? null : findLlamaOnPath(opts.env, opts.platform)
  return {
    binary: own ? { path: downloaded!, source: 'download' } : onPath ? { path: onPath, source: 'path' } : null,
    canDownload: !!entry,
    downloadSize: entry?.size ?? null,
    release: LLAMA_RELEASE,
    version: LLAMA_VERSION,
  }
}

export type Extract = (archive: string, into: string, kind: LlamaBinary['archive']) => Promise<void>

/** System tar: bsdtar on macOS, GNU/bsdtar on Linux, and Windows 10+'s bsdtar, which also reads zip files. Keeps the dylib symlinks. */
export const extractWithTar: Extract = (archive, into, kind) => {
  const winTar = process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  const tar = process.platform === 'win32' && winTar && fs.existsSync(winTar) ? winTar : 'tar'
  const args = kind === 'tar.gz' ? ['-xzf', archive, '-C', into] : ['-xf', archive, '-C', into]
  return new Promise((resolve, reject) =>
    execFile(tar, args, { timeout: 180_000 }, (err, _out, stderr) => (err ? reject(new Error(`Couldn't unpack llama.cpp: ${stderr || err.message}`)) : resolve())),
  )
}

/** Downloads and unpacks this system's llama.cpp build into `<data>/llama/bin`. */
export async function installLlamaRuntime(dataDir: string, opts: DownloadOptions & { platform?: NodeJS.Platform; arch?: string; extract?: Extract } = {}): Promise<string> {
  const entry = llamaBinaryFor(opts.platform, opts.arch)
  if (!entry) throw new Error('llama.cpp publishes no build for this system. Install llama-server yourself and it will be found on PATH.')
  const dirs = llamaDirs(dataDir)
  const archive = path.join(dirs.root, `llama-${LLAMA_RELEASE}.${entry.archive}`)
  const staging = `${dirs.bin}.new`
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    await downloadResumable(entry.url, entry.sha256, archive, entry.size, opts)
    fs.mkdirSync(staging, { recursive: true })
    await (opts.extract ?? extractWithTar)(archive, staging, entry.archive)
    const bin = path.join(staging, entry.bin)
    if (!fs.existsSync(bin)) throw new Error(`The llama.cpp archive has no ${entry.bin}.`)
    if ((opts.platform ?? process.platform) !== 'win32') fs.chmodSync(bin, 0o755)
    fs.rmSync(dirs.bin, { recursive: true, force: true })
    fs.renameSync(staging, dirs.bin)
    fs.rmSync(archive, { force: true })
    return path.join(dirs.bin, entry.bin)
  } catch (e) {
    // A failed unpack or checksum leaves nothing; an interrupted download keeps its part to resume.
    if (fs.existsSync(archive)) fs.rmSync(archive, { force: true })
    throw e
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function removeLlamaRuntime(dataDir: string): void {
  const dirs = llamaDirs(dataDir)
  fs.rmSync(dirs.bin, { recursive: true, force: true })
  for (const f of fs.existsSync(dirs.root) ? fs.readdirSync(dirs.root) : []) if (/^llama-b\d+\.(tar\.gz|zip)(\.part)?$/.test(f)) fs.rmSync(path.join(dirs.root, f), { force: true })
}
