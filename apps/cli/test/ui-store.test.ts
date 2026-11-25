import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSettings } from '@harness/core'
import { createHost } from '../src/host.js'
import { ChatStore } from '../src/ui/store.js'

// A model that writes two paragraphs, or asks to write a file when told to.
let server: http.Server
let baseUrl = ''
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url?.endsWith('/models')) return void res.end(JSON.stringify({ data: [{ id: 'm' }] }))
      const body = JSON.parse(raw || '{}')
      const last = body.messages.at(-1)
      const wantsFile = /file/.test(body.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '') && last.role !== 'tool'
      const chunks = wantsFile
        ? [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'hi\n' }) } }] } }, { delta: {}, finish_reason: 'tool_calls' }]
        : [{ delta: { content: 'First paragraph.\n\nSecond ' } }, { delta: { content: 'paragraph.' } }, { delta: {}, finish_reason: 'stop' }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...c }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})
afterAll(() => void server.close())

async function store() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xari-ui-data-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xari-ui-cwd-'))
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(parseSettings({ providers: [{ id: 'mock', name: 'Mock', baseUrl, requiresKey: false }], models: { default: { providerId: 'mock', modelId: 'm' } }, memory: { enabled: false }, permissions: { mode: 'ask' } })))
  const host = await createHost({ cwd, env: { HARNESS_DATA_DIR: dataDir, PATH: process.env.PATH, XARI_LANG: 'en' }, version: 't', noMcp: true })
  return { s: new ChatStore(host, host.newSession(), 't'), cwd, host }
}

describe('ChatStore', () => {
  it('starts with the banner and turns a reply into finished paragraphs', async () => {
    const { s, host } = await store()
    expect(s.state.items[0]).toMatchObject({ kind: 'banner', model: 'mock/m' })
    await s.submit('hi')
    const kinds = s.state.items.map((i) => i.kind)
    expect(kinds).toEqual(['banner', 'user', 'reply', 'reply'])
    expect(s.state.items.slice(2).map((i) => (i as { text: string }).text.trim())).toEqual(['First paragraph.', 'Second paragraph.'])
    expect(s.state.items[2]).toMatchObject({ first: true })
    expect(s.state.items[3]).toMatchObject({ first: false })
    expect(s.state.running).toBe(false)
    s.dispose()
    await host.dispose()
  })

  it('opens an approval, and a typed refusal reaches the model as feedback', async () => {
    const { s, cwd, host } = await store()
    const turn = s.submit('make a file')
    await new Promise<void>((r) => s.on('change', () => s.state.overlay && r()))
    expect(s.state.overlay).toMatchObject({ kind: 'permission', req: { tool: 'write_file' } })
    s.answerPermission({ type: 'deny', feedback: 'call it b.txt' })
    await turn
    expect(fs.existsSync(path.join(cwd, 'a.txt'))).toBe(false)
    expect(s.state.items.find((i) => i.kind === 'tool')).toMatchObject({ state: 'denied' })
    s.dispose()
    await host.dispose()
  })

  it('runs commands: mode, model, help and cost', async () => {
    const { s, host } = await store()
    await s.submit('/mode plan')
    expect(s.state.mode).toBe('plan')
    await s.submit('/mode')
    expect(s.state.mode).toBe('auto')
    await s.submit('/model mock/other')
    expect(s.state.model).toBe('mock/other')
    await s.submit('/help')
    // (a third section lists the user's own commands and skills when they have any)
    expect(s.state.items.filter((i) => i.kind === 'lines').map((i) => (i as { title?: string }).title)).toEqual(expect.arrayContaining(['Commands', 'Keys']))
    await s.submit('/cost')
    expect(s.state.items.at(-1)).toMatchObject({ kind: 'lines', title: 'Usage' })
    expect(s.commands('mo').map((c) => c.name)).toEqual(['model', 'mode'])
    s.dispose()
    await host.dispose()
  })

  it('queues a message typed while a turn runs and sends it next', async () => {
    const { s, host } = await store()
    const first = s.submit('one')
    await s.submit('two')
    expect(s.state.queue).toEqual(['two'])
    await first
    await new Promise((r) => setTimeout(r, 300))
    expect(s.state.items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(['one', 'two'])
    s.dispose()
    await host.dispose()
  })
})
