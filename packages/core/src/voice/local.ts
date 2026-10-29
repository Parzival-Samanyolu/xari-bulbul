// Offline speech to text with whisper.cpp's `whisper-cli`.
//
// What whisper.cpp publishes (checked for release b5454 = v1.9.5, Oct 2026): CPU builds for Linux
// x64/arm64 (tar.gz) and Windows x64/arm64 (zip) on its GitHub release; nothing runnable for
// macOS (only an xcframework for app developers). So Linux and Windows can download a pinned,
// checksummed build, and every platform can use a `whisper-cli` already on PATH (macOS:
// `brew install whisper-cpp`). Models come from Hugging Face, pinned to one commit.

import { execFile as nodeExecFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RELEASE = 'b5454'
const RELEASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`

export interface WhisperBinary {
  url: string
  sha256: string
  size: number
  archive: 'tar.gz' | 'zip'
  /** Path of whisper-cli inside the archive. */
  bin: string
}

/** Prebuilt whisper-cli per `${platform}-${arch}`. Missing = no official build. */
export const WHISPER_BINARIES: Record<string, WhisperBinary> = {
  'linux-x64': {
    url: `${RELEASE_URL}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
    size: 10_364_195,
    archive: 'tar.gz',
    bin: 'whisper-bin-ubuntu-x64/whisper-cli',
  },
  'linux-arm64': {
    url: `${RELEASE_URL}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149',
    size: 4_608_377,
    archive: 'tar.gz',
    bin: 'whisper-bin-ubuntu-arm64/whisper-cli',
  },
  'win32-x64': {
    url: `${RELEASE_URL}/whisper-bin-x64.zip`,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    size: 8_928_640,
    archive: 'zip',
    bin: 'Release/whisper-cli.exe',
  },
  'win32-arm64': {
    url: `${RELEASE_URL}/whisper-bin-win-cpu-arm64.zip`,
    sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d',
    size: 4_371_193,
    archive: 'zip',
    bin: 'Release/whisper-cli.exe',
  },
}

const MODEL_REV = '5359861c739e955e79d9a303bcbc70fb988958b1'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REV}`

export const WHISPER_MODEL_IDS = ['tiny', 'base', 'small'] as const
export type WhisperModelId = (typeof WHISPER_MODEL_IDS)[number]

export interface WhisperModel {
  id: WhisperModelId
  label: string
  file: string
  url: string
  sha256: string
  size: number
}

/** Multilingual ggml models. */
export const WHISPER_MODELS: WhisperModel[] = [
  { id: 'tiny', label: 'Tiny: fastest, least accurate', file: 'ggml-tiny.bin', url: `${MODEL_URL}/ggml-tiny.bin`, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', size: 77_691_713 },
  { id: 'base', label: 'Base: quick, good for clear speech', file: 'ggml-base.bin', url: `${MODEL_URL}/ggml-base.bin`, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', size: 147_951_465 },
  { id: 'small', label: 'Small: slower, more accurate', file: 'ggml-small.bin', url: `${MODEL_URL}/ggml-small.bin`, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', size: 487_601_967 },
]

export function whisperDirs(dataDir: string) {
  const root = path.join(dataDir, 'whisper')
  return { root, bin: path.join(root, 'bin'), models: path.join(root, 'models') }
}

export function binaryFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): WhisperBinary | null {
  return WHISPER_BINARIES[`${platform}-${arch}`] ?? null
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

/** A whisper.cpp CLI on PATH (Homebrew's `whisper-cpp` installs `whisper-cli`; older versions `whisper-cpp`). */
export function findWhisperOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  // Apps started from the Dock may lack Homebrew's folders.
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  const names = platform === 'win32' ? ['whisper-cli.exe', 'whisper-cpp.exe'] : ['whisper-cli', 'whisper-cpp']
  for (const name of names) for (const dir of dirs) if (isExecutable(path.join(dir, name))) return path.join(dir, name)
  return null
}

export interface LocalWhisperStatus {
  /** The whisper-cli in use: the downloaded one first, else one on PATH. */
  binary: { path: string; source: 'download' | 'path' } | null
  /** Whether whisper.cpp publishes a build for this platform. */
  canDownloadBinary: boolean
  /** Download size of that build, in bytes. */
  binarySize: number | null
  models: { id: WhisperModelId; label: string; size: number; installed: boolean }[]
  dir: string
}

export function localWhisperStatus(dataDir: string, opts: { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv } = {}): LocalWhisperStatus {
  const dirs = whisperDirs(dataDir)
  const entry = binaryFor(opts.platform, opts.arch)
  const downloaded = entry && path.join(dirs.bin, entry.bin)
  const onPath = downloaded && isExecutable(downloaded) ? null : findWhisperOnPath(opts.env, opts.platform)
  return {
    binary: downloaded && isExecutable(downloaded) ? { path: downloaded, source: 'download' } : onPath ? { path: onPath, source: 'path' } : null,
    canDownloadBinary: !!entry,
    binarySize: entry?.size ?? null,
    models: WHISPER_MODELS.map((m) => ({ id: m.id, label: m.label, size: m.size, installed: fs.existsSync(path.join(dirs.models, m.file)) })),
    dir: dirs.root,
  }
}

/** The preferred model if it's installed, else the first installed one (base, small, tiny). */
export function pickWhisperModel(status: Pick<LocalWhisperStatus, 'models'>, preferred: WhisperModelId): WhisperModelId | null {
  const installed = new Set(status.models.filter((m) => m.installed).map((m) => m.id))
  if (installed.has(preferred)) return preferred
  return (['base', 'small', 'tiny'] as const).find((id) => installed.has(id)) ?? null
}

export type VoiceEnginePref = 'auto' | 'local' | 'provider'

/** auto: the local model when it's installed, else the provider. Null hides the mic button. */
export function chooseVoiceEngine(pref: VoiceEnginePref, available: { local: boolean; provider: boolean }): 'local' | 'provider' | null {
  if (pref === 'local') return available.local ? 'local' : null
  if (pref === 'provider') return available.provider ? 'provider' : null
  return available.local ? 'local' : available.provider ? 'provider' : null
}

// ---------------------------------------------------------------------------------------------
// Downloads

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
  fetch?: typeof fetch
}

/** Streams `url` to `dest`, checking its sha256 before it's moved into place. A mismatch leaves nothing behind. */
export async function downloadVerified(url: string, sha256: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const res = await (opts.fetch ?? fetch)(url, { signal: opts.signal })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = crypto.createHash('sha256')
  const out = fs.openSync(part, 'w')
  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      fs.writeSync(out, value)
      received += value.byteLength
      opts.onProgress?.(received, total)
    }
  } catch (e) {
    fs.closeSync(out)
    fs.rmSync(part, { force: true })
    throw e
  }
  fs.closeSync(out)
  const got = hash.digest('hex')
  if (got !== sha256.toLowerCase()) {
    fs.rmSync(part, { force: true })
    throw new Error(`Checksum mismatch for ${path.basename(url)}: expected ${sha256}, got ${got}. The file was deleted.`)
  }
  fs.renameSync(part, dest)
}

export type Extract = (archive: string, into: string, kind: WhisperBinary['archive']) => Promise<void>

/** System tar: GNU/bsdtar on Linux, and Windows 10+'s bsdtar, which also reads zip files. */
export const extractWithTar: Extract = (archive, into, kind) => {
  const winTar = process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  const tar = process.platform === 'win32' && winTar && fs.existsSync(winTar) ? winTar : 'tar'
  const args = kind === 'tar.gz' ? ['-xzf', archive, '-C', into] : ['-xf', archive, '-C', into]
  return new Promise((resolve, reject) =>
    nodeExecFile(tar, args, { timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(`Couldn't unpack whisper.cpp: ${stderr || err.message}`)) : resolve())),
  )
}

/** Downloads and unpacks this platform's whisper.cpp build into `<data>/whisper/bin`. */
export async function installWhisperBinary(dataDir: string, opts: DownloadOptions & { platform?: NodeJS.Platform; arch?: string; extract?: Extract } = {}): Promise<string> {
  const entry = binaryFor(opts.platform, opts.arch)
  if (!entry) throw new Error('whisper.cpp publishes no build for this system. Install whisper-cli yourself and it will be found on PATH.')
  const dirs = whisperDirs(dataDir)
  const archive = path.join(dirs.root, `whisper-${RELEASE}.${entry.archive}`)
  const staging = `${dirs.bin}.new`
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    await downloadVerified(entry.url, entry.sha256, archive, opts)
    fs.mkdirSync(staging, { recursive: true })
    await (opts.extract ?? extractWithTar)(archive, staging, entry.archive)
    const bin = path.join(staging, entry.bin)
    if (!fs.existsSync(bin)) throw new Error(`The whisper.cpp archive has no ${entry.bin}.`)
    if ((opts.platform ?? process.platform) !== 'win32') fs.chmodSync(bin, 0o755)
    fs.rmSync(dirs.bin, { recursive: true, force: true })
    fs.renameSync(staging, dirs.bin)
    return path.join(dirs.bin, entry.bin)
  } finally {
    fs.rmSync(archive, { force: true })
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export async function installWhisperModel(dataDir: string, id: WhisperModelId, opts: DownloadOptions = {}): Promise<string> {
  const model = WHISPER_MODELS.find((m) => m.id === id)
  if (!model) throw new Error(`Unknown speech model: ${id}`)
  const dest = path.join(whisperDirs(dataDir).models, model.file)
  await downloadVerified(model.url, model.sha256, dest, opts)
  return dest
}

/** Deletes a downloaded model, or the downloaded whisper.cpp build ('binary'). A whisper-cli on PATH is left alone. */
export function removeWhisper(dataDir: string, what: 'binary' | WhisperModelId): void {
  const dirs = whisperDirs(dataDir)
  if (what === 'binary') return fs.rmSync(dirs.bin, { recursive: true, force: true })
  const model = WHISPER_MODELS.find((m) => m.id === what)
  if (model) fs.rmSync(path.join(dirs.models, model.file), { force: true })
}

export function whisperModelPath(dataDir: string, id: WhisperModelId): string {
  return path.join(whisperDirs(dataDir).models, WHISPER_MODELS.find((m) => m.id === id)!.file)
}

// ---------------------------------------------------------------------------------------------
// Running whisper-cli

/** whisper-cli prints one segment per line; with timestamps off there's nothing else, but strip them and markers like [BLANK_AUDIO] anyway. */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, ''))
    .map((l) => l.replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE|[ _]*Silence[ _]*)\]|\((?:silence|music|noise)\)/gi, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type ExecFile = (file: string, args: string[], opts: { cwd: string; timeout: number; maxBuffer: number; signal?: AbortSignal; windowsHide: boolean }) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ExecFile = (file, args, opts) =>
  new Promise((resolve, reject) =>
    nodeExecFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout, stderr })
    }),
  )

/** Writes the WAV to a temp file, runs whisper-cli on it, and returns the text. */
export async function runWhisperCli(opts: { bin: string; model: string; wav: Uint8Array; language?: string; threads?: number; signal?: AbortSignal; execFile?: ExecFile; tmpDir?: string }): Promise<string> {
  const tmp = path.join(opts.tmpDir ?? os.tmpdir(), `xb-voice-${process.pid}-${crypto.randomBytes(4).toString('hex')}.wav`)
  fs.writeFileSync(tmp, opts.wav)
  const threads = opts.threads ?? Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length))
  // -nt: no timestamps; -np: print only the text; -l auto: detect the language (whisper-cli defaults to English).
  const args = ['-m', opts.model, '-f', tmp, '-l', opts.language || 'auto', '-t', String(threads), '-nt', '-np']
  try {
    const { stdout } = await (opts.execFile ?? defaultExec)(opts.bin, args, { cwd: path.dirname(opts.bin), timeout: 300_000, maxBuffer: 4 * 1024 * 1024, signal: opts.signal, windowsHide: true })
    return parseWhisperOutput(stdout)
  } catch (e) {
    const err = e as Error & { stderr?: string; code?: unknown }
    const detail = (err.stderr ?? '').trim().split('\n').slice(-3).join(' ') || err.message
    throw new Error(`Local transcription failed: ${detail}`)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
