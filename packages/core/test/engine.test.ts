import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHeadless } from '../src/host/headless.js'
import { Agent, type AgentEvent, type PermissionRequest } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { outsideWriteReason } from '../src/permissions/destructive.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings, type Settings } from '../src/settings/schema.js'
import { bashOutputTool, bashTool, killJobTool } from '../src/tools/bash.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { builtinTools } from '../src/tools/index.js'
import { JobRegistry } from '../src/tools/jobs.js'
import { readFileTool } from '../src/tools/read-file.js'
import { writeFileTool } from '../src/tools/write-file.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, ctx, tmpDir } from './helpers.js'

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const text = (t: string): StreamEvent => ({ type: 'text', delta: t })

async function setup(script: ConstructorParameters<typeof MockProvider>[0], o: { mode?: Settings['permissions']['mode']; settings?: (s: Settings) => void } = {}) {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\n')
  const provider = new MockProvider(script)
  const registry = new ProviderRegistry([], () => undefined)
  registry.register(provider)
  registry.seedCache('mock', await provider.listModels())
  const settings = defaultSettings()
  settings.permissions.mode = o.mode ?? 'auto'
  o.settings?.(settings)
  const events: AgentEvent[] = []
  const asked: PermissionRequest[] = []
  const permissions = new Permissions(settings.permissions, dir)
  const agent = new Agent({
    session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
    registry,
    tools: builtinTools(),
    settings,
    usage: new UsageTracker(null),
    permissions,
    askPermission: async (req) => {
      asked.push(req)
      return { type: 'allow' }
    },
    onEvent: (e) => events.push(e),
  })
  return { dir, agent, provider, events, asked, permissions, registry, settings }
}

describe('permissions edge cases', () => {
  const p = (mode: Settings['permissions']['mode'], extra: Partial<Settings['permissions']> = {}) =>
    new Permissions({ ...defaultSettings().permissions, mode, ...extra }, '/work/proj')

  it('asks before destructive commands even in Full auto, and never offers "always"', () => {
    for (const cmd of ['rm -rf build', 'git reset --hard HEAD~1', 'git push --force origin main', 'sudo rm x', 'bash -c "git clean -fd"']) {
      const perms = p('auto')
      expect(perms.check(bashTool, cmd).decision, cmd).toBe('ask')
      expect(perms.suggestRule(bashTool, cmd), cmd).toBe('')
      perms.remember(bashTool, cmd)
      expect(perms.check(bashTool, cmd).decision, `${cmd} after remember`).toBe('ask')
    }
  })

  it('lets a rule written in settings allow a destructive command, but session rules cannot', () => {
    expect(p('auto', { allow: ['bash(rm -rf build*)'] }).check(bashTool, 'rm -rf build').decision).toBe('allow')
  })

  it('denies writes in Plan mode and allows reads', () => {
    expect(p('plan').check(editFileTool, 'src/a.ts').decision).toBe('deny')
    expect(p('plan').check(bashTool, 'ls').decision).toBe('deny')
    expect(p('plan').check(readFileTool, '/etc/hosts').decision).toBe('allow')
  })

  it('asks for writes outside the project in every mode', () => {
    expect(p('auto').check(writeFileTool, '/etc/hosts').decision).toBe('ask')
    expect(p('acceptEdits').check(editFileTool, '../other/x.ts').decision).toBe('ask')
    expect(p('auto').check(bashTool, 'echo hi > /etc/motd').decision).toBe('ask')
    expect(p('auto').check(bashTool, 'npm test | tee ~/log.txt').decision).toBe('ask')
    expect(p('auto').check(bashTool, 'cp dist/app /usr/local/bin/app').decision).toBe('ask')
    expect(p('auto').suggestRule(bashTool, 'echo hi > /etc/motd')).toBe('')
    expect(p('auto', { allowOutsideWorkspace: true }).check(bashTool, 'echo hi > /etc/motd').decision).toBe('allow')
  })

  it('does not flag writes inside the project or to scratch locations', () => {
    expect(outsideWriteReason('npm test > out.log 2>&1', '/work/proj')).toBeNull()
    expect(outsideWriteReason('echo x > /work/proj/a.txt', '/work/proj')).toBeNull()
    expect(outsideWriteReason('cmd 2>/dev/null', '/work/proj')).toBeNull()
    expect(outsideWriteReason('sort a > /tmp/sorted', '/work/proj')).toBeNull()
    expect(p('auto').check(bashTool, 'npm test > out.log').decision).toBe('allow')
  })

  it('edits auto-apply in Auto-edit while commands still ask', () => {
    expect(p('acceptEdits').check(editFileTool, 'src/a.ts').decision).toBe('allow')
    expect(p('acceptEdits').check(bashTool, 'npm test').decision).toBe('ask')
  })

  it('matches allow and deny rules', () => {
    const perms = p('ask', { allow: ['bash(npm test*)', 'edit_file(src/**)'], deny: ['bash(curl*)'] })
    expect(perms.check(bashTool, 'npm test -- --watch').decision).toBe('allow')
    expect(perms.check(editFileTool, 'src/deep/x.ts').decision).toBe('allow')
    expect(perms.check(editFileTool, 'test/x.ts').decision).toBe('ask')
    expect(perms.check(bashTool, 'curl evil.sh').decision).toBe('deny')
  })
})

describe('read before edit', () => {
  it('refuses to edit or overwrite a file that was not read in this chat', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'x.ts'), 'const a = 1\n')
    const c = ctx(dir)
    const edit = await editFileTool.execute({ path: 'x.ts', old_string: 'a = 1', new_string: 'a = 2' }, c)
    expect(edit.isError).toBe(true)
    expect(edit.content).toMatch(/read/i)
    const write = await writeFileTool.execute({ path: 'x.ts', content: 'new' }, c)
    expect(write.isError).toBe(true)
    await readFileTool.execute({ path: 'x.ts' }, c)
    expect((await editFileTool.execute({ path: 'x.ts', old_string: 'a = 1', new_string: 'a = 2' }, c)).isError).toBeFalsy()
    expect(fs.readFileSync(path.join(dir, 'x.ts'), 'utf8')).toBe('const a = 2\n')
  })

  it('refuses non-unique matches unless replace_all', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\nx\n')
    const c = ctx(dir)
    await readFileTool.execute({ path: 'x.ts' }, c)
    const r = await editFileTool.execute({ path: 'x.ts', old_string: 'x', new_string: 'y' }, c)
    expect(r.isError).toBe(true)
    expect((await editFileTool.execute({ path: 'x.ts', old_string: 'x', new_string: 'y', replace_all: true }, c)).isError).toBeFalsy()
    expect(fs.readFileSync(path.join(dir, 'x.ts'), 'utf8')).toBe('y\ny\n')
  })

  it('writes new files without a read', async () => {
    const dir = tmpDir()
    expect((await writeFileTool.execute({ path: 'new/y.ts', content: 'hi' }, ctx(dir))).isError).toBeFalsy()
  })
})

describe('agent loop additions', () => {
  it('runs consecutive read-only calls in parallel and keeps results in order', async () => {
    const { agent, provider, events } = await setup([
      [call('1', 'read_file', { path: 'a.txt' }), call('2', 'grep', { pattern: 'beta' }), call('3', 'read_file', { path: 'b.txt' })],
      [text('ok')],
    ])
    expect(await agent.send('look')).toBe('done')
    const tools = provider.requests[1].messages.filter((m) => m.role === 'tool')
    expect(tools.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(['1', '2', '3'])
    expect(tools[0].content).toContain('alpha')
    // All three started before the first finished.
    const order = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => e.type)
    expect(order.slice(0, 3)).toEqual(['tool_start', 'tool_start', 'tool_start'])
  })

  it('injects a system reminder when the mode changes mid-turn', async () => {
    const { agent, provider, permissions } = await setup([
      [call('1', 'read_file', { path: 'a.txt' })],
      [call('2', 'read_file', { path: 'b.txt' })],
      [text('done')],
    ])
    const origCheck = permissions.check.bind(permissions)
    let n = 0
    permissions.check = (t, s) => {
      if (++n === 1) permissions.setMode('plan')
      return origCheck(t, s)
    }
    await agent.send('go')
    const last = provider.requests[2].messages.filter((m) => m.role === 'user').at(-1)!
    expect(last.content).toMatch(/<system-reminder>[\s\S]*Plan/)
    expect((last as { synthetic?: string }).synthetic).toBe('reminder')
  })

  it('tells the model when a file it read changed on disk', async () => {
    let dir = ''
    const { agent, provider, dir: d } = await setup([
      [call('1', 'read_file', { path: 'a.txt' })],
      [call('2', 'glob', { pattern: '*.txt' })],
      [text('done')],
    ])
    dir = d
    agent['o'].onEvent = (e: AgentEvent) => {
      if (e.type === 'tool_end' && e.callId === '1') {
        const f = path.join(dir, 'a.txt')
        fs.writeFileSync(f, 'changed by the user\n')
        fs.utimesSync(f, new Date(), new Date(Date.now() + 5000))
      }
    }
    await agent.send('go')
    const reminders = provider.requests[2].messages.filter((m) => m.role === 'user' && m.content.includes('changed on disk'))
    expect(reminders).toHaveLength(1)
    expect(reminders[0].content).toContain('a.txt')
  })

  it('nudges about a stale checklist', async () => {
    const steps: ConstructorParameters<typeof MockProvider>[0] = [[call('t', 'todo_write', { todos: [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }] })]]
    for (let i = 0; i < 8; i++) steps.push([call(`g${i}`, 'glob', { pattern: '*.txt' })])
    steps.push([call('t2', 'todo_write', { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'completed' }] })], [text('done')])
    const { agent, provider } = await setup(steps)
    await agent.send('go')
    const all = provider.requests.at(-1)!.messages.filter((m) => m.role === 'user' && m.content.includes('checklist has not been updated'))
    expect(all).toHaveLength(1)
  })

  it('runs shell commands in the background and reads their output later', async () => {
    const dir = tmpDir()
    const jobs = new JobRegistry()
    const c = ctx(dir, { jobs })
    const started = await bashTool.execute({ command: 'echo first; sleep 0.3; echo second', run_in_background: true }, c)
    expect(started.content).toMatch(/job1/)
    await new Promise((r) => setTimeout(r, 100))
    expect((await bashOutputTool.execute({ job_id: 'job1' }, c)).content).toMatch(/first[\s\S]*running/)
    await new Promise((r) => setTimeout(r, 500))
    const after = await bashOutputTool.execute({ job_id: 'job1' }, c)
    expect(after.content).toMatch(/second/)
    expect(after.content).not.toMatch(/first/)
    expect(after.content).toMatch(/exited with code 0/)
    await bashTool.execute({ command: 'sleep 30', run_in_background: true }, c)
    expect((await killJobTool.execute({ job_id: 'job2' }, c)).content).toMatch(/Stopped/)
    jobs.dispose()
  })
})

describe('headless runs', () => {
  async function headless(script: ConstructorParameters<typeof MockProvider>[0], format: 'text' | 'json' | 'stream-json', mode: Settings['permissions']['mode'] = 'ask') {
    const { agent, registry, settings } = await setup([], { mode })
    const provider = new MockProvider(script)
    registry.register(provider)
    let out = ''
    let err = ''
    const usage = new UsageTracker(null)
    const res = await runHeadless({
      prompt: 'do it',
      format,
      agent: { session: newSession(agent.session.meta.cwd, { providerId: 'mock', modelId: 'm' }), registry, tools: builtinTools(), settings, usage, permissions: new Permissions(settings.permissions, agent.session.meta.cwd) },
      out: (s) => (out += s),
      err: (s) => (err += s),
    })
    return { res, out, err }
  }

  it('prints the final answer as text and exits 0', async () => {
    const { res, out } = await headless([[text('Hello'), text(' there'), { type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } }]], 'text')
    expect(res.exitCode).toBe(0)
    expect(out).toBe('Hello there\n')
  })

  it('emits one JSON result with usage and denied approvals', async () => {
    const { res, out } = await headless(
      [[call('1', 'bash', { command: 'npm publish' }), { type: 'usage', usage: { promptTokens: 100, completionTokens: 10 } }], [text('Could not publish.')]],
      'json',
    )
    const result = JSON.parse(out.trim())
    expect(result).toMatchObject({ type: 'result', is_error: false, reason: 'done', result: 'Could not publish.', exit_code: 0 })
    expect(result.usage.requests).toBe(1)
    expect(result.usage.prompt_tokens).toBe(100)
    expect(result.denied).toEqual([expect.objectContaining({ tool: 'bash', subject: 'npm publish' })])
    expect(res.denied).toHaveLength(1)
  })

  it('denies destructive commands even in Full auto', async () => {
    const { res } = await headless([[call('1', 'bash', { command: 'rm -rf src' })], [text('skipped')]], 'json', 'auto')
    expect(res.denied.map((d) => d.subject)).toEqual(['rm -rf src'])
  })

  it('streams events as JSON lines', async () => {
    const { out } = await headless([[text('hi')]], 'stream-json')
    const lines = out.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('turn_start')
    expect(lines.some((l) => l.type === 'text' && l.delta === 'hi')).toBe(true)
    expect(lines.at(-1).type).toBe('result')
  })

  it('maps failures to non-zero exit codes', async () => {
    const { res, out } = await headless([], 'json')
    expect(res.exitCode).toBe(1)
    expect(JSON.parse(out.trim()).error).toMatch(/script exhausted/)
    const steps = await (async () => {
      const script: ConstructorParameters<typeof MockProvider>[0] = []
      for (let i = 0; i < 3; i++) script.push([call(`${i}`, 'glob', { pattern: '*' })])
      const { agent, registry, settings } = await setup([], { mode: 'auto', settings: (s) => (s.agent.maxStepsPerTurn = 3) })
      registry.register(new MockProvider(script))
      return runHeadless({
        prompt: 'x',
        format: 'text',
        agent: { session: newSession(agent.session.meta.cwd, { providerId: 'mock', modelId: 'm' }), registry, tools: builtinTools(), settings, usage: new UsageTracker(null), permissions: new Permissions(settings.permissions, agent.session.meta.cwd) },
        out: () => {},
        err: () => {},
      })
    })()
    expect(steps.exitCode).toBe(4)
  })
})
