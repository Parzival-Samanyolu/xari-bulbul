import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSecrets, KeyStore } from '@harness/core'
import { runCli, type Io } from '../src/cli.js'

// A minimal OpenAI-compatible server: one tool call (`run`), otherwise a text answer.
let server: http.Server
let port = 0
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url!.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'm1', name: 'M1', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' } }] }))
    }
    let body = ''
    for await (const c of req) body += c
    const { messages } = JSON.parse(body)
    const last = messages.at(-1)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    const wantsTool = String(messages.find((m: { role: string }) => m.role === 'user')?.content).includes('delete')
    if (wantsTool && last.role === 'user') {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"rm -rf build"}' } }] } }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 5 } })
    } else {
      send({ choices: [{ index: 0, delta: { content: 'Hello ' } }] })
      send({ choices: [{ index: 0, delta: { content: 'from m1.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 4 } })
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
afterAll(() => server.close())

function io(extra: Partial<Io> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-headless-'))
  const data = path.join(root, 'data')
  const cwd = path.join(root, 'proj')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(path.join(cwd, 'build'), { recursive: true })
  fs.writeFileSync(
    path.join(data, 'settings.json'),
    JSON.stringify({
      providers: [{ id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${port}/v1`, requiresKey: false }, { id: 'paid', name: 'Paid', baseUrl: `http://127.0.0.1:${port}/v1` }],
      models: { default: { providerId: 'local', modelId: 'm1' } },
      tools: { loadUserExtensions: false },
    }),
  )
  let out = ''
  let err = ''
  const stdout = new PassThrough()
  stdout.on('data', (d) => (out += d))
  const stderr = new PassThrough()
  stderr.on('data', (d) => (err += d))
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  const value: Io = { stdout, stderr, stdin, env: { HARNESS_DATA_DIR: data }, cwd, keys: new KeyStore(new FileSecrets(path.join(data, 'k.json')), {}), ...extra }
  return { io: value, out: () => out, err: () => err, cwd, data }
}

describe('xb -p', () => {
  it('prints the answer and exits 0', async () => {
    const t = io()
    expect(await runCli(['-p', 'say hi'], t.io)).toBe(0)
    expect(t.out()).toBe('Hello from m1.\n')
  })

  it('reports a JSON result with exact usage and cost', async () => {
    const t = io()
    expect(await runCli(['exec', 'say hi', '--output-format', 'json'], t.io)).toBe(0)
    const r = JSON.parse(t.out())
    expect(r).toMatchObject({ type: 'result', is_error: false, result: 'Hello from m1.', model: 'local:m1', exit_code: 0 })
    expect(r.usage).toMatchObject({ requests: 1, prompt_tokens: 100, completion_tokens: 4, cached_tokens: 0 })
    expect(r.usage.cost_usd).toBeCloseTo(100e-6 + 4 * 2e-6, 12)
    // Saved, so `xb -c` can pick it up.
    expect(fs.readdirSync(path.join(t.data, 'sessions'))).toHaveLength(1)
  })

  it('streams JSON lines', async () => {
    const t = io()
    await runCli(['-p', 'say hi', '--output-format', 'stream-json'], t.io)
    const lines = t.out().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toContain('text')
    expect(lines.at(-1).type).toBe('result')
  })

  it('denies destructive commands even in full-auto, since nobody can approve them', async () => {
    const t = io()
    expect(await runCli(['-p', 'delete the build folder', '--mode', 'full-auto', '--output-format', 'json'], t.io)).toBe(0)
    const r = JSON.parse(t.out())
    expect(r.denied).toEqual([expect.objectContaining({ tool: 'bash', subject: 'rm -rf build' })])
    expect(fs.existsSync(path.join(t.cwd, 'build'))).toBe(true)
  })

  it('continues the latest chat with -c', async () => {
    const t = io()
    await runCli(['-p', 'first'], t.io)
    await runCli(['-p', '-c', 'second'], t.io)
    const files = fs.readdirSync(path.join(t.data, 'sessions'))
    expect(files).toHaveLength(1)
    const s = JSON.parse(fs.readFileSync(path.join(t.data, 'sessions', files[0]), 'utf8'))
    expect(s.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content)).toEqual(['first', 'second'])
  })

  it('uses exit code 2 for usage problems', async () => {
    const t = io()
    expect(await runCli(['-p'], t.io)).toBe(2)
    expect(t.err()).toMatch(/no prompt/)
    expect(await runCli(['--mode', 'wild'], t.io)).toBe(2)
    expect(await runCli(['-p', 'x', '-m', 'paid:m1'], t.io)).toBe(2)
    expect(t.err()).toContain('No API key for Paid')
    expect(await runCli(['-p', 'x', '-c'], io().io)).toBe(2)
  })

  it('reads the prompt from a pipe', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const t = io({ stdin })
    stdin.end('say hi from a pipe')
    expect(await runCli(['-p'], t.io)).toBe(0)
    expect(t.out()).toContain('Hello from m1.')
  })

  it('prints the version and help', async () => {
    const t = io()
    expect(await runCli(['--version'], t.io)).toBe(0)
    expect(t.out()).toMatch(/^xb \d+\.\d+\.\d+/)
    expect(await runCli(['--help'], t.io)).toBe(0)
    expect(t.out()).toContain('xb -p "prompt"')
  })
})
