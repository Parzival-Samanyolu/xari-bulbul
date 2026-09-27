import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { McpManager, mcpToolName } from '../src/mcp/manager.js'
import { Permissions } from '../src/permissions/permissions.js'
import type { McpServerConfig } from '../src/settings/schema.js'
import { ctx, tmpDir } from './helpers.js'

function fakeServer() {
  const server = new McpServer({ name: 'fake', version: '1.0.0' })
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )
  server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'nope' }],
    isError: true,
  }))
  server.registerTool('picture', { description: 'Returns an image' }, async () => ({
    content: [
      { type: 'text', text: 'here' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }))
  return server
}

const stdio = (id: string, name = id): McpServerConfig => ({ id, name, enabled: true, transport: 'stdio', command: 'unused', args: [], env: {} })

function manager(onChange?: () => void) {
  return new McpManager({
    onChange,
    transportFor: async (cfg) => {
      if (cfg.id === 'broken') throw new Error('spawn broken ENOENT')
      const [client, server] = InMemoryTransport.createLinkedPair()
      await fakeServer().connect(server)
      return client
    },
  })
}

describe('MCP manager', () => {
  it('connects, lists tools with prefixed names, and calls them', async () => {
    const m = manager()
    await m.sync([stdio('calc', 'My Calc')])
    expect(m.status()).toEqual([{ id: 'calc', name: 'My Calc', state: 'ready', toolCount: 3 }])
    const tools = m.tools()
    expect(tools.map((t) => t.name).sort()).toEqual(['mcp__My_Calc__add', 'mcp__My_Calc__fail', 'mcp__My_Calc__picture'])
    const add = tools.find((t) => t.name.endsWith('add'))!
    expect(add.readOnly).toBe(true)
    expect(add.source).toBe('mcp')
    expect(add.description).toMatch(/Add two numbers/)
    expect(add.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' } } })
    const r = await add.execute(add.parse({ a: 2, b: 3 }), ctx(tmpDir()))
    expect(r).toEqual({ content: '5' })
    const fail = tools.find((t) => t.name.endsWith('fail'))!
    expect(fail.readOnly).toBe(false)
    expect(await fail.execute({}, ctx(tmpDir()))).toEqual({ content: 'nope', isError: true })
    const pic = tools.find((t) => t.name.endsWith('picture'))!
    expect((await pic.execute({}, ctx(tmpDir()))).content).toBe('here\n[image image/png]')
    await m.close()
  })

  it('reports a broken server without affecting the others', async () => {
    const changes: string[] = []
    const m = manager(() => changes.push('x'))
    await m.sync([stdio('broken'), stdio('calc')])
    const byId = Object.fromEntries(m.status().map((s) => [s.id, s]))
    expect(byId.broken).toMatchObject({ state: 'error', error: expect.stringMatching(/ENOENT/) })
    expect(byId.calc.state).toBe('ready')
    expect(m.tools()).toHaveLength(3)
    expect(changes.length).toBeGreaterThan(0)
    await m.close()
  })

  it('disconnects removed and disabled servers', async () => {
    const m = manager()
    await m.sync([stdio('calc')])
    await m.sync([{ ...stdio('calc'), enabled: false }])
    expect(m.status()).toEqual([{ id: 'calc', name: 'calc', state: 'off', toolCount: 0 }])
    expect(m.tools()).toEqual([])
    await m.sync([])
    expect(m.status()).toEqual([])
  })

  it('makes names that providers accept', () => {
    expect(mcpToolName('GitHub Server!', 'create-issue')).toBe('mcp__GitHub_Server__create-issue')
    expect(mcpToolName('x'.repeat(80), 'y'.repeat(80)).length).toBeLessThanOrEqual(64)
  })

  it('works with permission rules and plan mode', async () => {
    const m = manager()
    await m.sync([stdio('calc')])
    const fail = m.tools().find((t) => t.name.endsWith('fail'))!
    const add = m.tools().find((t) => t.name.endsWith('add'))!
    const p = new Permissions({ mode: 'ask', allow: ['mcp__calc__fail'], deny: [], allowOutsideWorkspace: false }, '/p')
    expect(p.check(fail, fail.subject({})).decision).toBe('allow')
    p.setMode('plan')
    expect(p.check(fail, '{}').decision).toBe('deny')
    expect(p.check(add, '{}').decision).toBe('allow')
    await m.close()
  })
})

describe('MCP over stdio', () => {
  it('spawns a real server process with its env', async () => {
    const script = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url))
    const m = new McpManager()
    await m.sync([{ id: 'echo', name: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [script], env: { ECHO_PREFIX: '> ' } }])
    expect(m.status()[0]).toMatchObject({ state: 'ready', toolCount: 1 })
    const echo = m.tools()[0]
    expect(await echo.execute({ text: 'hi' }, ctx(tmpDir()))).toEqual({ content: '> hi' })
    await m.close()
  }, 20_000)

  it('explains a command that does not exist', async () => {
    const m = new McpManager()
    await m.sync([{ id: 'nope', name: 'nope', enabled: true, transport: 'stdio', command: 'definitely-not-a-command-xyz', args: [], env: {} }])
    expect(m.status()[0]).toMatchObject({ state: 'error', error: expect.stringMatching(/ENOENT|not found|not recognized/i) })
    await m.close()
  }, 20_000)
})
