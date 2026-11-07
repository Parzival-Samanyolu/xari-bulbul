// Will a model run on this computer? Pure arithmetic over the file size, the context and the
// machine's memory, so the UI can label models before anything is downloaded.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

export interface MachineInfo {
  platform: NodeJS.Platform
  arch: string
  /** Total RAM in bytes. */
  ram: number
  /** Apple Silicon: the GPU shares RAM, so there's one pool. */
  unified: boolean
  /** A discrete GPU llama.cpp can use (largest one), or null when none was found. */
  gpu: { name: string; vram: number } | null
}

export type Fit = 'fits' | 'tight' | 'too-big'

const GiB = 1024 ** 3
const KiB = 1024

/** The context sizes picked automatically, largest first. */
export const CONTEXT_STEPS = [32_768, 16_384, 8_192, 4_096] as const

/** The context sizes offered in the picker, largest first (capped at the model's own limit). */
export const CONTEXT_CHOICES = [131_072, 65_536, 32_768, 16_384, 8_192, 4_096] as const

/** Below this an agent can't work: the system prompt and tools alone take a few thousand tokens. */
export const MIN_USEFUL_CONTEXT = 8_192

/**
 * llama-server runs with a q8_0 KV cache (with flash attention): 34 bytes per 32 values instead
 * of 64 at f16, with no quality loss worth measuring. `kvPerToken` values are f16 bytes.
 */
export const KV_CACHE_FACTOR = 34 / 64

/**
 * KV cache bytes per token when the model doesn't say. Bigger models have more layers and
 * heads, so scale with the file: about 32 KiB per GB of weights (an 8B Q4 ≈ 150 KiB).
 */
export function defaultKvPerToken(fileBytes: number): number {
  return Math.round(Math.min(320 * KiB, Math.max(16 * KiB, (fileBytes / 1e9) * 32 * KiB)))
}

/** Bytes needed to run: weights (and the image projector) + KV cache + compute buffers and runtime. */
export function memoryNeeded(m: { size: number; ctx: number; kvPerToken?: number }): number {
  const kv = (m.kvPerToken ?? defaultKvPerToken(m.size)) * KV_CACHE_FACTOR * m.ctx
  const overhead = 400 * 1024 ** 2 + m.size * 0.05
  return Math.round(m.size + kv + overhead)
}

/**
 * How much memory a model may use. `fast`: it runs fully on the GPU (or, without one, in RAM with
 * room left for the OS and apps). `total`: the most it can use at all, partly offloaded or swapping
 * little, which works but is slow or squeezes other apps.
 */
export function memoryBudget(m: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>): { fast: number; total: number } {
  // macOS lets the GPU use about two thirds of RAM on smaller Macs, three quarters on 32 GB+.
  if (m.unified) return { fast: m.ram * (m.ram >= 32 * GiB ? 0.75 : 0.67), total: m.ram * 0.8 }
  if (m.gpu && m.gpu.vram > 0) return { fast: m.gpu.vram * 0.9, total: m.gpu.vram * 0.9 + m.ram * 0.5 }
  return { fast: m.ram * 0.6, total: m.ram * 0.75 }
}

export function fitFor(needed: number, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>): Fit {
  const b = memoryBudget(machine)
  return needed <= b.fast ? 'fits' : needed <= b.total ? 'tight' : 'too-big'
}

export interface FitInput {
  /** Bytes on disk: the model plus its image projector. */
  size: number
  /** Most context the model supports; null/0 = unknown (treated as 32K). */
  maxContext?: number | null
  kvPerToken?: number
}

/**
 * The largest automatic context (up to the model's own limit) that fits. When none of the useful
 * ones (8K+) fits, 8K anyway if it runs at all: a 4K agent can't hold its own instructions. 4K only
 * when the model is too big even for 8K.
 */
export function pickContext(model: FitInput, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>): number {
  const max = model.maxContext || CONTEXT_STEPS[0]
  const steps = CONTEXT_STEPS.filter((c) => c <= max)
  if (!steps.length) return max
  const fit = (ctx: number) => fitFor(memoryNeeded({ size: model.size, ctx, kvPerToken: model.kvPerToken }), machine)
  const useful = steps.filter((c) => c >= Math.min(MIN_USEFUL_CONTEXT, max))
  for (const ctx of useful) if (fit(ctx) === 'fits') return ctx
  const least = useful[useful.length - 1]
  if (least && fit(least) === 'tight') return least
  for (const ctx of steps) if (fit(ctx) === 'fits') return ctx
  return steps[steps.length - 1]
}

/** Fit at the context we'd run the model with: `ctx` when the user chose one, else the automatic pick. */
export function modelFit(model: FitInput, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>, chosen?: number | null): { fit: Fit; ctx: number; needed: number } {
  const limit = model.maxContext || CONTEXT_CHOICES[0]
  const ctx = chosen && chosen > 0 ? Math.min(chosen, limit) : pickContext(model, machine)
  const needed = memoryNeeded({ size: model.size, ctx, kvPerToken: model.kvPerToken })
  return { fit: fitFor(needed, machine), ctx, needed }
}

/** Every context the picker offers for a model, with how each fits. */
export function contextChoices(model: FitInput, machine: Pick<MachineInfo, 'ram' | 'unified' | 'gpu'>): { ctx: number; fit: Fit }[] {
  const limit = model.maxContext || CONTEXT_STEPS[0]
  const list = CONTEXT_CHOICES.filter((c) => c <= limit)
  const all = list.length ? list : [limit]
  return all.map((ctx) => ({ ctx, fit: fitFor(memoryNeeded({ size: model.size, ctx, kvPerToken: model.kvPerToken }), machine) }))
}

// ---------------------------------------------------------------------------------------------
// Detecting the machine

type Exec = (file: string, args: string[]) => Promise<string>

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => execFile(file, args, { timeout: 4000, windowsHide: true, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out))))

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` → the largest GPU. */
export function parseNvidiaSmi(out: string): { name: string; vram: number } | null {
  let best: { name: string; vram: number } | null = null
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?),\s*(\d+)\s*$/.exec(line.trim())
    if (!m) continue
    const vram = Number(m[2]) * 1024 ** 2
    if (!best || vram > best.vram) best = { name: m[1].trim(), vram }
  }
  return best
}

/** AMD cards on Linux report VRAM in sysfs. */
function amdVram(): { name: string; vram: number } | null {
  let best: { name: string; vram: number } | null = null
  try {
    for (const card of fs.readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(card)) continue
      try {
        const vram = Number(fs.readFileSync(`/sys/class/drm/${card}/device/mem_info_vram_total`, 'utf8').trim())
        // Integrated GPUs report a small carve-out; ignore anything under 1 GiB.
        if (vram >= GiB && (!best || vram > best.vram)) best = { name: 'AMD GPU', vram }
      } catch {
        /* not an AMD card */
      }
    }
  } catch {
    /* no sysfs */
  }
  return best
}

export async function detectMachine(opts: { platform?: NodeJS.Platform; arch?: string; ram?: number; exec?: Exec } = {}): Promise<MachineInfo> {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const ram = opts.ram ?? os.totalmem()
  const unified = platform === 'darwin' && arch === 'arm64'
  let gpu: MachineInfo['gpu'] = null
  // Intel Macs: the pinned build runs on the CPU, so a GPU there doesn't change the fit.
  if (platform !== 'darwin') {
    try {
      gpu = parseNvidiaSmi(await (opts.exec ?? defaultExec)('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']))
    } catch {
      /* no NVIDIA driver */
    }
    if (!gpu && platform === 'linux') gpu = amdVram()
  }
  return { platform, arch, ram, unified, gpu }
}
