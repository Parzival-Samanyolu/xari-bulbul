import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_STEPS,
  CURATED_MODELS,
  LLAMA_BINARIES,
  LOCAL_PROVIDER_ID,
  LlamaServer,
  LocalLlamaProvider,
  addModelFile,
  checkDiskSpace,
  detectMachine,
  downloadCurated,
  downloadHfModel,
  downloadResumable,
  fitFor,
  hfUrl,
  installLlamaRuntime,
  installedModels,
  llamaDirs,
  llamaRuntimeStatus,
  llamaServerArgs,
  memoryNeeded,
  modelFilePath,
  modelFit,
  modelIdFor,
  parseNvidiaSmi,
  parseRepo,
  pickContext,
  pickQuant,
  quantBits,
  quantOf,
  readAdded,
  removeLocalModel,
  searchHf,
  upsertLocalProvider,
  type MachineInfo,
} from '../src/local/index.js'
import { BUILTIN_PROVIDERS, ProviderRegistry, parseSettings } from '../src/index.js'

const GiB = 1024 ** 3
const mac8: MachineInfo = { platform: 'darwin', arch: 'arm64', ram: 8 * GiB, unified: true, gpu: null }
const mac64: MachineInfo = { ...mac8, ram: 64 * GiB }
const pc16gpu8: MachineInfo = { platform: 'win32', arch: 'x64', ram: 16 * GiB, unified: false, gpu: { name: 'RTX 4060', vram: 8 * GiB } }
const cpu8: MachineInfo = { platform: 'linux', arch: 'x64', ram: 8 * GiB, unified: false, gpu: null }

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-llama-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
/** A fetch serving files by URL; honours `range: bytes=N-` with a 206 unless `noRange`. */
function server(files: Record<string, Uint8Array>, opts: { noRange?: boolean } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = files[String(url)]
    if (!body) return new Response('nope', { status: 404 })
    const range = (init?.headers as Record<string, string> | undefined)?.range
    const from = range && !opts.noRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    if (from >= body.length && range && !opts.noRange) return new Response(null, { status: 416 })
    const part = body.slice(from)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(part.slice(0, Math.ceil(part.length / 2)))
        c.enqueue(part.slice(Math.ceil(part.length / 2)))
        c.close()
      },
    })
    return new Response(stream, { status: from ? 206 : 200, headers: { 'content-length': String(part.length) } })
  })
}

describe('fit', () => {
  it('fits both curated models on an 8 GB Apple Silicon Mac at 32K context', () => {
    for (const m of CURATED_MODELS) {
      const size = m.weights.size + (m.mmproj?.size ?? 0)
      const r = modelFit({ size, maxContext: m.contextLength, kvPerToken: m.kvPerToken }, mac8)
      expect(r.fit, m.id).toBe('fits')
      expect(r.ctx).toBe(32_768)
    }
  })

  it('labels models fits / tight / too big by unified memory', () => {
    const gb = 1e9
    expect(fitFor(5 * gb, mac8)).toBe('fits') // under 2/3 of 8 GiB
    expect(fitFor(6.2 * gb, mac8)).toBe('tight') // under 80 %
    expect(fitFor(7.5 * gb, mac8)).toBe('too-big')
    expect(fitFor(40 * gb, mac64)).toBe('fits') // 3/4 on 32 GB+ Macs
  })

  it('uses VRAM first on a discrete GPU, then RAM as tight', () => {
    expect(fitFor(7 * GiB, pc16gpu8)).toBe('fits')
    expect(fitFor(12 * GiB, pc16gpu8)).toBe('tight')
    expect(fitFor(16 * GiB, pc16gpu8)).toBe('too-big')
    expect(fitFor(4 * GiB, cpu8)).toBe('fits')
    expect(fitFor(5.5 * GiB, cpu8)).toBe('tight')
  })

  it('counts weights, KV cache and overhead', () => {
    const need = memoryNeeded({ size: 1e9, ctx: 1000, kvPerToken: 1000 })
    expect(need).toBe(1e9 + 1e6 + 400 * 1024 ** 2 + 0.05e9)
  })

  it('shrinks the context until the model fits, but never above its own limit', () => {
    const big = { size: 4.6e9, kvPerToken: 128 * 1024 }
    expect(pickContext(big, mac8)).toBeLessThan(32_768)
    expect(pickContext({ ...big, maxContext: 8192 }, mac64)).toBe(8192)
    expect(pickContext({ size: 1e9, maxContext: 2048 }, mac8)).toBe(2048)
    expect(CONTEXT_STEPS[0]).toBe(32_768)
    // Hopeless: the smallest step, labelled too big.
    expect(modelFit({ size: 20e9 }, mac8)).toMatchObject({ fit: 'too-big', ctx: 4096 })
  })

  it('reads GPUs from nvidia-smi and leaves Apple Silicon unified', async () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\nNVIDIA T400, 2048\n')).toEqual({ name: 'NVIDIA GeForce RTX 3060', vram: 12288 * 1024 ** 2 })
    expect(parseNvidiaSmi('')).toBeNull()
    const exec = vi.fn(async () => 'RTX 4090, 24564\n')
    expect(await detectMachine({ platform: 'win32', arch: 'x64', ram: 32 * GiB, exec })).toMatchObject({ unified: false, gpu: { vram: 24564 * 1024 ** 2 } })
    const none = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    expect(await detectMachine({ platform: 'darwin', arch: 'arm64', ram: 8 * GiB, exec: none })).toEqual({ ...mac8 })
    expect(none).not.toHaveBeenCalled()
  })
})

describe('downloads', () => {
  it('refuses a checksum mismatch and leaves nothing behind', async () => {
    const body = bytes(1000)
    const dest = path.join(dir, 'm.gguf')
    await expect(downloadResumable('https://x/m', 'ab'.repeat(32), dest, body.length, { fetch: server({ 'https://x/m': body }) as unknown as typeof fetch })).rejects.toThrow(/Checksum mismatch/)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(`${dest}.part`)).toBe(false)
  })

  it('resumes a partial download with a Range request', async () => {
    const body = bytes(5000)
    const dest = path.join(dir, 'm.gguf')
    fs.writeFileSync(`${dest}.part`, body.slice(0, 1200))
    const f = server({ 'https://x/m': body })
    const seen: number[] = []
    await downloadResumable('https://x/m', sha(body), dest, body.length, { fetch: f as unknown as typeof fetch, onProgress: (r) => seen.push(r) })
    expect((f.mock.calls[0][1] as RequestInit).headers).toEqual({ range: 'bytes=1200-' })
    expect(sha(fs.readFileSync(dest))).toBe(sha(body))
    expect(seen.at(-1)).toBe(5000)
    expect(seen[0]).toBeGreaterThan(1200)
  })

  it('starts over when the server ignores Range', async () => {
    const body = bytes(3000)
    const dest = path.join(dir, 'm.gguf')
    fs.writeFileSync(`${dest}.part`, bytes(800, 9)) // not even the right bytes
    await downloadResumable('https://x/m', sha(body), dest, body.length, { fetch: server({ 'https://x/m': body }, { noRange: true }) as unknown as typeof fetch })
    expect(sha(fs.readFileSync(dest))).toBe(sha(body))
  })

  it('keeps the part when cancelled, so the next try resumes', async () => {
    const body = bytes(4000)
    const dest = path.join(dir, 'm.gguf')
    const ac = new AbortController()
    const f = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(body.slice(0, 1000))
          setTimeout(() => {
            ac.abort()
            c.error(new DOMException('aborted', 'AbortError'))
          }, 5)
        },
      })
      return new Response(stream, { status: 200 })
    })
    await expect(downloadResumable('https://x/m', sha(body), dest, body.length, { fetch: f as unknown as typeof fetch, signal: ac.signal })).rejects.toThrow()
    expect(fs.statSync(`${dest}.part`).size).toBe(1000)
  })

  it('refuses when the disk is too full', () => {
    expect(() => checkDiskSpace(dir, 3e9, () => 2e9)).toThrow(/Not enough disk space: this needs 3.0 GB and 2.0 GB is free/)
    expect(() => checkDiskSpace(dir, 1e9, () => 2e9)).not.toThrow()
    expect(() => checkDiskSpace(dir, 1e9, () => null)).not.toThrow()
  })
})

describe('runtime', () => {
  it('pins a checksummed build for macOS, Linux and Windows x64', () => {
    for (const key of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
      const b = LLAMA_BINARIES[key]
      expect(b, key).toBeDefined()
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(b.url).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b11960\//)
    }
  })

  it('installs the build, and refuses a tampered archive', async () => {
    const entry = LLAMA_BINARIES['linux-x64']
    const archive = bytes(2048)
    const extract = vi.fn(async (_a: string, into: string) => {
      fs.mkdirSync(path.join(into, path.dirname(entry.bin)), { recursive: true })
      fs.writeFileSync(path.join(into, entry.bin), '#!/bin/sh\n')
    })
    const tampered = { ...LLAMA_BINARIES }
    // The real sha256 can't match these bytes: refused, nothing installed.
    await expect(installLlamaRuntime(dir, { platform: 'linux', arch: 'x64', extract, fetch: server({ [entry.url]: archive }) as unknown as typeof fetch, freeSpace: () => null })).rejects.toThrow(/Checksum mismatch/)
    expect(extract).not.toHaveBeenCalled()
    expect(fs.existsSync(llamaDirs(dir).bin)).toBe(false)
    expect(tampered['linux-x64']).toBe(entry)

    // With a matching checksum it unpacks into <data>/llama/bin.
    const real = entry.sha256
    try {
      ;(entry as { sha256: string }).sha256 = sha(archive)
      ;(entry as { size: number }).size = archive.length
      const bin = await installLlamaRuntime(dir, { platform: 'linux', arch: 'x64', extract, fetch: server({ [entry.url]: archive }) as unknown as typeof fetch, freeSpace: () => null })
      expect(bin).toBe(path.join(llamaDirs(dir).bin, entry.bin))
      expect(llamaRuntimeStatus(dir, { platform: 'linux', arch: 'x64', env: { PATH: '' } }).binary).toEqual({ path: bin, source: 'download' })
    } finally {
      ;(entry as { sha256: string }).sha256 = real
      ;(entry as { size: number }).size = 35_474_467
    }
  })

  it('falls back to a llama-server on PATH where nothing is published', () => {
    const binDir = path.join(dir, 'brew')
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, 'llama-server'), '#!/bin/sh\n', { mode: 0o755 })
    const s = llamaRuntimeStatus(dir, { platform: 'freebsd', arch: 'x64', env: { PATH: binDir } })
    expect(s.canDownload).toBe(false)
    expect(s.binary).toEqual({ path: path.join(binDir, 'llama-server'), source: 'path' })
  })
})

describe('models', () => {
  it('pins exactly two small curated models to a commit with checksums', () => {
    expect(CURATED_MODELS).toHaveLength(2)
    for (const m of CURATED_MODELS) {
      for (const f of [m.weights, m.mmproj!]) {
        expect(f.revision).toMatch(/^[0-9a-f]{40}$/)
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(m.weights.size + m.mmproj!.size).toBeLessThan(4e9)
      expect(hfUrl(m.weights)).toBe(`https://huggingface.co/${m.weights.repo}/resolve/${m.weights.revision}/${m.weights.file}`)
    }
  })

  it('downloads a curated model with progress over both files, then lists it as seeing images', async () => {
    const m = CURATED_MODELS[0]
    const w = bytes(3000, 2)
    const p = bytes(1000, 3)
    const real = { w: { ...m.weights }, p: { ...m.mmproj! } }
    try {
      Object.assign(m.weights, { size: w.length, sha256: sha(w) })
      Object.assign(m.mmproj!, { size: p.length, sha256: sha(p) })
      const seen: [number, number][] = []
      await downloadCurated(dir, m.id, { fetch: server({ [hfUrl(m.weights)]: w, [hfUrl(m.mmproj!)]: p }) as unknown as typeof fetch, freeSpace: () => null, onProgress: (r, t) => seen.push([r, t]) })
      expect(seen.at(-1)).toEqual([4000, 4000])
      const [inst] = installedModels(dir)
      expect(inst).toMatchObject({ id: m.id, source: 'curated', vision: true, size: 4000, file: modelFilePath(dir, m.weights) })
      removeLocalModel(dir, m.id)
      expect(installedModels(dir)).toEqual([])
    } finally {
      Object.assign(m.weights, real.w)
      Object.assign(m.mmproj!, real.p)
    }
  })

  it('records a Hugging Face model before downloading, so a cancelled one can be resumed or deleted', async () => {
    const w = bytes(2000)
    const pick = { repo: 'someone/Tiny-GGUF', revision: 'a'.repeat(40), weights: { file: 'Tiny-Q4_K_M.gguf', size: w.length, sha256: sha(w) }, mmproj: null, contextLength: 8192 }
    const url = hfUrl({ repo: pick.repo, revision: pick.revision, file: pick.weights.file })
    await expect(downloadHfModel(dir, pick, { fetch: server({}) as unknown as typeof fetch, freeSpace: () => null })).rejects.toThrow(/404/)
    expect(readAdded(dir)).toHaveLength(1)
    const entry = await downloadHfModel(dir, pick, { fetch: server({ [url]: w }) as unknown as typeof fetch, freeSpace: () => null })
    expect(readAdded(dir)).toHaveLength(1)
    expect(entry).toMatchObject({ id: 'tiny-q4_k_m', source: 'hf', vision: false, contextLength: 8192 })
    expect(installedModels(dir).map((m) => m.id)).toEqual(['tiny-q4_k_m'])
    await expect(downloadHfModel(dir, { ...pick, weights: { ...pick.weights, sha256: 'nope' } })).rejects.toThrow(/no checksum/)
  })

  it('adds a local .gguf file in place, and only forgets it on delete', () => {
    const file = path.join(dir, 'My Model.Q4.gguf')
    fs.writeFileSync(file, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60)]))
    const added = addModelFile(dir, file)
    expect(added).toMatchObject({ id: 'my-model.q4', source: 'file', path: file, size: 64 })
    expect(addModelFile(dir, file).id).toBe(added.id)
    const notGguf = path.join(dir, 'x.gguf')
    fs.writeFileSync(notGguf, 'hello')
    expect(() => addModelFile(dir, notGguf)).toThrow(/not a GGUF/)
    removeLocalModel(dir, added.id)
    expect(fs.existsSync(file)).toBe(true)
    expect(readAdded(dir)).toEqual([])
  })

  it('makes unique model ids from file names', () => {
    expect(modelIdFor('Qwen3.5-4B-Q4_K_M.gguf', [])).toBe('qwen3.5-4b-q4_k_m')
    expect(modelIdFor('a/B C.gguf', ['b-c', 'b-c-2'])).toBe('b-c-3')
  })
})

const repoJson = {
  id: 'unsloth/Qwen3.5-4B-GGUF',
  sha: 'e87f176479d0855a907a41277aca2f8ee7a09523',
  downloads: 1300678,
  likes: 321,
  gated: false,
  private: false,
  gguf: { context_length: 262144 },
  siblings: [
    { rfilename: '.gitattributes', size: 3060 },
    { rfilename: 'README.md', size: 78906 },
    { rfilename: 'Qwen3.5-4B-BF16.gguf', size: 8424393632, lfs: { sha256: '9e6e2841a75f503ccb330831832fd7861266e187e0dbf149a954219ccb8c197a', size: 8424393632 } },
    { rfilename: 'Qwen3.5-4B-Q3_K_M.gguf', size: 2293388448, lfs: { sha256: 'd6981ab4d77ba712b48ef69d69042d75b5e39b9dce5fb5a5b054fd08e06afb95', size: 2293388448 } },
    { rfilename: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2740937888, lfs: { sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4', size: 2740937888 } },
    { rfilename: 'Qwen3.5-4B-Q5_K_M.gguf', size: 3143656608, lfs: { sha256: '8814232b85594dcd46c50e5b8b29324a7efe9e746edbe8a3d1df3d3fce7aad39', size: 3143656608 } },
    { rfilename: 'Qwen3.5-4B-Q8_0.gguf', size: 4482403488, lfs: { sha256: '10cc391b403021dd11c614679d2fd92f611c3681d29e29651b717316965d61e1', size: 4482403488 } },
    { rfilename: 'mmproj-F16.gguf', size: 672423616, lfs: { sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864', size: 672423616 } },
    { rfilename: 'mmproj-F32.gguf', size: 1334075072, lfs: { sha256: '758b74e604c5374577c21026c5bdc3aec75560eccb4c67844c8f585d6ec74804', size: 1334075072 } },
    { rfilename: 'big/Model-Q4_K_M-00001-of-00002.gguf', size: 5e10, lfs: { sha256: 'f'.repeat(64), size: 5e10 } },
    { rfilename: 'no-sha.gguf', size: 100 },
  ],
}

describe('Hugging Face', () => {
  it('reads quant names', () => {
    expect(quantOf('Qwen3.5-4B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantOf('Qwen3.5-4B-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL')
    expect(quantOf('gemma-4-E2B-it-Q4_0.gguf')).toBe('Q4_0')
    expect(quantOf('x-IQ4_XS.gguf')).toBe('IQ4_XS')
    expect(quantOf('x-BF16.gguf')).toBe('BF16')
    expect(quantOf('model.gguf')).toBeNull()
    expect(quantBits('IQ4_XS')).toBe(4)
    expect(quantBits('F16')).toBe(16)
  })

  it('parses a repo: GGUF files with an LFS sha256 only', () => {
    const r = parseRepo(repoJson)!
    expect(r.revision).toBe(repoJson.sha)
    expect(r.contextLength).toBe(262144)
    expect(r.files.map((f) => f.file)).not.toContain('no-sha.gguf')
    expect(r.files.find((f) => f.file === 'Qwen3.5-4B-Q4_K_M.gguf')).toEqual({ file: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2740937888, sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4' })
    expect(parseRepo({ ...repoJson, gated: 'manual' })).toBeNull()
  })

  it('picks the biggest quant up to 5 bits that fits, with the smallest projector', () => {
    const r = parseRepo(repoJson)!
    const small = pickQuant(r, { ram: 7 * GiB, unified: true, gpu: null })!
    expect(small.weights.file).toBe('Qwen3.5-4B-Q4_K_M.gguf')
    expect(small.mmproj?.file).toBe('mmproj-F16.gguf')
    expect(small.fit).toBe('fits')
    expect(pickQuant(r, mac64)!.weights.file).toBe('Qwen3.5-4B-Q5_K_M.gguf')
    const tiny = pickQuant(r, { ram: 2 * GiB, unified: false, gpu: null })!
    expect(tiny).toMatchObject({ fit: 'too-big' })
    expect(tiny.weights.file).toBe('Qwen3.5-4B-Q3_K_M.gguf')
  })

  it('searches GGUF repos through the public API (stubbed)', async () => {
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.startsWith('https://huggingface.co/api/models?')) {
        const q = new URL(u).searchParams
        expect(q.get('filter')).toBe('gguf')
        expect(q.get('search')).toBe('qwen 4b')
        expect(q.get('sort')).toBe('downloads')
        return Response.json([{ id: 'unsloth/Qwen3.5-4B-GGUF' }, { id: 'someone/Gated-GGUF', gated: 'auto' }, { id: 'someone/Empty-GGUF' }])
      }
      if (u === 'https://huggingface.co/api/models/unsloth/Qwen3.5-4B-GGUF?blobs=true') return Response.json(repoJson)
      if (u === 'https://huggingface.co/api/models/someone/Empty-GGUF?blobs=true') return Response.json({ id: 'someone/Empty-GGUF', sha: 'b'.repeat(40), siblings: [] })
      return new Response('no', { status: 404 })
    })
    const results = await searchHf('qwen 4b', mac8, { fetch: f as unknown as typeof fetch })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ repo: 'unsloth/Qwen3.5-4B-GGUF', revision: repoJson.sha, vision: true, downloads: 1300678 })
    expect(results[0].pick?.weights.file).toMatch(/Q[45]_K_M/)
    expect(f.mock.calls.some(([u]) => String(u).includes('Gated'))).toBe(false)
    expect(await searchHf('  ', mac8, { fetch: f as unknown as typeof fetch })).toEqual([])
  })
})

describe('serving', () => {
  it('builds llama-server arguments: localhost only, tool calling on', () => {
    expect(llamaServerArgs({ modelId: 'qwen3.5-4b', model: '/m/q.gguf', mmproj: '/m/p.gguf', port: 5123, ctx: 32768 })).toEqual([
      '-m', '/m/q.gguf', '--host', '127.0.0.1', '--port', '5123', '--ctx-size', '32768', '--jinja', '--alias', 'qwen3.5-4b', '--no-webui', '--parallel', '1', '--mmproj', '/m/p.gguf',
    ])
    expect(llamaServerArgs({ modelId: 'x', model: '/x.gguf', port: 1, ctx: 4096 })).not.toContain('--mmproj')
  })

  it('registers and updates the keyless "Local (llama.cpp)" provider', () => {
    const once = upsertLocalProvider(BUILTIN_PROVIDERS, 5123)
    const local = once.find((p) => p.id === LOCAL_PROVIDER_ID)!
    expect(local).toMatchObject({ name: 'Local (llama.cpp)', baseUrl: 'http://127.0.0.1:5123/v1', requiresKey: false, api: 'openai', enabled: true })
    const twice = upsertLocalProvider(once, 6000)
    expect(twice.filter((p) => p.id === LOCAL_PROVIDER_ID)).toHaveLength(1)
    expect(twice.find((p) => p.id === LOCAL_PROVIDER_ID)!.baseUrl).toBe('http://127.0.0.1:6000/v1')
    expect(upsertLocalProvider(twice).find((p) => p.id === LOCAL_PROVIDER_ID)!.baseUrl).toBe('http://127.0.0.1:6000/v1')
    // Survives a settings round trip.
    expect(parseSettings({ providers: twice }).providers.find((p) => p.id === LOCAL_PROVIDER_ID)).toEqual(twice.find((p) => p.id === LOCAL_PROVIDER_ID))
  })

  /** A fake child process. */
  function fakeProc() {
    const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null as string | null, killed: [] as string[] })
    ;(p as unknown as { kill: (s: string) => void }).kill = (s: string) => {
      p.killed.push(s)
      p.signalCode = s
      setTimeout(() => p.emit('exit', null, s), 1)
    }
    return p
  }

  it('starts llama-server, waits for /health, and switches models by restarting', async () => {
    const procs: ReturnType<typeof fakeProc>[] = []
    const spawn = vi.fn((_cmd: string, _args: string[]) => {
      const p = fakeProc()
      procs.push(p)
      return p as never
    })
    let healthCalls = 0
    const f = vi.fn(async () => (++healthCalls < 3 ? new Response('loading', { status: 503 }) : new Response('{"status":"ok"}')))
    const states: string[] = []
    const srv = new LlamaServer({ spawn, fetch: f as unknown as typeof fetch, port: async () => 5123, pollMs: 1, onChange: (s) => states.push(s.state) })
    const spec = { bin: '/rt/llama-server', modelId: 'a', model: '/m/a.gguf', ctx: 8192 }
    const [u1, u2] = await Promise.all([srv.ensure(spec), srv.ensure(spec)])
    expect(u1).toBe('http://127.0.0.1:5123/v1')
    expect(u2).toBe(u1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1]).toContain('--jinja')
    // The key goes through the environment, not the command line.
    expect(spawn.mock.calls[0][1].join(' ')).not.toContain(srv.apiKey)
    expect((spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env.LLAMA_API_KEY).toBe(srv.apiKey)
    expect(srv.isReady('a')).toBe(true)
    expect(states).toEqual(['starting', 'ready'])
    expect(await srv.ensure(spec)).toBe(u1)
    expect(spawn).toHaveBeenCalledTimes(1)

    await srv.ensure({ ...spec, modelId: 'b', model: '/m/b.gguf' })
    expect(procs[0].killed).toEqual(['SIGTERM'])
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(srv.isReady('b')).toBe(true)
    await srv.stop()
    expect(procs[1].killed).toEqual(['SIGTERM'])
    expect(srv.state).toEqual({ state: 'stopped' })
  })

  it('reports why llama-server exited while loading', async () => {
    const proc = fakeProc()
    const srv = new LlamaServer({ spawn: () => proc as never, fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch, port: async () => 1, pollMs: 2 })
    const p = srv.ensure({ bin: '/b', modelId: 'a', model: '/a', ctx: 4096 })
    setTimeout(() => {
      proc.stderr.emit('data', Buffer.from('loading model\nggml_metal: error: failed to allocate buffer, out of memory\n'))
      proc.exitCode = 1
      proc.emit('exit', 1, null)
    }, 5)
    await expect(p).rejects.toThrow(/exit code 1.*out of memory/)
    expect(srv.state).toMatchObject({ state: 'error', modelId: 'a' })
  })

  it('the provider lists installed models and loads one before chatting', async () => {
    const ensure = vi.fn(async () => 'http://127.0.0.1:5123/v1')
    let ready = false
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:5123/v1/chat/completions')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k3y')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    })
    const config = upsertLocalProvider([], 1).find((p) => p.id === LOCAL_PROVIDER_ID)!
    const provider = new LocalLlamaProvider({
      config,
      models: () => [{ id: 'qwen3.5-4b', name: 'Qwen3.5 4B', providerId: LOCAL_PROVIDER_ID, free: true, supportsTools: true, supportsImages: true, contextLength: 32768 }],
      ensure,
      isReady: () => ready,
      apiKey: 'k3y',
      fetch: f as unknown as typeof fetch,
    })
    const registry = new ProviderRegistry([config], () => undefined)
    registry.register(provider)
    expect((await registry.models(LOCAL_PROVIDER_ID)).map((m) => m.id)).toEqual(['qwen3.5-4b'])
    const events = []
    for await (const e of registry.get(LOCAL_PROVIDER_ID).chat({ model: 'qwen3.5-4b', messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(events[0]).toEqual({ type: 'status', text: 'Loading Qwen3.5 4B on this computer. This can take a few minutes.' })
    expect(events).toContainEqual({ type: 'text', delta: 'hi' })
    expect(ensure).toHaveBeenCalledWith('qwen3.5-4b')
    ready = true
    const again = []
    for await (const e of provider.chat({ model: 'qwen3.5-4b', messages: [{ role: 'user', content: 'hi' }] })) again.push(e)
    expect(again.some((e) => e.type === 'status')).toBe(false)
    await expect(async () => {
      for await (const _ of provider.chat({ model: 'missing', messages: [] })) void _
    }).rejects.toThrow(/isn't downloaded/)
  })
})
