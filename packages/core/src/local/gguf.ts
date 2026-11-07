// Reads a GGUF file's metadata (not its tensors) to learn what the model really needs: the
// context it was trained for and the KV cache bytes per token. Added models have no hand-tuned
// numbers, and the size-based guess is several times too high for models with grouped-query or
// hybrid attention, which made the app pick a 4K context for them.

import fs from 'node:fs'

export interface GgufInfo {
  arch: string | null
  contextLength: number | null
  /** KV cache bytes per token at f16, over the layers that have attention. Null when unknown. */
  kvPerToken: number | null
}

type Value = number | bigint | string | boolean | Value[] | null

/** Keys worth keeping; everything else (tokenizer vocabularies, etc.) is skipped without decoding. */
const WANTED = /^(general\.architecture|[\w.]+\.(context_length|block_count|embedding_length|full_attention_interval|attention\.(head_count|head_count_kv|key_length|value_length)))$/

class Reader {
  private buf = Buffer.alloc(0)
  private bufPos = 0
  private filePos = 0
  constructor(
    private readonly fd: number,
    private readonly limit: number,
  ) {}

  private need(n: number) {
    if (this.buf.length - this.bufPos >= n) return
    const rest = this.buf.subarray(this.bufPos)
    const want = Math.max(n, 1 << 20)
    const chunk = Buffer.alloc(want)
    const got = fs.readSync(this.fd, chunk, 0, want, this.filePos)
    this.filePos += got
    if (this.filePos > this.limit) throw new Error('GGUF metadata too large')
    this.buf = Buffer.concat([rest, chunk.subarray(0, got)])
    this.bufPos = 0
    if (this.buf.length < n) throw new Error('GGUF ended early')
  }
  u8() {
    this.need(1)
    return this.buf.readUInt8(this.bufPos++)
  }
  u32() {
    this.need(4)
    const v = this.buf.readUInt32LE(this.bufPos)
    this.bufPos += 4
    return v
  }
  u64() {
    this.need(8)
    const v = this.buf.readBigUInt64LE(this.bufPos)
    this.bufPos += 8
    return v
  }
  skip(n: number) {
    while (n > 0) {
      const have = this.buf.length - this.bufPos
      if (have >= n) {
        this.bufPos += n
        return
      }
      n -= have
      this.bufPos = this.buf.length
      this.need(Math.min(n, 1 << 20))
    }
  }
  str(): string {
    const len = Number(this.u64())
    if (len > 1 << 24) throw new Error('GGUF string too long')
    this.need(len)
    const s = this.buf.toString('utf8', this.bufPos, this.bufPos + len)
    this.bufPos += len
    return s
  }
  skipStr() {
    this.skip(Number(this.u64()))
  }
  scalar(type: number, keep: boolean): Value {
    switch (type) {
      case 0:
      case 1:
      case 7: {
        const v = this.u8()
        return type === 7 ? v !== 0 : type === 1 ? (v << 24) >> 24 : v
      }
      case 2:
      case 3:
        this.need(2)
        this.bufPos += 2
        return type === 2 ? this.buf.readUInt16LE(this.bufPos - 2) : this.buf.readInt16LE(this.bufPos - 2)
      case 4:
        return this.u32()
      case 5:
        this.need(4)
        this.bufPos += 4
        return this.buf.readInt32LE(this.bufPos - 4)
      case 6:
        this.need(4)
        this.bufPos += 4
        return this.buf.readFloatLE(this.bufPos - 4)
      case 8:
        if (!keep) {
          this.skipStr()
          return null
        }
        return this.str()
      case 10:
      case 11:
        return Number(this.u64())
      case 12:
        this.need(8)
        this.bufPos += 8
        return this.buf.readDoubleLE(this.bufPos - 8)
      default:
        throw new Error(`Unknown GGUF type ${type}`)
    }
  }
}

const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

function readValue(r: Reader, type: number, keep: boolean): Value {
  if (type !== 9) return r.scalar(type, keep)
  const inner = r.u32()
  const count = Number(r.u64())
  if (!keep) {
    if (inner in SIZES) r.skip(count * SIZES[inner])
    else for (let i = 0; i < count; i++) readValue(r, inner, false)
    return null
  }
  if (count > 4096) throw new Error('GGUF array too long')
  const out: Value[] = []
  for (let i = 0; i < count; i++) out.push(readValue(r, inner, true))
  return out
}

/** The metadata keys we care about; throws on files that aren't GGUF. */
export function readGgufMeta(file: string): Record<string, Value> {
  const fd = fs.openSync(file, 'r')
  try {
    // Metadata sits before the tensors; vocabularies make it a few MB, never hundreds.
    const r = new Reader(fd, 256 * 1024 * 1024)
    if (r.u32() !== 0x46554747) throw new Error('Not a GGUF file')
    const version = r.u32()
    if (version < 2) throw new Error(`GGUF v${version} is too old`)
    r.u64() // tensor count
    const kvCount = Number(r.u64())
    const out: Record<string, Value> = {}
    for (let i = 0; i < kvCount; i++) {
      const key = r.str()
      const type = r.u32()
      const keep = WANTED.test(key)
      const v = readValue(r, type, keep)
      if (keep) out[key] = v
    }
    return out
  } finally {
    fs.closeSync(fd)
  }
}

const num = (v: Value | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

/** Context length and f16 KV bytes per token from GGUF metadata. */
export function ggufInfoFromMeta(meta: Record<string, Value>): GgufInfo {
  const arch = typeof meta['general.architecture'] === 'string' ? (meta['general.architecture'] as string) : null
  if (!arch) return { arch: null, contextLength: null, kvPerToken: null }
  const k = (s: string) => meta[`${arch}.${s}`]
  const contextLength = num(k('context_length'))
  const layers = num(k('block_count'))
  const heads = k('attention.head_count')
  const headsN = Array.isArray(heads) ? num(heads.find((h) => num(h) !== null) as Value) : num(heads)
  const embd = num(k('embedding_length'))
  const headDim = embd && headsN ? embd / headsN : null
  const keyLen = num(k('attention.key_length')) ?? headDim
  const valLen = num(k('attention.value_length')) ?? headDim
  const kvHeads = k('attention.head_count_kv') ?? heads
  if (!layers || !keyLen || !valLen || kvHeads == null) return { arch, contextLength, kvPerToken: null }
  let headsTotal: number
  if (Array.isArray(kvHeads)) {
    // Per layer; recurrent layers in hybrid models have 0 KV heads.
    headsTotal = kvHeads.slice(0, layers).reduce<number>((n, h) => n + (num(h) ?? 0), 0)
  } else {
    const per = num(kvHeads)
    if (!per) return { arch, contextLength, kvPerToken: null }
    // Hybrid models that interleave: one attention layer every N.
    const every = num(k('full_attention_interval'))
    headsTotal = per * (every ? Math.ceil(layers / every) : layers)
  }
  if (!headsTotal) return { arch, contextLength, kvPerToken: null }
  return { arch, contextLength, kvPerToken: Math.round(headsTotal * (keyLen + valLen) * 2) }
}

const cache = new Map<string, { key: string; info: GgufInfo | null }>()

/** `ggufInfoFromMeta(readGgufMeta(file))`, cached per file size and mtime; null when unreadable. */
export function ggufInfo(file: string): GgufInfo | null {
  let key: string
  try {
    const st = fs.statSync(file)
    key = `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
  const hit = cache.get(file)
  if (hit?.key === key) return hit.info
  let info: GgufInfo | null = null
  try {
    info = ggufInfoFromMeta(readGgufMeta(file))
  } catch {
    info = null
  }
  cache.set(file, { key, info })
  return info
}
