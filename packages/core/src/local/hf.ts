// Finding more GGUF models on Hugging Face through its public API (no account), and choosing the
// quantization that suits this machine.

import { modelFit, type Fit, type MachineInfo } from './fit.js'

const HF = 'https://huggingface.co'

export interface HfFile {
  file: string
  size: number
  sha256: string
}

export interface HfRepo {
  repo: string
  /** Commit the files are pinned to. */
  revision: string
  downloads: number
  likes: number
  contextLength: number | null
  files: HfFile[]
}

export interface HfPick {
  weights: HfFile
  mmproj: HfFile | null
  /** Weights + projector. */
  size: number
  fit: Fit
  ctx: number
}

export interface HfResult {
  repo: string
  revision: string
  downloads: number
  likes: number
  contextLength: number | null
  vision: boolean
  /** The quant chosen for this machine; null when the repo has no single-file GGUF. */
  pick: HfPick | null
  /** How many single-file quants the repo has. */
  quants: number
}

/** "Qwen3.5-4B-UD-Q4_K_XL.gguf" → "UD-Q4_K_XL"; null when the name carries no quant. */
export function quantOf(file: string): string | null {
  const m = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4))\.gguf$/i.exec(file.split('/').pop() ?? file)
  return m ? m[1].toUpperCase() : null
}

/** Bits per weight from the quant name (Q4_K_M → 4); floats → 16/32; unknown → null. */
export function quantBits(q: string | null): number | null {
  if (!q) return null
  if (/^(BF16|F16)$/.test(q)) return 16
  if (q === 'F32') return 32
  if (q === 'MXFP4') return 4
  const m = /I?Q(\d)/.exec(q)
  return m ? Number(m[1]) : null
}

const isSplit = (f: string) => /-\d{5}-of-\d{5}\.gguf$/i.test(f)
const base = (f: string) => f.split('/').pop() ?? f
const isProjector = (f: string) => /^mmproj/i.test(base(f))
/** Draft heads for speculative decoding, not models on their own. */
const isAuxiliary = (f: string) => /^(mtp|draft|imatrix)/i.test(base(f))

/** Picks the weights for this machine: the biggest ≤5-bit quant that fits, else one that's tight, else the smallest. */
export function pickQuant(repo: Pick<HfRepo, 'files' | 'contextLength'>, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>): HfPick | null {
  const gguf = repo.files.filter((f) => /\.gguf$/i.test(f.file) && !isSplit(f.file))
  const projectors = gguf.filter((f) => isProjector(f.file)).sort((a, b) => a.size - b.size)
  const mmproj = projectors[0] ?? null
  const weights = gguf.filter((f) => !isProjector(f.file) && !isAuxiliary(f.file) && (quantBits(quantOf(f.file)) ?? 8) <= 8)
  if (!weights.length) return null
  const low = weights.filter((f) => (quantBits(quantOf(f.file)) ?? 8) <= 5)
  const pool = (low.length ? low : weights).slice().sort((a, b) => b.size - a.size)
  const rated = pool.map((w) => {
    const size = w.size + (mmproj?.size ?? 0)
    return { weights: w, mmproj, size, ...modelFit({ size, maxContext: repo.contextLength }, machine) }
  })
  // A quant only counts as fitting with room for a useful context (8K, or the model's own limit).
  const minCtx = Math.min(8192, repo.contextLength || 8192)
  const best = rated.find((r) => r.fit === 'fits' && r.ctx >= minCtx) ?? rated.find((r) => r.fit !== 'too-big') ?? rated[rated.length - 1]
  return { weights: best.weights, mmproj: best.mmproj, size: best.size, fit: best.fit, ctx: best.ctx }
}

interface RawListItem {
  id?: string
  downloads?: number
  likes?: number
  private?: boolean
  gated?: unknown
}

interface RawRepo extends RawListItem {
  sha?: string
  gguf?: { context_length?: number }
  siblings?: { rfilename?: string; size?: number; lfs?: { sha256?: string; size?: number } }[]
}

/** `/api/models/<repo>?blobs=true` → the repo's GGUF files with their LFS sha256. */
export function parseRepo(raw: RawRepo): HfRepo | null {
  if (!raw.id || !raw.sha || raw.private || (raw.gated && raw.gated !== false)) return null
  const files: HfFile[] = []
  for (const s of raw.siblings ?? []) {
    const sha = s.lfs?.sha256
    const size = s.lfs?.size ?? s.size
    if (!s.rfilename || !/\.gguf$/i.test(s.rfilename) || !sha || !/^[0-9a-f]{64}$/i.test(sha) || !size) continue
    files.push({ file: s.rfilename, size, sha256: sha.toLowerCase() })
  }
  const ctx = raw.gguf?.context_length
  return { repo: raw.id, revision: raw.sha, downloads: raw.downloads ?? 0, likes: raw.likes ?? 0, contextLength: typeof ctx === 'number' && ctx > 0 ? ctx : null, files }
}

export function toResult(repo: HfRepo, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>): HfResult {
  const pick = pickQuant(repo, machine)
  const quants = repo.files.filter((f) => !isProjector(f.file) && !isAuxiliary(f.file) && !isSplit(f.file)).length
  return { repo: repo.repo, revision: repo.revision, downloads: repo.downloads, likes: repo.likes, contextLength: repo.contextLength, vision: repo.files.some((f) => isProjector(f.file)), pick, quants }
}

async function getJson<T>(url: string, f: typeof fetch, signal?: AbortSignal): Promise<T> {
  const res = await f(url, { signal, headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}.`)
  return (await res.json()) as T
}

export async function fetchHfRepo(repo: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<HfRepo | null> {
  const raw = await getJson<RawRepo>(`${HF}/api/models/${repo.split('/').map(encodeURIComponent).join('/')}?blobs=true`, opts.fetch ?? fetch, opts.signal)
  return parseRepo(raw)
}

/** GGUF repos matching `query`, most downloaded first, each with a quant picked for this machine. */
export async function searchHf(query: string, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>, opts: { fetch?: typeof fetch; signal?: AbortSignal; limit?: number } = {}): Promise<HfResult[]> {
  const q = query.trim()
  if (!q) return []
  const f = opts.fetch ?? fetch
  const params = new URLSearchParams({ search: q, filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(opts.limit ?? 12) })
  const list = await getJson<RawListItem[]>(`${HF}/api/models?${params}`, f, opts.signal)
  const repos = await Promise.all(
    (Array.isArray(list) ? list : [])
      .filter((r) => r.id && !r.private && !r.gated)
      .map((r) => fetchHfRepo(r.id!, { fetch: f, signal: opts.signal }).catch(() => null)),
  )
  return repos.filter((r): r is HfRepo => !!r).map((r) => toResult(r, machine)).filter((r) => r.pick)
}
