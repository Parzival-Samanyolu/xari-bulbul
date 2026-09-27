import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Agent, type AgentEvent } from '../src/loop/agent.js'
import { destructiveReason } from '../src/permissions/destructive.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { bashTool } from '../src/tools/bash.js'
import { builtinTools } from '../src/tools/index.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, tmpDir } from './helpers.js'

const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const base = { allow: [], deny: [], allowOutsideWorkspace: false }

describe('destructive command detection', () => {
  it.each([
    ['rm old_draft_v2_FINAL.txt', /Deletes files: old_draft_v2_FINAL\.txt/],
    ['cd ~/Downloads && rm -f a.txt b.txt', /Deletes files: a\.txt b\.txt/],
    ['sudo rm -rf build', /Deletes files: build/],
    ['FOO=1 rmdir empty', /Deletes/],
    ['ls | xargs rm', /Deletes/],
    ['find . -name "*.tmp" -delete', /Deletes files found by find/],
    ['git clean -fdx', /git clean/],
    ['git reset --hard HEAD~1', /git reset --hard/],
    ['git push --force origin main', /force push/i],
    ['git push -f', /force push/i],
    ['git checkout -- .', /Discards/],
    ['git branch -D feature', /Deletes branch/],
    ['mv -f a.txt b.txt', /Overwrites/],
    ['Remove-Item -Recurse .\\dist', /Deletes files/],
    ['del notes.txt', /Deletes files/],
    ['/bin/rm x', /Deletes files: x/],
  ])('flags %s', (cmd, re) => {
    expect(destructiveReason(cmd)).toMatch(re)
  })

  it.each(['ls -la', 'echo rm -rf /', 'npm run rm-dist', 'git status', 'git push origin main', 'grep -r "rm " .', 'mv a b', 'cat readme'])(
    'does not flag %s',
    (cmd) => {
      expect(destructiveReason(cmd)).toBeNull()
    },
  )
})

describe('permissions for destructive commands', () => {
  it('asks even in auto mode', () => {
    const p = new Permissions({ ...base, mode: 'auto' }, cwd)
    const v = p.check(bashTool, 'rm old_draft_v2_FINAL.txt')
    expect(v.decision).toBe('ask')
    expect(v.decision === 'ask' && v.reason).toMatch(/old_draft_v2_FINAL/)
    expect(p.check(bashTool, 'ls').decision).toBe('allow')
  })

  it('lets explicit settings rules and the setting through, but not session rules', () => {
    const allowed = new Permissions({ ...base, mode: 'auto', allow: ['bash(rm -rf node_modules*)'] }, cwd)
    expect(allowed.check(bashTool, 'rm -rf node_modules').decision).toBe('allow')
    expect(allowed.check(bashTool, 'rm -rf src').decision).toBe('ask')

    const off = new Permissions({ ...base, mode: 'auto', confirmDestructive: false }, cwd)
    expect(off.check(bashTool, 'rm -rf src').decision).toBe('allow')

    const p = new Permissions({ ...base, mode: 'ask' }, cwd)
    p.remember(bashTool, 'rm old_draft_v1.txt')
    expect(p.sessionAllow).toEqual([])
    expect(p.check(bashTool, 'rm old_draft_v2_FINAL.txt').decision).toBe('ask')
  })

  it('still denies in plan mode', () => {
    const p = new Permissions({ ...base, mode: 'plan' }, cwd)
    expect(p.check(bashTool, 'rm a').decision).toBe('deny')
  })
})

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
const text = (t: string): StreamEvent => ({ type: 'text', delta: t })

async function setup(script: ConstructorParameters<typeof MockProvider>[0], answer: 'allow' | 'deny' = 'allow') {
  const dir = tmpDir()
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
    askPermission: async () => ({ type: answer }),
    onEvent: (e) => events.push(e),
  })
  return { dir, agent, provider, events }
}

const todos = (...s: ('pending' | 'in_progress' | 'completed')[]) => ({ todos: s.map((status, i) => ({ content: `step ${i + 1}`, status })) })

describe('end-of-turn review', () => {
  it('asks once about unfinished checklist items, then warns if still unfinished', async () => {
    const { agent, provider, events } = await setup([
      [call('1', 'todo_write', todos('completed', 'pending', 'pending'))],
      [text('Completed everything you asked for.')],
      [text('Steps 2 and 3 were skipped: no tool for reminders.')],
    ])
    expect(await agent.send('do three things')).toBe('done')
    expect(provider.requests).toHaveLength(3)
    const review = provider.requests[2].messages.at(-1)!
    expect(review.role).toBe('user')
    expect(review.content).toMatch(/step 2[\s\S]*step 3/)
    expect(agent.session.messages.find((m) => m.role === 'user' && m.synthetic === 'review')).toBeTruthy()
    const notice = events.find((e) => e.type === 'notice' && /2 of 3/.test(e.text))
    expect(notice).toBeTruthy()
  })

  it('mentions failed tool calls but not denied ones', async () => {
    const { agent, provider } = await setup([
      [call('1', 'read_file', { path: 'missing.txt' })],
      [text('All done.')],
      [text('I could not read missing.txt.')],
    ])
    await agent.send('read it')
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[2].messages.at(-1)!.content).toMatch(/read_file missing\.txt/)
  })

  it('does nothing on a clean turn', async () => {
    const { agent, provider, events } = await setup([
      [call('1', 'todo_write', todos('completed', 'completed'))],
      [text('Done.')],
    ])
    await agent.send('x')
    expect(provider.requests).toHaveLength(2)
    expect(events.some((e) => e.type === 'notice')).toBe(false)
  })

  it('does not push back on commands the user denied', async () => {
    const { dir, agent, provider } = await setup([[call('1', 'bash', { command: 'rm keep.txt' })], [text('OK, I left it.')]], 'deny')
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
    await agent.send('clean up')
    expect(provider.requests).toHaveLength(2)
    expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true)
  })
})

describe('end-of-turn review ignores recovered failures', () => {
  it('clears a failure once the same call succeeds', async () => {
    const { dir, agent, provider } = await setup([
      [call('1', 'read_file', { path: 'late.txt' })],
      [call('2', 'write_file', { path: 'late.txt', content: 'x' })],
      [call('3', 'read_file', { path: 'late.txt' })],
      [text('Done.')],
    ])
    await agent.send('x')
    expect(fs.existsSync(path.join(dir, 'late.txt'))).toBe(true)
    expect(provider.requests).toHaveLength(4)
  })
})
