// Running a local model: one `llama-server` at a time on 127.0.0.1, exposed to the agent as the
// keyless OpenAI-compatible provider "Local (llama.cpp)". The provider starts the server on demand
// (or switches its model), so chats, subagents and schedules need nothing special.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { OpenAICompatProvider } from '../providers/openai-compat.js'
import type { ChatRequest, Provider, StreamEvent } from '../providers/types.js'
import { ProviderConfigSchema, type ProviderConfig } from '../settings/schema.js'
import type { ModelInfo } from '../types.js'

export const LOCAL_PROVIDER_ID = 'llama-local'
export const LOCAL_PROVIDER_NAME = 'Local (llama.cpp)'

export interface ServerSpec {
  bin: string
  /** Model id: what the provider lists and the server answers to. */
  modelId: string
  model: string
  mmproj?: string | null
  ctx: number
}

/** Arguments for llama-server. `--jinja` uses the model's chat template, which is what makes tool calls work. */
export function llamaServerArgs(spec: Omit<ServerSpec, 'bin'> & { port: number }): string[] {
  const args = ['-m', spec.model, '--host', '127.0.0.1', '--port', String(spec.port), '--ctx-size', String(spec.ctx), '--jinja', '--alias', spec.modelId, '--no-webui', '--parallel', '1']
  if (spec.mmproj) args.push('--mmproj', spec.mmproj)
  return args
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** The "Local (llama.cpp)" provider entry, added or pointed at `port`. Keyless, local only. */
export function upsertLocalProvider(providers: ProviderConfig[], port?: number): ProviderConfig[] {
  const current = providers.find((p) => p.id === LOCAL_PROVIDER_ID)
  const baseUrl = port ? `http://127.0.0.1:${port}/v1` : (current?.baseUrl ?? 'http://127.0.0.1:8080/v1')
  const next = ProviderConfigSchema.parse({ ...current, id: LOCAL_PROVIDER_ID, name: LOCAL_PROVIDER_NAME, baseUrl, requiresKey: false, api: 'openai', enabled: current?.enabled ?? true })
  return current ? providers.map((p) => (p.id === LOCAL_PROVIDER_ID ? next : p)) : [...providers, next]
}

export type ServerState =
  | { state: 'stopped' }
  | { state: 'starting'; modelId: string; port: number; ctx: number }
  | { state: 'ready'; modelId: string; port: number; ctx: number }
  | { state: 'error'; modelId: string; message: string }

type Spawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean }) => ChildProcess

export interface LlamaServerOptions {
  spawn?: Spawn
  fetch?: typeof fetch
  port?: () => Promise<number>
  onChange?: (s: ServerState) => void
  /** Longest wait for the model to load. Metal start-up alone took 1–3 minutes on an 8 GB M1 (Oct 2026). */
  timeoutMs?: number
  pollMs?: number
}

/** One llama-server process: start (stopping any other), wait until `/health` says it's loaded, stop. */
export class LlamaServer {
  private proc: ChildProcess | null = null
  private starting: Promise<string> | null = null
  private spec: ServerSpec | null = null
  private _state: ServerState = { state: 'stopped' }
  private tail: string[] = []
  /**
   * Required on every request except /health (passed as LLAMA_API_KEY, so it isn't in the process
   * list). llama-server allows any web origin, so without it any page open in a browser could use it.
   */
  readonly apiKey = crypto.randomBytes(24).toString('hex')

  constructor(private readonly opts: LlamaServerOptions = {}) {}

  get state(): ServerState {
    return this._state
  }

  private set(s: ServerState) {
    this._state = s
    this.opts.onChange?.(s)
  }

  baseUrl(): string | null {
    return this._state.state === 'ready' ? `http://127.0.0.1:${this._state.port}/v1` : null
  }

  isReady(modelId: string): boolean {
    return this._state.state === 'ready' && this._state.modelId === modelId
  }

  /** The base URL of a server running `spec`, starting or switching it first when needed. */
  ensure(spec: ServerSpec): Promise<string> {
    const same = this.spec && this.spec.modelId === spec.modelId && this.spec.model === spec.model && this.spec.ctx === spec.ctx && this.spec.bin === spec.bin
    if (same && this.starting) return this.starting
    if (same && this.baseUrl()) return Promise.resolve(this.baseUrl()!)
    this.spec = spec
    const p = this.start(spec)
    this.starting = p
    const clear = () => {
      if (this.starting === p) this.starting = null
    }
    p.then(clear, clear)
    return p
  }

  private async start(spec: ServerSpec): Promise<string> {
    await this.kill()
    const port = await (this.opts.port ?? freePort)()
    const args = llamaServerArgs({ ...spec, port })
    const dir = path.dirname(spec.bin)
    // The Linux build's shared libraries sit next to the binary.
    const env: NodeJS.ProcessEnv = { ...process.env, LLAMA_API_KEY: this.apiKey }
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    this.tail = []
    this.set({ state: 'starting', modelId: spec.modelId, port, ctx: spec.ctx })
    const proc = (this.opts.spawn ?? (nodeSpawn as unknown as Spawn))(spec.bin, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    const keep = (b: Buffer) => {
      for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) this.tail.push(line.trim())
      if (this.tail.length > 40) this.tail.splice(0, this.tail.length - 40)
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    let exited: string | null = null
    const onExit = (code: number | null, signal: string | null) => {
      exited = `llama-server stopped (${signal ?? `exit code ${code}`})`
      if (this.proc === proc) {
        this.proc = null
        if (this._state.state !== 'stopped') this.set({ state: 'error', modelId: spec.modelId, message: this.failure(exited) })
      }
    }
    proc.on('exit', onExit)
    proc.on('error', (e) => onExit(null, e.message))

    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + (this.opts.timeoutMs ?? 600_000)
    const f = this.opts.fetch ?? fetch
    while (Date.now() < deadline) {
      if (exited || this.proc !== proc) throw new Error(this.proc === proc || exited ? this.failure(exited ?? 'llama-server stopped') : this.spec ? 'The local model was switched.' : 'The local model was stopped.')
      try {
        // 503 while the model loads, 200 once it's ready.
        const res = await f(`${url}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          this.set({ state: 'ready', modelId: spec.modelId, port, ctx: spec.ctx })
          return `${url}/v1`
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 500))
    }
    await this.kill()
    this.spec = null
    const message = `The local model didn't finish loading in ${Math.round((this.opts.timeoutMs ?? 600_000) / 1000)} s.`
    this.set({ state: 'error', modelId: spec.modelId, message })
    throw new Error(message)
  }

  private failure(what: string): string {
    const last = this.tail.filter((l) => /error|fail|out of memory|unable|cannot|invalid/i.test(l)).slice(-3)
    return `${what}${last.length ? `: ${last.join(' · ')}` : '.'}`
  }

  /** Stops the server (SIGTERM, then SIGKILL after 3 s). */
  async stop(): Promise<void> {
    this.spec = null
    this.starting = null
    if (this._state.state !== 'stopped') this.set({ state: 'stopped' })
    await this.kill()
  }

  private async kill(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* gone */
        }
        resolve()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        proc.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /** Synchronous kill for app exit. */
  killNow(): void {
    try {
      this.proc?.kill('SIGKILL')
    } catch {
      /* gone */
    }
    this.proc = null
  }
}

export interface LocalProviderOptions {
  config: ProviderConfig
  /** The installed local models, as the model picker lists them. */
  models: () => ModelInfo[]
  /** Starts or switches the server to `modelId`; resolves to its base URL. */
  ensure: (modelId: string) => Promise<string>
  isReady: (modelId: string) => boolean
  /** The server's API key. */
  apiKey: string
  retries?: number
  fetch?: typeof fetch
}

/** The agent's view of the local server: lists installed models, loads the requested one before each request. */
export class LocalLlamaProvider implements Provider {
  readonly id = LOCAL_PROVIDER_ID
  readonly name = LOCAL_PROVIDER_NAME
  private inner: { url: string; provider: OpenAICompatProvider } | null = null

  constructor(private readonly opts: LocalProviderOptions) {}

  async listModels(): Promise<ModelInfo[]> {
    return this.opts.models()
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const known = this.opts.models().find((m) => m.id === req.model)
    if (!known) throw new Error(`${req.model} isn't downloaded. Download it in Settings › Providers › Local models.`)
    if (!this.opts.isReady(req.model)) yield { type: 'status', text: `Loading ${known.name} on this computer. This can take a few minutes.` }
    const url = await this.opts.ensure(req.model)
    if (this.inner?.url !== url) this.inner = { url, provider: new OpenAICompatProvider({ config: { ...this.opts.config, baseUrl: url }, apiKey: this.opts.apiKey, retries: this.opts.retries, fetch: this.opts.fetch }) }
    yield* this.inner.provider.chat(req)
  }
}
