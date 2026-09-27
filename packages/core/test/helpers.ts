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
  readonly id = 'mock'
  readonly name = 'Mock'
  requests: ChatRequest[] = []
  /** Each entry is one reply; an `{ events, fail }` entry streams events and then throws. */
  constructor(private script: (StreamEvent[] | { events: StreamEvent[]; fail: Error })[]) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'm', name: 'M', providerId: 'mock', contextLength: 100_000, pricing: { prompt: 1e-6, completion: 2e-6 }, free: false, supportsTools: true }]
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
