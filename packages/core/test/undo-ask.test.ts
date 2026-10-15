import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Agent, type AgentEvent, type QuestionRequest } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { toWireMessage } from '../src/providers/openai-compat.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { checkFile } from '../src/tools/check.js'
import { multiEditTool } from '../src/tools/edit-file.js'
import { builtinTools } from '../src/tools/index.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { ctx, MockProvider, tmpDir } from './helpers.js'

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const text = (t: string): StreamEvent[] => [{ type: 'text', delta: t }]

async function setup(script: ConstructorParameters<typeof MockProvider>[0], opts: { askUser?: (q: QuestionRequest) => Promise<string>; onSave?: () => void } = {}) {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'app.txt'), 'hello world\n')
  const provider = new MockProvider(script)
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const settings = defaultSettings()
  settings.permissions.mode = 'auto'
  const events: AgentEvent[] = []
  const agent = new Agent({
    session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
    registry,
    tools: builtinTools(),
    settings,
    usage: new UsageTracker(null),
    permissions: new Permissions(settings.permissions, dir),
    askPermission: async () => ({ type: 'allow' }),
    askUser: opts.askUser,
    onSave: opts.onSave,
    onEvent: (e) => events.push(e),
  })
  return { dir, agent, provider, events }
}

describe('multi_edit', () => {
  it('applies edits in order and writes once', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.js')
    fs.writeFileSync(file, 'const a = 1\nconst b = 2\n')
    const c = ctx(dir, { readFiles: new Set([file]) })
    const r = await multiEditTool.execute(
      multiEditTool.parse({ path: 'a.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'a = 10\nconst b', new_string: 'a = 10\nlet b' }] }),
      c,
    )
    expect(r.isError).toBeFalsy()
    expect(fs.readFileSync(file, 'utf8')).toBe('const a = 10\nlet b = 2\n')
  })

  it('changes nothing when any edit fails', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.js')
    fs.writeFileSync(file, 'const a = 1\n')
    const r = await multiEditTool.execute(
      multiEditTool.parse({ path: 'a.js', edits: [{ old_string: 'a = 1', new_string: 'a = 2' }, { old_string: 'missing', new_string: 'x' }] }),
      ctx(dir, { readFiles: new Set([file]) }),
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Edit 2 of 2.*No edits were applied/s)
    expect(fs.readFileSync(file, 'utf8')).toBe('const a = 1\n')
  })

  it('requires a prior read', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.js'), 'x\n')
    const r = await multiEditTool.execute(multiEditTool.parse({ path: 'a.js', edits: [{ old_string: 'x', new_string: 'y' }] }), ctx(dir))
    expect(r.isError).toBe(true)
  })
})

describe('check after edit', () => {
  it('reports JSON and JavaScript syntax errors, and nothing for clean files', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"a": 1,}')
    fs.writeFileSync(path.join(dir, 'ok.json'), '{"a": 1}')
    fs.writeFileSync(path.join(dir, 'bad.js'), 'function (\n')
    fs.writeFileSync(path.join(dir, 'ok.js'), 'const x = 1\n')
    expect(await checkFile(path.join(dir, 'bad.json'), dir)).toMatch(/JSON syntax error/)
    expect(await checkFile(path.join(dir, 'ok.json'), dir)).toBeNull()
    expect(await checkFile(path.join(dir, 'bad.js'), dir)).toMatch(/SyntaxError/)
    expect(await checkFile(path.join(dir, 'ok.js'), dir)).toBeNull()
  })

  it('adds problems to the edit result only when the setting is on', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'c.json')
    fs.writeFileSync(file, '{"a": 1}')
    const input = multiEditTool.parse({ path: 'c.json', edits: [{ old_string: '1}', new_string: '1,}' }] })
    const on = await multiEditTool.execute(input, ctx(dir, { readFiles: new Set([file]), checkAfterEdit: true }))
    expect(on.content).toMatch(/problems after this edit/)
    fs.writeFileSync(file, '{"a": 1}')
    const off = await multiEditTool.execute(input, ctx(dir, { readFiles: new Set([file]) }))
    expect(off.content).not.toMatch(/problems/)
  })
})

describe('ask_user', () => {
  it('waits for the answer and gives it to the model', async () => {
    const asked: QuestionRequest[] = []
    const { agent, provider } = await setup(
      [[call('q1', 'ask_user', { question: 'Which database?', options: ['Postgres', 'SQLite'] })], text('Using SQLite.')],
      { askUser: async (q) => (asked.push(q), 'SQLite') },
    )
    await agent.send('set up storage')
    expect(asked).toEqual([{ callId: 'q1', question: 'Which database?', options: ['Postgres', 'SQLite'] }])
    expect(provider.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'The user answered: SQLite' })
    expect(provider.requests[0].tools?.some((t) => t.name === 'ask_user')).toBe(true)
  })

  it('is not offered when nobody can answer', async () => {
    const { agent, provider } = await setup([text('ok')])
    await agent.send('hi')
    expect(provider.requests[0].tools?.some((t) => t.name === 'ask_user')).toBe(false)
  })
})

describe('undo and edit', () => {
  const editTurn = (id: string, from: string, to: string) => [
    [call(`r${id}`, 'read_file', { path: 'app.txt' })],
    [call(`e${id}`, 'edit_file', { path: 'app.txt', old_string: from, new_string: to }), call(`w${id}`, 'write_file', { path: `new${id}.txt`, content: 'x' })],
    text('Done.'),
  ]

  it('reverts a whole turn, and tells the model with the next message', async () => {
    const { dir, agent, provider } = await setup([...editTurn('1', 'world', 'there'), text('ok')])
    await agent.send('change it')
    expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('hello there\n')
    expect(agent.checkpoints).toHaveLength(1)
    expect(agent.checkpoints[0].at).toBe(0)

    const restored = agent.revert(0)
    expect(restored).toHaveLength(2)
    expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('hello world\n')
    expect(fs.existsSync(path.join(dir, 'new1.txt'))).toBe(false)
    expect(agent.checkpoints).toHaveLength(0)

    await agent.send('thanks')
    const wire = toWireMessage(provider.requests.at(-1)!.messages.at(-1)!)
    expect(wire.content).toMatch(/^thanks\n\n<system-reminder>\nThe user reverted/)
    expect(agent.session.pendingNote).toBeUndefined()
  })

  it('reverts one file of a turn', async () => {
    const { dir, agent } = await setup(editTurn('1', 'world', 'there'))
    await agent.send('change it')
    agent.revert(0, path.join(dir, 'new1.txt'))
    expect(fs.existsSync(path.join(dir, 'new1.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('hello there\n')
    expect(Object.keys(agent.checkpoints[0].files)).toEqual([path.join(dir, 'app.txt')])
  })

  it('keeps the content from before the first edit of a turn', async () => {
    const { dir, agent } = await setup([
      [call('r', 'read_file', { path: 'app.txt' })],
      [call('e1', 'edit_file', { path: 'app.txt', old_string: 'world', new_string: 'a' })],
      [call('e2', 'edit_file', { path: 'app.txt', old_string: 'a', new_string: 'b' })],
      text('Done.'),
    ])
    await agent.send('change it')
    expect(agent.checkpoints[0].files[path.join(dir, 'app.txt')]).toBe('hello world\n')
  })

  it('edits an earlier message: drops later history and can revert its changes', async () => {
    const { dir, agent, provider } = await setup([...editTurn('1', 'world', 'there'), text('Second.'), text('Edited.')])
    await agent.send('change it')
    await agent.send('second')
    const index = agent.session.messages.findIndex((m) => m.role === 'user' && m.content === 'change it')
    await agent.editAndResend(index, 'leave it', { revert: true })
    expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('hello world\n')
    expect(agent.session.messages.map((m) => m.content)).toEqual(['leave it', 'Edited.'])
    expect(agent.checkpoints).toHaveLength(0)
    expect(provider.requests.at(-1)!.messages.slice(1).map((m) => m.content)).toEqual(['leave it'])
  })
})

describe('retry and failures', () => {
  it('retries the last request without adding a message', async () => {
    const { agent, provider } = await setup([{ events: text('partial'), fail: new Error('boom') }, text('Recovered.')])
    expect(await agent.send('hi')).toBe('error')
    expect(agent.session.messages.at(-1)?.content).toMatch(/\[interrupted\]$/)
    expect(await agent.retry()).toBe('done')
    expect(agent.session.messages.map((m) => m.content)).toEqual(['hi', 'Recovered.'])
    expect(provider.requests[1].messages.slice(1).map((m) => m.content)).toEqual(['hi'])
  })

  it('refuses to retry a finished turn', async () => {
    const { agent } = await setup([text('ok')])
    await agent.send('hi')
    await expect(agent.retry()).rejects.toThrow(/Nothing to retry/)
  })

  it('still ends the turn when saving fails, and warns once', async () => {
    const { agent, events } = await setup([text('ok')], {
      onSave: () => {
        throw new Error('ENOSPC: no space left on device')
      },
    })
    expect(await agent.send('hi')).toBe('done')
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'done' })
    expect(events.filter((e) => e.type === 'notice' && /Couldn't save/.test(e.text))).toHaveLength(1)
  })

  it('warns about missing tool support once per turn, not on every step', async () => {
    const { agent, events } = await setup([[call('r', 'read_file', { path: 'app.txt' })], [call('r2', 'read_file', { path: 'app.txt' })], text('ok')])
    ;(agent as unknown as { registry: ProviderRegistry }).registry.seedCache('mock', [
      { id: 'm', name: 'M', providerId: 'mock', contextLength: 100_000, free: true, supportsTools: false },
    ])
    await agent.send('hi')
    expect(events.filter((e) => e.type === 'notice' && /tool support/.test(e.text))).toHaveLength(1)
  })
})
