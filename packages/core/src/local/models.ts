// Local GGUF models: two curated ones that run on an 8 GB machine, plus whatever the user adds from
// Hugging Face or from a file. Curated and Hugging Face files are pinned to a commit and checked
// against the sha256 Hugging Face reports for them (its LFS oid).

import fs from 'node:fs'
import path from 'node:path'
import { checkDiskSpace, downloadResumable, type DownloadOptions } from './download.js'
import { llamaDirs } from './runtime.js'

/** One file of a model, pinned. */
export interface ModelFile {
  repo: string
  revision: string
  file: string
  size: number
  sha256: string
}

export interface LocalModelDef {
  /** Also the model id the provider lists and llama-server serves (`--alias`). */
  id: string
  name: string
  description: string
  weights: ModelFile
  /** Image projector; with it the model sees images. */
  mmproj?: ModelFile
  /** Most context the model supports. */
  contextLength: number
  /** KV cache bytes per token, when known better than the size-based guess. */
  kvPerToken?: number
}

export const hfUrl = (f: Pick<ModelFile, 'repo' | 'revision' | 'file'>) => `https://huggingface.co/${f.repo}/resolve/${f.revision}/${f.file.split('/').map(encodeURIComponent).join('/')}`

const QWEN = { repo: 'unsloth/Qwen3.5-4B-GGUF', revision: 'e87f176479d0855a907a41277aca2f8ee7a09523' }
const GEMMA = { repo: 'ggml-org/gemma-4-E2B-it-GGUF', revision: '6938c58e698502037401a5f19f6905f2fb2f7dee' }

/**
 * Two small instruct models with tool calling, both with an image projector, each about 3.4 GB in
 * total at 4-bit: they leave room for the OS on an 8 GB machine. Sizes and sha256 from
 * `huggingface.co/api/models/<repo>/tree/<revision>` (checked 30 Oct 2026).
 */
export const CURATED_MODELS: LocalModelDef[] = [
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    description: 'Strong all-rounder for code and tool use; thinks before it answers.',
    weights: { ...QWEN, file: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2_740_937_888, sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4' },
    mmproj: { ...QWEN, file: 'mmproj-F16.gguf', size: 672_423_616, sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864' },
    contextLength: 262_144,
    // Mostly linear-attention layers: a small KV cache.
    kvPerToken: 24 * 1024,
  },
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    description: "Google's small, quick model; good at writing and following instructions.",
    weights: { ...GEMMA, file: 'gemma-4-E2B-it-Q4_0.gguf', size: 2_841_481_184, sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52' },
    mmproj: { ...GEMMA, file: 'mmproj-gemma-4-E2B-it-Q8_0.gguf', size: 557_368_064, sha256: '9406f99c16d68cda4f1f0552192dcc99021ea1fc6d2fd50b1dc3ccf30d04b292' },
    contextLength: 131_072,
    // Sliding-window attention on most layers.
    kvPerToken: 16 * 1024,
  },
]

/** A model added from Hugging Face search or a local file (`<data>/llama/models.json`). */
export interface AddedModel {
  id: string
  name: string
  source: 'hf' | 'file'
  /** Absolute path for files the user added; Hugging Face downloads live under the models folder. */
  path?: string
  weights?: ModelFile
  mmproj?: ModelFile
  size: number
  contextLength: number | null
  vision: boolean
}

export interface InstalledModel {
  id: string
  name: string
  source: 'curated' | 'hf' | 'file'
  file: string
  mmproj: string | null
  size: number
  contextLength: number | null
  vision: boolean
  kvPerToken?: number
}

const repoDir = (repo: string) => repo.replace(/[^A-Za-z0-9._-]+/g, '__')

/** Where a pinned file is stored: `<data>/llama/models/<owner>__<repo>/<file>`. */
export function modelFilePath(dataDir: string, f: Pick<ModelFile, 'repo' | 'file'>): string {
  return path.join(llamaDirs(dataDir).models, repoDir(f.repo), path.basename(f.file))
}

export function readAdded(dataDir: string): AddedModel[] {
  try {
    const raw = JSON.parse(fs.readFileSync(llamaDirs(dataDir).manifest, 'utf8'))
    return Array.isArray(raw) ? raw.filter((m) => m && typeof m.id === 'string') : []
  } catch {
    return []
  }
}

function writeAdded(dataDir: string, list: AddedModel[]) {
  const file = llamaDirs(dataDir).manifest
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(list, null, 2))
}

const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Downloaded curated models plus added ones whose file is still there. */
export function installedModels(dataDir: string): InstalledModel[] {
  const out: InstalledModel[] = []
  for (const m of CURATED_MODELS) {
    const file = modelFilePath(dataDir, m.weights)
    const mmproj = m.mmproj && modelFilePath(dataDir, m.mmproj)
    if (!exists(file)) continue
    const hasProj = !!mmproj && exists(mmproj)
    out.push({ id: m.id, name: m.name, source: 'curated', file, mmproj: hasProj ? mmproj! : null, size: m.weights.size + (hasProj ? m.mmproj!.size : 0), contextLength: m.contextLength, vision: hasProj, kvPerToken: m.kvPerToken })
  }
  for (const m of readAdded(dataDir)) {
    const file = m.path ?? (m.weights ? modelFilePath(dataDir, m.weights) : null)
    if (!file || !exists(file)) continue
    const mmproj = m.mmproj ? modelFilePath(dataDir, m.mmproj) : null
    const hasProj = !!mmproj && exists(mmproj)
    out.push({ id: m.id, name: m.name, source: m.source, file, mmproj: hasProj ? mmproj : null, size: m.size, contextLength: m.contextLength, vision: hasProj })
  }
  return out
}

/** Bytes already on disk for a curated model (finished files and `.part`s), to resume a download. */
export function partialBytes(dataDir: string, files: ModelFile[]): number {
  let n = 0
  for (const f of files) {
    const p = modelFilePath(dataDir, f)
    for (const q of [p, `${p}.part`]) {
      try {
        n += fs.statSync(q).size
      } catch {
        /* none */
      }
    }
  }
  return n
}

const filesOf = (m: { weights?: ModelFile; mmproj?: ModelFile }) => [m.weights, m.mmproj].filter((f): f is ModelFile => !!f)

/** Downloads every pinned file of a model (skipping finished ones), with progress over all of them. */
export async function downloadModelFiles(dataDir: string, files: ModelFile[], opts: DownloadOptions = {}): Promise<void> {
  const total = files.reduce((n, f) => n + f.size, 0)
  checkDiskSpace(llamaDirs(dataDir).models, total - partialBytes(dataDir, files), opts.freeSpace)
  let done = 0
  for (const f of files) {
    const dest = modelFilePath(dataDir, f)
    if (!exists(dest)) {
      const base = done
      await downloadResumable(hfUrl(f), f.sha256, dest, f.size, { ...opts, onProgress: (r) => opts.onProgress?.(base + r, total) })
    }
    done += f.size
    opts.onProgress?.(done, total)
  }
}

export async function downloadCurated(dataDir: string, id: string, opts: DownloadOptions = {}): Promise<void> {
  const m = CURATED_MODELS.find((x) => x.id === id)
  if (!m) throw new Error(`Unknown local model: ${id}`)
  await downloadModelFiles(dataDir, filesOf(m), opts)
}

/** A unique model id from a file name ("Qwen3.5-4B-Q4_K_M.gguf" → "qwen3.5-4b-q4_k_m"). */
export function modelIdFor(file: string, taken: Iterable<string>): string {
  const base =
    path
      .basename(file)
      .replace(/\.gguf$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model'
  const used = new Set(taken)
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`
  return id
}

const takenIds = (dataDir: string) => [...CURATED_MODELS.map((m) => m.id), ...readAdded(dataDir).map((m) => m.id)]

/** Downloads a Hugging Face pick and records it. */
export async function downloadHfModel(dataDir: string, pick: { repo: string; revision: string; weights: Omit<ModelFile, 'repo' | 'revision'>; mmproj?: Omit<ModelFile, 'repo' | 'revision'> | null; contextLength: number | null }, opts: DownloadOptions = {}): Promise<AddedModel> {
  const weights: ModelFile = { repo: pick.repo, revision: pick.revision, ...pick.weights }
  const mmproj: ModelFile | undefined = pick.mmproj ? { repo: pick.repo, revision: pick.revision, ...pick.mmproj } : undefined
  for (const f of filesOf({ weights, mmproj })) if (!/^[0-9a-f]{64}$/i.test(f.sha256)) throw new Error(`Hugging Face gave no checksum for ${f.file}.`)
  const existing = readAdded(dataDir).find((m) => m.source === 'hf' && m.weights?.repo === weights.repo && m.weights.file === weights.file)
  const entry: AddedModel = existing ?? {
    id: modelIdFor(weights.file, takenIds(dataDir)),
    name: path.basename(weights.file).replace(/\.gguf$/i, ''),
    source: 'hf',
    weights,
    mmproj,
    size: weights.size + (mmproj?.size ?? 0),
    contextLength: pick.contextLength,
    vision: !!mmproj,
  }
  // Recorded first, so a download that's cancelled halfway shows up and can be resumed or deleted.
  if (!existing) writeAdded(dataDir, [...readAdded(dataDir), entry])
  await downloadModelFiles(dataDir, filesOf(entry), opts)
  return entry
}

/** Reads a GGUF header far enough to tell it's one. */
export function isGguf(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    fs.readSync(fd, buf, 0, 4, 0)
    fs.closeSync(fd)
    return buf.toString('latin1') === 'GGUF'
  } catch {
    return false
  }
}

/** Registers a .gguf on disk (it stays where it is). */
export function addModelFile(dataDir: string, file: string): AddedModel {
  if (!isGguf(file)) throw new Error(`${path.basename(file)} is not a GGUF model file.`)
  if (/^mmproj/i.test(path.basename(file))) throw new Error('That is an image projector (mmproj), not a model. Choose the model file.')
  const list = readAdded(dataDir)
  const same = list.find((m) => m.path === file)
  if (same) return same
  const entry: AddedModel = {
    id: modelIdFor(file, takenIds(dataDir)),
    name: path.basename(file).replace(/\.gguf$/i, ''),
    source: 'file',
    path: file,
    size: fs.statSync(file).size,
    contextLength: null,
    vision: false,
  }
  writeAdded(dataDir, [...list, entry])
  return entry
}

/** Deletes a model's downloaded files (and partial ones). An added file on disk is only forgotten, not deleted. */
export function removeLocalModel(dataDir: string, id: string): void {
  const curated = CURATED_MODELS.find((m) => m.id === id)
  const added = readAdded(dataDir).find((m) => m.id === id)
  if (!curated && !added) throw new Error(`Unknown local model: ${id}`)
  // Two quants of one repo share its image projector; keep files another model still uses.
  const others = [...CURATED_MODELS.filter((m) => m.id !== id), ...readAdded(dataDir).filter((m) => m.id !== id)]
  const kept = new Set(others.flatMap((m) => filesOf(m).map((f) => modelFilePath(dataDir, f))))
  for (const f of filesOf(curated ?? added ?? {})) {
    const p = modelFilePath(dataDir, f)
    if (kept.has(p)) continue
    fs.rmSync(p, { force: true })
    fs.rmSync(`${p}.part`, { force: true })
  }
  if (added) writeAdded(dataDir, readAdded(dataDir).filter((m) => m.id !== id))
}
