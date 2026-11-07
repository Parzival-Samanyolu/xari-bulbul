// Resource monitor: memory and CPU of the app's own processes (Electron's metrics) and of the
// programs it started (MCP servers, terminals, llama-server, commands the agent runs), plus
// system memory and the GPU's name. Sampled only when the renderer asks, which it does only
// while a readout is on screen.

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { ProcessUsage, ResourceSample } from '../shared/ipc'
import type { MessageKey } from '../shared/i18n/catalog'
import { tm } from './i18n'

/** Processes the app started on purpose, by pid, with a readable name. */
export interface KnownChild {
  pid: number
  label: string
  kind: ProcessUsage['kind']
}

const TYPE_LABELS: Record<string, MessageKey> = {
  Browser: 'main.process.mainProcess',
  Tab: 'main.process.window',
  GPU: 'main.process.gpu',
  Utility: 'main.process.utility',
  Zygote: 'main.process.zygote',
  'Sandbox helper': 'main.process.sandbox',
  'Pepper Plugin': 'main.process.plugin',
  'Pepper Plugin Broker': 'main.process.pluginBroker',
  Unknown: 'main.process.other',
}

const UTILITY_NAMES: Record<string, MessageKey> = {
  'network.mojom.NetworkService': 'main.process.network',
  'storage.mojom.StorageService': 'main.process.storage',
  'audio.mojom.AudioService': 'main.process.audio',
  'video_capture.mojom.VideoCaptureService': 'main.process.video',
  'data_decoder.mojom.DataDecoderService': 'main.process.dataDecoder',
}

interface PsRow {
  pid: number
  ppid: number
  rss: number
  cpu: number
  comm: string
}

/** Every process on the system (pid, parent, memory, CPU, command) via `ps`. Not on Windows. */
function ps(): Promise<PsRow[] | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu=,comm='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null)
      const rows: PsRow[] = []
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
        if (m) rows.push({ pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, cpu: parseFloat(m[4]) || 0, comm: m[5].trim() })
      }
      resolve(rows)
    })
  })
}

let gpuName: string | null | undefined

/** The GPU's name, looked up once. Electron doesn't report GPU memory, so nothing else is shown. */
async function gpu(): Promise<string | null> {
  if (gpuName !== undefined) return gpuName
  try {
    const info = (await app.getGPUInfo('complete')) as { gpuDevice?: { active?: boolean; deviceString?: string; vendorString?: string }[]; auxAttributes?: { glRenderer?: string } }
    const dev = info.gpuDevice?.find((d) => d.active) ?? info.gpuDevice?.[0]
    const renderer = info.auxAttributes?.glRenderer?.replace(/^ANGLE \((.*)\)$/, '$1')
    gpuName = dev?.deviceString || renderer || null
  } catch {
    gpuName = null
  }
  return gpuName
}

const childLabel = (comm: string) => {
  const name = path.basename(comm)
  if (/llama-server/i.test(name)) return tm('main.process.llama')
  if (/whisper/i.test(name)) return tm('main.process.whisper')
  return name || tm('main.process.process')
}

/** One sample. `known` names the processes the app started on purpose. */
export async function sampleResources(known: KnownChild[]): Promise<ResourceSample> {
  const metrics = app.getAppMetrics()
  const rows = await ps()
  const own = new Set(metrics.map((m) => m.pid))
  const processes: ProcessUsage[] = metrics.map((m) => {
    const serviceKey = m.serviceName ? UTILITY_NAMES[m.serviceName] : undefined
    const service = serviceKey && tm(serviceKey)
    const typeKey = TYPE_LABELS[m.type]
    return {
      pid: m.pid,
      kind: 'app',
      type: m.type,
      label: service ?? (m.type === 'Utility' && m.name ? m.name : (typeKey ? tm(typeKey) : m.type)),
      cpu: m.cpu.percentCPUUsage,
      // workingSetSize is in kilobytes.
      memory: m.memory.workingSetSize * 1024,
    }
  })

  let childrenMeasured = false
  if (rows) {
    childrenMeasured = true
    // Programs the main process started (not Electron's own helpers), each with everything under it.
    const kids = new Map<number, PsRow[]>()
    for (const r of rows) {
      const list = kids.get(r.ppid)
      if (list) list.push(r)
      else kids.set(r.ppid, [r])
    }
    const tree = (pid: number): PsRow[] => (kids.get(pid) ?? []).flatMap((r) => [r, ...tree(r.pid)])
    const byPid = new Map(known.map((k) => [k.pid, k]))
    const roots = (kids.get(process.pid) ?? []).filter((r) => !own.has(r.pid))
    // A known process started through a wrapper (npx, uvx, node-pty's helper) sits deeper: name it by the wrapper.
    for (const root of roots) {
      const all = [root, ...tree(root.pid)]
      const k = all.map((r) => byPid.get(r.pid)).find(Boolean)
      processes.push({
        pid: root.pid,
        kind: k?.kind ?? 'child',
        type: 'Child',
        label: k?.label ?? childLabel(root.comm),
        cpu: all.reduce((n, r) => n + r.cpu, 0),
        memory: all.reduce((n, r) => n + r.rss, 0),
        ...(all.length > 1 ? { count: all.length } : {}),
      })
    }
  } else {
    // Windows: names only; their memory isn't measured.
    for (const k of known) processes.push({ pid: k.pid, kind: k.kind, type: 'Child', label: k.label, cpu: null, memory: null })
  }

  const sum = (kind: (p: ProcessUsage) => boolean, f: (p: ProcessUsage) => number | null) => processes.filter(kind).reduce((n, p) => n + (f(p) ?? 0), 0)
  const isApp = (p: ProcessUsage) => p.kind === 'app'
  const sys = process.getSystemMemoryInfo()
  return {
    at: Date.now(),
    processes,
    app: { memory: sum(isApp, (p) => p.memory), cpu: sum(isApp, (p) => p.cpu) },
    children: { memory: sum((p) => !isApp(p), (p) => p.memory), cpu: sum((p) => !isApp(p), (p) => p.cpu), measured: childrenMeasured },
    // getSystemMemoryInfo is in kilobytes.
    system: { total: sys.total * 1024, free: sys.free * 1024, cpus: os.availableParallelism?.() ?? os.cpus().length },
    gpu: { name: await gpu() },
  }
}
