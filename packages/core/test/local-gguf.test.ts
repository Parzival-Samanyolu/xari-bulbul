import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalLlamaProvider, contextChoices, ggufInfo, ggufInfoFromMeta, modelFit, pickContext, readGgufMeta, type MachineInfo } from '../src/local/index.js'
import { ProviderConfigSchema } from '../src/index.js'

const GiB = 1024 ** 3
const mac8: MachineInfo = { platform: 'darwin', arch: 'arm64', ram: 8 * GiB, unified: true, gpu: null }

type V = { t: 'u32'; v: number } | { t: 'str'; v: string } | { t: 'arr32'; v: number[] } | { t: 'arrstr'; v: string[] } | { t: 'f32'; v: number }

/** A minimal GGUF v3 file: header plus metadata, no tensors. */
function gguf(kv: Record<string, V>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const u64 = (n: number) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(n))
    return b
  }
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length))
  for (const [k, val] of Object.entries(kv)) {
    parts.push(str(k))
    if (val.t === 'u32') parts.push(u32(4), u32(val.v))
    else if (val.t === 'f32') {
      const b = Buffer.alloc(4)
      b.writeFloatLE(val.v)
      parts.push(u32(6), b)
    } else if (val.t === 'str') parts.push(u32(8), str(val.v))
    else if (val.t === 'arr32') parts.push(u32(9), u32(5), u64(val.v.length), ...val.v.map(u32))
    else parts.push(u32(9), u32(8), u64(val.v.length), ...val.v.map(str))
  }
  return Buffer.concat(parts)
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-gguf-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('GGUF metadata', () => {
  it('reads context and KV size of a grouped-query model, skipping the vocabulary', () => {
    const file = path.join(dir, 'llama.gguf')
    fs.writeFileSync(
      file,
      gguf({
        'general.architecture': { t: 'str', v: 'llama' },
        'tokenizer.ggml.tokens': { t: 'arrstr', v: Array.from({ length: 5000 }, (_, i) => `tok${i}`) },
        'llama.context_length': { t: 'u32', v: 131072 },
        'llama.block_count': { t: 'u32', v: 32 },
        'llama.embedding_length': { t: 'u32', v: 4096 },
        'llama.attention.head_count': { t: 'u32', v: 32 },
        'llama.attention.head_count_kv': { t: 'u32', v: 8 },
        'llama.rope.freq_base': { t: 'f32', v: 500000 },
      }),
    )
    expect(readGgufMeta(file)['tokenizer.ggml.tokens']).toBeUndefined()
    // Llama 3 8B: 32 layers × 8 KV heads × (128 + 128) × 2 bytes = 128 KiB per token.
    expect(ggufInfo(file)).toEqual({ arch: 'llama', contextLength: 131072, kvPerToken: 128 * 1024 })
  })

  it('counts only attention layers in hybrid models', () => {
    // Per-layer KV heads, zero on recurrent layers.
    expect(
      ggufInfoFromMeta({ 'general.architecture': 'x', 'x.block_count': 4, 'x.attention.head_count': 8, 'x.attention.head_count_kv': [0, 0, 0, 2], 'x.attention.key_length': 64, 'x.attention.value_length': 64 }).kvPerToken,
    ).toBe(2 * 128 * 2)
    // One full-attention layer every 4.
    expect(ggufInfoFromMeta({ 'general.architecture': 'q', 'q.block_count': 32, 'q.attention.head_count': 16, 'q.attention.head_count_kv': 4, 'q.attention.key_length': 256, 'q.attention.value_length': 256, 'q.full_attention_interval': 4 }).kvPerToken).toBe(8 * 4 * 512 * 2)
  })

  it('returns null for files that are not GGUF', () => {
    const file = path.join(dir, 'x.gguf')
    fs.writeFileSync(file, 'not a model')
    expect(ggufInfo(file)).toBeNull()
  })
})

describe('context choice', () => {
  it('runs 8K tight rather than 4K when nothing larger fits', () => {
    // ~5 GB 8B model with an f16 KV of 128 KiB/token on an 8 GB Mac.
    const m = { size: 5.2e9, kvPerToken: 128 * 1024, maxContext: 131072 }
    expect(pickContext(m, mac8)).toBe(8192)
    expect(modelFit(m, mac8).fit).toBe('tight')
  })

  it('uses the chosen context, capped at the model limit, and lists choices up to it', () => {
    const m = { size: 3e9, kvPerToken: 24 * 1024, maxContext: 65536 }
    expect(modelFit(m, mac8, 16384).ctx).toBe(16384)
    expect(modelFit(m, mac8, 131072).ctx).toBe(65536)
    expect(contextChoices(m, mac8).map((c) => c.ctx)).toEqual([65536, 32768, 16384, 8192, 4096])
  })
})

describe('local provider', () => {
  it('holds the server while a request runs and releases it after, even on error', async () => {
    let held = 0
    const provider = new LocalLlamaProvider({
      config: ProviderConfigSchema.parse({ id: 'llama-local', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1', requiresKey: false }),
      models: () => [{ id: 'm', name: 'M', providerId: 'llama-local', free: true, supportsTools: true }],
      ensure: async () => {
        expect(held).toBe(1)
        throw new Error('no server')
      },
      isReady: () => true,
      apiKey: 'k',
      hold: () => {
        held++
        return () => held--
      },
    })
    await expect(async () => {
      for await (const _ of provider.chat({ model: 'm', messages: [], tools: [] } as never)) void _
    }).rejects.toThrow('no server')
    expect(held).toBe(0)
  })
})
