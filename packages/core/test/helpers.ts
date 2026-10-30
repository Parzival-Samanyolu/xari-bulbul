import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Provider, StreamEvent, ChatRequest } from '../src/providers/types.js'
import type { ModelInfo } from '../src/types.js'
import type { ToolContext } from '../src/tools/types.js'

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'))
}

export function ctx(cwd: string, over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    readFiles: new Set(),
    toolOutputMaxChars: 30_000,
    bashTimeoutSec: 20,
    shell: '',
    setTodos: () => {},
    progress: () => {},
    ...over,
  }
}

/** Replays a scripted list of responses, one per chat() call, and records the requests. */
export class MockProvider implements Provider {
  readonly id: string
  readonly name: string
  requests: ChatRequest[] = []
  private readonly contextLength: number
  private readonly modelName: string
  /**
   * Each entry is one reply; an `{ events, fail }` entry streams events and then throws. `id` and
   * `contextLength` let a test register several providers (fallbacks, mixture models); each lists one model, `m`.
   */
  constructor(
    private script: (StreamEvent[] | { events: StreamEvent[]; fail: Error })[],
    opts: { id?: string; contextLength?: number; modelName?: string } = {},
  ) {
    this.id = opts.id ?? 'mock'
    this.name = opts.id ? opts.id[0].toUpperCase() + opts.id.slice(1) : 'Mock'
    this.contextLength = opts.contextLength ?? 100_000
    this.modelName = opts.modelName ?? 'M'
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'm', name: this.modelName, providerId: this.id, contextLength: this.contextLength, pricing: { prompt: 1e-6, completion: 2e-6 }, free: false, supportsTools: true }]
  }
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }))
    const next = this.script.shift()
    if (!next) throw new Error('MockProvider: script exhausted')
    if (Array.isArray(next)) {
      for (const ev of next) yield ev
      return
    }
    for (const ev of next.events) yield ev
    throw next.fail
  }
}

export function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
