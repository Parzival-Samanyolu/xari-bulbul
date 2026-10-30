import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WHISPER_BINARIES,
  WHISPER_MODELS,
  binaryFor,
  chooseVoiceEngine,
  downloadVerified,
  findWhisperOnPath,
  installWhisperBinary,
  installWhisperModel,
  localWhisperStatus,
  parseWhisperOutput,
  pickWhisperModel,
  removeWhisper,
  runWhisperCli,
  whisperDirs,
  type ExecFile,
} from '../src/voice/local.js'
import { encodeWav } from '../src/voice/wav.js'
import { parseSettings } from '../src/settings/schema.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-whisper-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
/** A fetch that serves `body` in two chunks with a content length. */
const serve = (body: Uint8Array, status = 200) =>
  vi.fn(async () => {
    const half = Math.floor(body.length / 2)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(body.slice(0, half))
        c.enqueue(body.slice(half))
        c.close()
      },
    })
    return new Response(stream, { status, headers: { 'content-length': String(body.length) } })
  })

describe('wav encoder', () => {
  it('writes a 16 kHz mono 16-bit PCM header and the samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), 16000)
    const v = new DataView(wav.buffer)
    const ascii = (at: number, n: number) => String.fromCharCode(...wav.slice(at, at + n))
    expect(wav.length).toBe(44 + 5 * 2)
    expect(ascii(0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(wav.length - 8)
    expect(ascii(8, 8)).toBe('WAVEfmt ')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(32, true)).toBe(2)
    expect(v.getUint16(34, true)).toBe(16)
    expect(ascii(36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(10)
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383, 32767])
  })

  it('handles an empty recording', () => {
    const wav = encodeWav(new Float32Array(0))
    expect(wav.length).toBe(44)
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0)
  })
})

describe('engine selection', () => {
  it('auto prefers the local model, then the provider', () => {
    expect(chooseVoiceEngine('auto', { local: true, provider: true })).toBe('local')
    expect(chooseVoiceEngine('auto', { local: false, provider: true })).toBe('provider')
    expect(chooseVoiceEngine('auto', { local: false, provider: false })).toBeNull()
  })

  it('an explicit choice never falls back to the other engine', () => {
    expect(chooseVoiceEngine('provider', { local: true, provider: true })).toBe('provider')
    expect(chooseVoiceEngine('provider', { local: true, provider: false })).toBeNull()
    expect(chooseVoiceEngine('local', { local: false, provider: true })).toBeNull()
    expect(chooseVoiceEngine('local', { local: true, provider: false })).toBe('local')
  })

  it('uses the chosen model when installed, else another installed one', () => {
    const models = (ids: string[]) => ({ models: WHISPER_MODELS.map((m) => ({ id: m.id, label: m.label, size: m.size, installed: ids.includes(m.id) })) })
    expect(pickWhisperModel(models(['tiny', 'small']), 'small')).toBe('small')
    expect(pickWhisperModel(models(['tiny', 'small']), 'base')).toBe('small')
    expect(pickWhisperModel(models(['tiny']), 'base')).toBe('tiny')
    expect(pickWhisperModel(models([]), 'base')).toBeNull()
  })

  it('defaults to auto with the base model', () => {
    expect(parseSettings({}).voice).toMatchObject({ engine: 'auto', localModel: 'base', enabled: true, maxRecordingSec: 120, language: '', autoSend: false })
  })
})

describe('pinned downloads', () => {
  it('pins every binary and model to a sha256, and has no macOS build', () => {
    for (const b of Object.values(WHISPER_BINARIES)) {
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(b.url).toMatch(/^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b\d+\//)
    }
    for (const m of WHISPER_MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      // Pinned to a commit, not `main`.
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-/)
    }
    expect(binaryFor('darwin', 'arm64')).toBeNull()
    expect(binaryFor('linux', 'x64')?.bin).toBe('whisper-bin-ubuntu-x64/whisper-cli')
    expect(binaryFor('win32', 'x64')?.archive).toBe('zip')
  })

  it('keeps a file whose checksum matches and reports progress', async () => {
    const body = crypto.randomBytes(1000)
    const progress: number[] = []
    const dest = path.join(dir, 'm', 'file.bin')
    await downloadVerified('https://x.test/file.bin', sha(body), dest, { fetch: serve(body), onProgress: (n, total) => (expect(total).toBe(1000), progress.push(n)) })
    expect(fs.readFileSync(dest).equals(body)).toBe(true)
    expect(progress).toEqual([500, 1000])
    expect(fs.existsSync(`${dest}.part`)).toBe(false)
  })

  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    const body = crypto.randomBytes(64)
    const dest = path.join(dir, 'file.bin')
    await expect(downloadVerified('https://x.test/file.bin', 'a'.repeat(64), dest, { fetch: serve(body) })).rejects.toThrow(/Checksum mismatch/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('fails on an HTTP error', async () => {
    await expect(downloadVerified('https://x.test/f', 'a'.repeat(64), path.join(dir, 'f'), { fetch: serve(new Uint8Array(1), 404) })).rejects.toThrow(/404/)
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return new Response('x')
    })
    await expect(downloadVerified('https://x.test/f', 'a'.repeat(64), path.join(dir, 'f'), { fetch: fetch as typeof globalThis.fetch, signal: ac.signal })).rejects.toThrow()
    expect(fs.existsSync(path.join(dir, 'f'))).toBe(false)
  })

  it('installs a model under <data>/whisper/models after verifying it', async () => {
    const tiny = WHISPER_MODELS.find((m) => m.id === 'tiny')!
    const body = crypto.randomBytes(32)
    // The real checksum can't match random bytes.
    await expect(installWhisperModel(dir, 'tiny', { fetch: serve(body) })).rejects.toThrow(/Checksum mismatch/)
    expect(fs.existsSync(path.join(whisperDirs(dir).models, tiny.file))).toBe(false)
  })

  it('unpacks the binary archive with the injected extractor and swaps it into place', async () => {
    const entry = WHISPER_BINARIES['linux-x64']
    const body = crypto.randomBytes(16)
    const original = entry.sha256
    entry.sha256 = sha(body)
    try {
      const extract = vi.fn(async (archive: string, into: string, kind: string) => {
        expect(fs.existsSync(archive)).toBe(true)
        expect(kind).toBe('tar.gz')
        fs.mkdirSync(path.join(into, 'whisper-bin-ubuntu-x64'), { recursive: true })
        fs.writeFileSync(path.join(into, 'whisper-bin-ubuntu-x64', 'whisper-cli'), '#!/bin/sh\n')
      })
      const bin = await installWhisperBinary(dir, { platform: 'linux', arch: 'x64', fetch: serve(body), extract })
      expect(bin).toBe(path.join(whisperDirs(dir).bin, 'whisper-bin-ubuntu-x64', 'whisper-cli'))
      expect(fs.statSync(bin).mode & 0o111).not.toBe(0)
      // The archive and staging folder are gone.
      expect(fs.readdirSync(whisperDirs(dir).root)).toEqual(['bin'])
      const status = localWhisperStatus(dir, { platform: 'linux', arch: 'x64', env: { PATH: '' } })
      expect(status.binary).toEqual({ path: bin, source: 'download' })
      removeWhisper(dir, 'binary')
      expect(localWhisperStatus(dir, { platform: 'linux', arch: 'x64', env: { PATH: '' } }).binary).toBeNull()
    } finally {
      entry.sha256 = original
    }
  })

  it('refuses to download a binary where none is published', async () => {
    await expect(installWhisperBinary(dir, { platform: 'darwin', arch: 'arm64', fetch: serve(new Uint8Array(1)) })).rejects.toThrow(/no build/)
  })
})

describe('whisper-cli on PATH', () => {
  it('finds whisper-cli or the older whisper-cpp name', () => {
    if (process.platform === 'win32') return
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    expect(findWhisperOnPath({ PATH: bin }, 'linux')).toBeNull()
    fs.writeFileSync(path.join(bin, 'whisper-cpp'), '#!/bin/sh\n', { mode: 0o755 })
    expect(findWhisperOnPath({ PATH: bin }, 'linux')).toBe(path.join(bin, 'whisper-cpp'))
    // Not executable = not usable.
    fs.writeFileSync(path.join(bin, 'whisper-cli'), '', { mode: 0o644 })
    expect(findWhisperOnPath({ PATH: bin }, 'linux')).toBe(path.join(bin, 'whisper-cpp'))
    fs.chmodSync(path.join(bin, 'whisper-cli'), 0o755)
    expect(findWhisperOnPath({ PATH: bin }, 'linux')).toBe(path.join(bin, 'whisper-cli'))
    const status = localWhisperStatus(dir, { platform: 'darwin', arch: 'arm64', env: { PATH: bin } })
    expect(status.binary).toEqual({ path: path.join(bin, 'whisper-cli'), source: 'path' })
    expect(status.canDownloadBinary).toBe(false)
    expect(status.models.every((m) => !m.installed)).toBe(true)
  })
})

describe('running whisper-cli', () => {
  it('passes the model, a temp WAV and auto language, then parses the text', async () => {
    let seenWav: Buffer | null = null
    let seenArgs: string[] = []
    const exec: ExecFile = vi.fn(async (_file, args) => {
      seenArgs = args
      seenWav = fs.readFileSync(args[args.indexOf('-f') + 1])
      return { stdout: ' Hello there.\n And more [BLANK_AUDIO]\n\n', stderr: 'whisper_init_from_file: loading model' }
    })
    const wav = encodeWav(new Float32Array(160))
    const text = await runWhisperCli({ bin: '/opt/whisper/whisper-cli', model: '/m/ggml-base.bin', wav, threads: 4, execFile: exec, tmpDir: dir })
    expect(text).toBe('Hello there. And more')
    expect(exec).toHaveBeenCalledWith('/opt/whisper/whisper-cli', expect.any(Array), expect.objectContaining({ cwd: '/opt/whisper' }))
    expect(seenArgs.slice(0, 2)).toEqual(['-m', '/m/ggml-base.bin'])
    expect(seenArgs).toEqual(expect.arrayContaining(['-l', 'auto', '-t', '4', '-nt', '-np']))
    expect(seenWav!.equals(Buffer.from(wav))).toBe(true)
    // The temp file is removed.
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('reports whisper-cli errors and still removes the temp file', async () => {
    const exec: ExecFile = async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'error: failed to open model\n' })
    }
    await expect(runWhisperCli({ bin: '/x/whisper-cli', model: '/m.bin', wav: encodeWav(new Float32Array(1)), execFile: exec, tmpDir: dir })).rejects.toThrow('Local transcription failed: error: failed to open model')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('strips timestamps and non-speech markers', () => {
    expect(parseWhisperOutput('[00:00:00.000 --> 00:00:02.000]  Merhaba dünya\n[00:00:02.000 --> 00:00:04.000]   [ Silence ]\n')).toBe('Merhaba dünya')
    expect(parseWhisperOutput('[BLANK_AUDIO]\n')).toBe('')
    expect(parseWhisperOutput('one\r\ntwo  three\n')).toBe('one two three')
  })
})
