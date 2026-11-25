import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionStore, parseSettings } from '@harness/core'
import { createHost } from '../src/host.js'
import { run, type CliIO } from '../src/main.js'

// A tiny OpenAI-compatible server: every chat completion streams the same reply.
let server: http.Server
let baseUrl = ''
const bodies: any[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        return void res.end(JSON.stringify({ data: [{ id: 'mock-1' }] }))
      }
      bodies.push(JSON.parse(raw || '{}'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const c of [
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'from mock' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        '[DONE]',
      ])
        res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})
afterAll(() => void server.close())

/** A data dir whose settings point at the mock server, and a work folder. */
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xari-cli-data-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xari-cli-cwd-')).normalize('NFC')
  const settings = parseSettings({
    providers: [{ id: 'mock', name: 'Mock', baseUrl, requiresKey: false }],
    models: { default: { providerId: 'mock', modelId: 'mock-1' } },
    memory: { enabled: false },
    mcp: { servers: [] },
  })
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings))
  return { dataDir, cwd }
}

function io(dataDir: string, cwd: string, stdin?: string): CliIO & { out: string; err: string } {
  const o = {
    out: '',
    err: '',
    stdin: { isTTY: stdin === undefined, read: async () => stdin ?? '' },
    stdout: (s: string) => void (o.out += s),
    stderr: (s: string) => void (o.err += s),
    env: { HARNESS_DATA_DIR: dataDir, PATH: process.env.PATH, XARI_LANG: 'en' },
    cwd,
  }
  return o
}

describe('run -p', () => {
  it('prints the answer and saves the chat where the desktop looks', async () => {
    const { dataDir, cwd } = setup()
    const t = io(dataDir, cwd)
    const code = await run(['-p', 'say hi'], t)
    expect(code).toBe(0)
    expect(t.out).toBe('Hello from mock\n')

    const metas = new SessionStore(path.join(dataDir, 'sessions')).list({ cwd })
    expect(metas).toHaveLength(1)
    const saved = new SessionStore(path.join(dataDir, 'sessions')).load(metas[0].id)!
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(saved.messages[0].content).toContain('say hi')
    expect(saved.meta.model).toEqual({ providerId: 'mock', modelId: 'mock-1' })
    expect(fs.readFileSync(path.join(dataDir, 'usage.jsonl'), 'utf8')).toContain('"mock"')
  })

  it('--output-format json prints one result object', async () => {
    const { dataDir, cwd } = setup()
    const t = io(dataDir, cwd)
    expect(await run(['-p', 'say hi', '--output-format', 'json'], t)).toBe(0)
    const lines = t.out.trim().split('\n')
    expect(lines).toHaveLength(1)
    const r = JSON.parse(lines[0])
    expect(r).toMatchObject({ type: 'result', is_error: false, reason: 'done', exit_code: 0, result: 'Hello from mock', model: 'mock:mock-1' })
    expect(r.usage.prompt_tokens).toBe(12)
    expect(typeof r.session_id).toBe('string')
  })

  it('--output-format stream-json prints events then the result', async () => {
    const { dataDir, cwd } = setup()
    const t = io(dataDir, cwd)
    expect(await run(['-p', 'hi', '--output-format', 'stream-json'], t)).toBe(0)
    const types = t.out.trim().split('\n').map((l) => JSON.parse(l).type)
    expect(types).toContain('text')
    expect(types.at(-1)).toBe('result')
  })

  it('combines the prompt with piped stdin', async () => {
    const { dataDir, cwd } = setup()
    bodies.length = 0
    const t = io(dataDir, cwd, 'FILE CONTENTS\n')
    expect(await run(['-p', 'explain'], t)).toBe(0)
    const sent = JSON.stringify(bodies[0].messages)
    expect(sent).toContain('explain')
    expect(sent).toContain('FILE CONTENTS')
  })

  it('continues the latest chat with -c', async () => {
    const { dataDir, cwd } = setup()
    await run(['-p', 'first'], io(dataDir, cwd))
    const t = io(dataDir, cwd)
    expect(await run(['-p', 'second', '-c', '--output-format', 'json'], t)).toBe(0)
    const store = new SessionStore(path.join(dataDir, 'sessions'))
    expect(store.list({ cwd })).toHaveLength(1)
    expect(store.load(store.list({ cwd })[0].id)!.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('--model picks the provider and model', async () => {
    const { dataDir, cwd } = setup()
    bodies.length = 0
    expect(await run(['-p', 'hi', '--model', 'mock/other-model'], io(dataDir, cwd))).toBe(0)
    expect(bodies[0].model).toBe('other-model')
  })

  it('exits 2 for usage errors', async () => {
    const { dataDir, cwd } = setup()
    const a = io(dataDir, cwd)
    expect(await run(['--nope'], a)).toBe(2)
    expect(a.err).toMatch(/unknown option/)
    const b = io(dataDir, cwd, '')
    expect(await run(['-p'], b)).toBe(2)
    expect(b.err).toMatch(/needs a prompt/)
    const c = io(dataDir, cwd, '')
    expect(await run(['hello'], c)).toBe(2)
    expect(await run(['--cwd', '/definitely/not/here', '-p', 'x'], io(dataDir, cwd))).toBe(2)
  })

  it('exits 130 when aborted', async () => {
    const { dataDir, cwd } = setup()
    const t = { ...io(dataDir, cwd), signal: AbortSignal.abort(new Error('Interrupted by user')) }
    expect(await run(['-p', 'hi'], t)).toBe(130)
  })

  it('prints --version and --help', async () => {
    const { dataDir, cwd } = setup()
    const v = io(dataDir, cwd)
    expect(await run(['--version'], v)).toBe(0)
    expect(v.out).toMatch(/^\d+\.\d+\.\d+/)
    const h = io(dataDir, cwd)
    expect(await run(['--help'], h)).toBe(0)
    expect(h.out).toMatch(/Usage:/)
  })
})

describe('createHost', () => {
  it('shares the data folder, resolves models and lists commands', async () => {
    const { dataDir, cwd } = setup()
    fs.mkdirSync(path.join(cwd, '.harness', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.harness', 'commands', 'greet.md'), '---\ndescription: Say hello\n---\nGreet $ARGUMENTS warmly')
    const host = await createHost({ cwd, env: { HARNESS_DATA_DIR: dataDir, PATH: process.env.PATH, XARI_LANG: 'en' }, noMcp: true })
    try {
      expect(host.dataDir).toBe(dataDir)
      expect(host.resolveModel('mock/foo/bar')).toEqual({ providerId: 'mock', modelId: 'foo/bar' })
      expect(host.resolveModel('mock:qwen3:8b')).toEqual({ providerId: 'mock', modelId: 'qwen3:8b' })
      expect(host.resolveModel('mock-1')).toEqual({ providerId: 'mock', modelId: 'mock-1' })
      expect(host.slashCommands().map((c) => c.name)).toEqual(expect.arrayContaining(['compact', 'clear', 'model', 'mode', 'greet']))
      expect(host.expandPrompt('/greet Ada')).toContain('Greet Ada warmly')
      expect(host.expandPrompt('plain text')).toBe('plain text')
      expect((await host.models('mock')).map((m) => m.id)).toEqual(['mock-1'])
      expect(host.keyHint('mock')).toBeUndefined()
      expect(host.keyHint('openrouter')).toMatch(/OPENROUTER_API_KEY/)

      const s = host.newSession()
      expect(s.meta.cwd).toBe(cwd)
      expect(host.listSessions()).toHaveLength(0)
    } finally {
      await host.dispose()
    }
  })
})
