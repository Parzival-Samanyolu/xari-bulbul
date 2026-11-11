import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compactionSplit } from '../src/context/compact.js'
import { newSession, SessionStore } from '../src/sessions/store.js'
import { expandSlashCommand } from '../src/extensions/loader.js'
import { Permissions, ruleFor, ruleMatches } from '../src/permissions/permissions.js'
import { bashTool } from '../src/tools/bash.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { readFileTool } from '../src/tools/read-file.js'
import { checkBudget, UsageTracker } from '../src/usage/tracker.js'
import type { ChatMessage } from '../src/types.js'

const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const base = { allow: [], deny: [], allowOutsideWorkspace: false }

describe('permissions', () => {
  it('matches rules for commands and paths', () => {
    expect(ruleMatches('bash(npm test*)', bashTool, 'npm test -- --watch', cwd)).toBe(true)
    expect(ruleMatches('bash(npm test*)', bashTool, 'npm install', cwd)).toBe(false)
    expect(ruleMatches('edit_file(src/**)', editFileTool, 'src/a/b.ts', cwd)).toBe(true)
    expect(ruleMatches('edit_file(src/*)', editFileTool, 'src/a/b.ts', cwd)).toBe(false)
    expect(ruleMatches('edit_file', editFileTool, 'anything', cwd)).toBe(true)
    expect(ruleFor(bashTool, 'npm run build --prod')).toBe('bash(npm run*)')
  })

  it('applies modes, deny rules and workspace scoping', () => {
    const p = new Permissions({ ...base, mode: 'ask' }, cwd)
    expect(p.check(readFileTool, 'x').decision).toBe('allow')
    expect(p.check(bashTool, 'ls').decision).toBe('ask')
    p.setMode('acceptEdits')
    expect(p.check(editFileTool, 'src/a.ts').decision).toBe('allow')
    expect(p.check(editFileTool, '../outside.ts').decision).toBe('ask')
    expect(p.check(bashTool, 'ls').decision).toBe('ask')
    p.setMode('plan')
    expect(p.check(editFileTool, 'a').decision).toBe('deny')
    p.setMode('auto')
    expect(p.check(bashTool, 'ls').decision).toBe('allow')
    const d = new Permissions({ ...base, mode: 'auto', deny: ['bash(git push*)'] }, cwd)
    expect(d.check(bashTool, 'git push --force').decision).toBe('deny')
  })

  it('remembers "always allow" for the session', () => {
    const p = new Permissions({ ...base, mode: 'ask' }, cwd)
    p.remember(bashTool, 'npm test')
    expect(p.check(bashTool, 'npm test --coverage').decision).toBe('allow')
  })
})

describe('usage', () => {
  it('sums one provider over the last days', () => {
    const u = new UsageTracker(null)
    const now = new Date(2026, 10, 11, 12).getTime()
    const day = 86_400_000
    const rec = (providerId: string, ts: number, tokens: number) =>
      u.record({ ts, sessionId: 's', providerId, modelId: 'm', promptTokens: tokens, completionTokens: 0, cachedTokens: 0, cost: null })
    rec('chatgpt', now, 100)
    rec('chatgpt', now - 1000, 50)
    rec('chatgpt', now - 3 * day, 400)
    rec('chatgpt', now - 40 * day, 9999)
    rec('openrouter', now, 7)
    const r = u.forProvider('chatgpt', 30, now)
    expect(r).toMatchObject({ days: 30, activeDays: 2, peakDayTokens: 400 })
    expect(r.totals).toMatchObject({ requests: 3, promptTokens: 550 })
    expect(u.forProvider('none', 30, now)).toMatchObject({ activeDays: 0, peakDayTokens: 0 })
  })

  it('aggregates by session, day and model, and checks budgets', () => {
    const u = new UsageTracker(null)
    const rec = (sessionId: string, cost: number | null, ts = Date.now()) =>
      u.record({ ts, sessionId, providerId: 'p', modelId: 'm', promptTokens: 100, completionTokens: 10, cachedTokens: 0, cost })
    rec('s1', 0.01)
    rec('s1', null)
    rec('s2', 0.02, Date.now() - 3 * 86_400_000)
    const s = u.summary('s1')
    expect(s.session).toMatchObject({ requests: 2, promptTokens: 200, cost: 0.01, costPartial: true })
    expect(s.today.requests).toBe(2)
    expect(s.allTime.requests).toBe(3)
    expect(s.byModel['p:m'].requests).toBe(3)
    expect(checkBudget(s, { sessionBudgetUsd: 0.005, dailyBudgetUsd: null })).toMatchObject({ ok: false, which: 'session' })
    expect(checkBudget(s, { sessionBudgetUsd: null, dailyBudgetUsd: 1 })).toEqual({ ok: true })
    expect(u.toCsv().split('\n')).toHaveLength(4)
  })
})

describe('compaction split', () => {
  it('splits on user turns, keeping tool pairs intact', () => {
    const m: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', arguments: '{}' }] },
      { role: 'tool', toolCallId: '1', name: 't', content: 'r' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'c' },
    ]
    expect(compactionSplit(m)).toBe(4)
    expect(m[compactionSplit(m)].role).toBe('user')
  })
})

describe('slash commands', () => {
  it('expands templates with $ARGUMENTS', () => {
    const cmds = [{ name: 'review', description: '', template: 'Review $ARGUMENTS carefully', source: 'user' as const, file: '' }]
    expect(expandSlashCommand('/review src/a.ts', cmds)).toBe('Review src/a.ts carefully')
    expect(expandSlashCommand('/nope', cmds)).toBeNull()
    expect(expandSlashCommand('hello', cmds)).toBeNull()
  })
})

describe('session store', () => {
  it('finds chats for a folder whatever Unicode form its name uses', () => {
    const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'xb-sessions-')))
    const nfd = '/Users/me/Xarı Bülbül'.normalize('NFD')
    const s = newSession(nfd, { providerId: 'p', modelId: 'm' })
    s.messages.push({ role: 'user', content: 'hi' })
    store.save(s)
    expect(store.list({ cwd: '/Users/me/Xarı Bülbül'.normalize('NFC') })).toHaveLength(1)
  })
})
