import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { SessionStore, newSession, type Session } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { sessionSearchTool } from '../src/tools/session-search.js'
import type { ChatMessage } from '../src/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, ctx, tmpDir } from './helpers.js'

const model = { providerId: 'mock', modelId: 'm' }

/** Writes a chat straight to the store's folder, so its updatedAt stays what the test says. */
function saveChat(dir: string, cwd: string, title: string, updatedAt: number, messages: ChatMessage[]): Session {
  const s = newSession(cwd, model)
  s.meta.title = title
  s.meta.updatedAt = updatedAt
  s.messages = messages
  fs.writeFileSync(path.join(dir, `${s.meta.id}.json`), JSON.stringify(s))
  return s
}

function fixture() {
  const dir = tmpDir()
  const store = new SessionStore(dir)
  const project = tmpDir()
  const other = tmpDir()
  const older = saveChat(dir, project, 'Fix flaky login test', 1_000, [
    { role: 'user', content: 'The login test times out on CI weekly.' },
    { role: 'assistant', content: 'The login fixture waits on a timer; the timeout comes from there.', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"npm test -- login"}' }] },
    { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'PASS secret-tool-output' },
    { role: 'user', content: 'Review: zebra marker in an engine note', synthetic: 'review' },
  ])
  const newer = saveChat(dir, project, 'Release notes', 2_000, [
    { role: 'user', content: 'Write weekly release notes; mention the login change.' },
    { role: 'assistant', content: 'Done.' },
  ])
  const elsewhere = saveChat(dir, other, 'Other folder', 3_000, [{ role: 'user', content: 'login login login login login login' }])
  return { store, project, other, older, newer, elsewhere }
}

describe('session_search', () => {
  it('ranks by matched terms and hits, then recency, with snippets', async () => {
    const { store, project, older, newer } = fixture()
    const r = await sessionSearchTool.execute({ query: 'Login TIMEOUT' }, ctx(project, { sessions: store }))
    expect(r.isError).toBeFalsy()
    const first = r.content.indexOf(older.meta.id)
    const second = r.content.indexOf(newer.meta.id)
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(r.content).toContain('Fix flaky login test (1970-01-01')
    expect(r.content).toContain('- user: The login test times out on CI weekly.')
    expect(r.content).toContain('- tool: bash npm test -- login')

    // Same hits on one term: the newer chat comes first.
    const tie = await sessionSearchTool.execute({ query: 'weekly' }, ctx(project, { sessions: store }))
    expect(tie.content.indexOf(newer.meta.id)).toBeLessThan(tie.content.indexOf(older.meta.id))
    expect(tie.content.indexOf(newer.meta.id)).toBeGreaterThan(-1)
  })

  it('searches only this folder unless scope is all', async () => {
    const { store, project, elsewhere } = fixture()
    const here = await sessionSearchTool.execute({ query: 'login' }, ctx(project, { sessions: store }))
    expect(here.content).not.toContain(elsewhere.meta.id)
    const all = await sessionSearchTool.execute({ query: 'login', scope: 'all', limit: 1 }, ctx(project, { sessions: store }))
    // The other folder's chat has the most hits, and limit keeps just it.
    expect(all.content).toContain(elsewhere.meta.id)
    expect(all.content).toContain('3 past chats in any folder')
    expect(all.content.match(/^\d+\. /gm)).toHaveLength(1)
  })

  it('skips synthetic messages, tool output and the current chat', async () => {
    const { store, project, older } = fixture()
    const synthetic = await sessionSearchTool.execute({ query: 'zebra' }, ctx(project, { sessions: store }))
    expect(synthetic.content).toContain('No past chats in this folder mention "zebra"')
    const output = await sessionSearchTool.execute({ query: 'secret-tool-output' }, ctx(project, { sessions: store }))
    expect(output.content).toContain('No past chats')
    const self = await sessionSearchTool.execute({ query: 'flaky' }, ctx(project, { sessions: { list: (o) => store.list(o), load: (id) => store.load(id), exclude: older.meta.id } }))
    expect(self.content).toContain('No past chats')
  })

  it('is offered with a store, leaves out the current chat, and is hidden without one', async () => {
    const { store, project } = fixture()
    const run = async (sessions: SessionStore | undefined, script: StreamEvent[][]) => {
      const provider = new MockProvider(script)
      const registry = new ProviderRegistry([], () => undefined)
      registry.register(provider)
      const settings = defaultSettings()
      const session = newSession(project, model)
      const agent = new Agent({
        session,
        registry,
        tools: builtinTools(),
        settings,
        usage: new UsageTracker(null),
        permissions: new Permissions(settings.permissions, project),
        sessions,
        onSave: (s) => store.save(s),
        askPermission: async () => {
          throw new Error('should not ask')
        },
        onEvent: () => {},
      })
      await agent.send('what did we do about the login timeout?')
      return { provider, agent }
    }
    const call: StreamEvent = { type: 'tool_call', call: { id: '1', name: 'session_search', arguments: '{"query":"login timeout"}' } }
    const { provider, agent } = await run(store, [[call], [{ type: 'text', delta: 'Found it.' }]])
    expect(provider.requests[0].tools?.map((t) => t.name)).toContain('session_search')
    const result = agent.session.messages.find((m) => m.role === 'tool' && m.toolCallId === '1')
    expect(result?.content).toContain('2 past chats in this folder')
    expect(result?.content).not.toContain(agent.session.meta.id)

    const off = await run(undefined, [[{ type: 'text', delta: 'hi' }]])
    expect(off.provider.requests[0].tools?.map((t) => t.name)).not.toContain('session_search')
  })
})
