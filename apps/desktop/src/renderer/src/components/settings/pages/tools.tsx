import { useState } from 'react'
import { MCP_PRESETS, presetServer } from '@harness/core/mcp-presets'
import type { McpServerStatus, Settings } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { ListField, Row, Section, Select, TextField, Toggle } from '../../fields'
import { SecretInput, type PageProps } from '../common'

// ---------------------------------------------------------------- Tools

export function ToolsListPage({ app, save }: PageProps) {
  const disabled = new Set(app.settings.tools.disabled)
  const tools = app.extensions.tools.filter((t) => t.source !== 'mcp')
  return (
    <Section description="Turn off tools you don't want the model to use. MCP server tools are listed under MCP servers.">
      <div className="tool-list">
        {tools.map((tool) => (
          <div key={tool.name} className="tool-item">
            <Toggle label={`Enable ${tool.name}`} value={!disabled.has(tool.name)} onChange={(on) => save((s) => ((s.tools.disabled = on ? s.tools.disabled.filter((x) => x !== tool.name) : [...s.tools.disabled, tool.name]), s))} />
            <code>{tool.name}</code>
            <span className={`badge ${tool.readOnly && tool.kind !== 'network' ? 'ok' : ''}`}>
              {tool.kind === 'network' ? 'network' : tool.readOnly ? 'read-only' : tool.kind === 'exec' ? 'runs commands' : tool.kind === 'edit' ? 'edits files' : tool.kind}
            </span>
            {tool.source !== 'builtin' && <span className="badge">{tool.plugin ? `${tool.plugin} plugin` : tool.source}</span>}
            <span className="muted small tool-desc" title={tool.description}>
              {tool.description}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- Web search

const SEARCH_BACKENDS = [
  { value: 'auto', label: 'Automatic (your free keys first, then keyless)' },
  { value: 'duckduckgo', label: 'Keyless only (DuckDuckGo)' },
  { value: 'brave', label: 'Brave Search API only (free key: 2,000/month)' },
  { value: 'tavily', label: 'Tavily only (free key: 1,000/month)' },
  { value: 'searxng', label: 'SearXNG (your instance)' },
] as const

const SEARCH_KEY_LINKS: Record<string, string> = { brave: 'https://brave.com/search/api/', tavily: 'https://app.tavily.com/' }

export function WebSearchPage({ app, save, onState, onError }: PageProps) {
  const ws = app.settings.tools.webSearch
  const keyIds = ['brave', 'tavily'] as const
  return (
    <Section description="The web_search tool works without any key. Free keys from Brave Search or Tavily make it more reliable: in automatic mode they're used first, and the keyless engines take over if they fail or run out.">
      <Row label="Search with">
        <Select label="Search with" value={ws.backend} options={[...SEARCH_BACKENDS]} onChange={(v) => save((s) => ((s.tools.webSearch.backend = v), s))} />
      </Row>
      {keyIds.map((id) => (
        <Row
          key={id}
          label={id === 'brave' ? 'Brave Search key' : 'Tavily key'}
          hint={
            <>
              {app.keys[id] ? 'Saved. ' : ''}Free tier: {id === 'brave' ? '2,000' : '1,000'} searches a month.{' '}
              <button className="link small" onClick={() => api.app.openExternal(SEARCH_KEY_LINKS[id])}>
                Get a key ↗
              </button>
              {app.keys[id] && (
                <>
                  {' · '}
                  <button className="link small danger" onClick={() => api.keys.set(id, null).then(onState, onError)}>
                    Remove
                  </button>
                </>
              )}
            </>
          }
          labelFor={`search-key-${id}`}
        >
          <SecretInput id={`search-key-${id}`} label={id === 'brave' ? 'Brave Search key' : 'Tavily key'} saved={!!app.keys[id]} placeholder="Paste key" onSave={(v) => api.keys.set(id, v).then(onState, onError)} />
        </Row>
      ))}
      <Row label="SearXNG URL" hint="Your own instance, used when Search with is SearXNG. It must allow JSON output (search.formats includes json)." labelFor="searxng-url">
        <TextField id="searxng-url" mono value={ws.searxngUrl} placeholder="https://searx.example.org" onChange={(v) => save((s) => ((s.tools.webSearch.searxngUrl = v.trim()), s))} />
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- MCP

type McpServer = Settings['mcp']['servers'][number]

/** `npx -y "@scope/server" --flag` → ['npx', '-y', '@scope/server', '--flag'] */
function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)
const pairs = (rec: Record<string, string>, sep: string) => Object.entries(rec).map(([k, v]) => `${k}${sep}${v}`)
function unpairs(list: string[], sep: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of list) {
    const i = item.indexOf(sep)
    if (i > 0) out[item.slice(0, i).trim()] = item.slice(i + sep.length).trim()
  }
  return out
}

const STATE_TEXT: Record<McpServerStatus['state'], string> = { connecting: 'connecting…', ready: 'connected', error: 'failed', off: 'off' }

export function McpPage({ app, save, onState, onError }: PageProps) {
  const servers = app.settings.mcp.servers
  const status = new Map(app.mcp.servers.map((s) => [s.id, s]))
  const [draft, setDraft] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http', target: '' })
  const tools = app.extensions.tools.filter((t) => t.source === 'mcp')

  const update = (i: number, fn: (s: McpServer) => McpServer) => save((st) => ((st.mcp.servers[i] = fn(st.mcp.servers[i])), st))
  const idFor = (name: string) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server'
    let id = base
    for (let n = 2; servers.some((s) => s.id === id); n++) id = `${base}-${n}`
    return id
  }
  const nameTaken = servers.some((s) => s.name.toLowerCase() === draft.name.trim().toLowerCase())
  const parts = splitCommand(draft.target)
  const valid = draft.name.trim() && !nameTaken && (draft.transport === 'stdio' ? parts.length > 0 : /^https?:\/\/\S+$/.test(draft.target.trim()))
  const add = () => {
    const base = { id: idFor(draft.name), name: draft.name.trim(), enabled: true }
    const server: McpServer = draft.transport === 'stdio' ? { ...base, transport: 'stdio', command: parts[0], args: parts.slice(1), env: {} } : { ...base, transport: 'http', url: draft.target.trim(), headers: {} }
    save((st) => ((st.mcp.servers = [...st.mcp.servers, server]), st))
    setDraft({ name: '', transport: draft.transport, target: '' })
  }
  const presets = MCP_PRESETS.filter((p) => !servers.some((s) => s.transport === 'http' && p.server.transport === 'http' && s.url === p.server.url))

  return (
    <>
      <Section description="Tools from Model Context Protocol servers work in every chat and follow your permission rules; name them in rules as mcp__<server>__<tool>. Tools a server marks read-only run without asking.">
        {servers.length === 0 && (
          <div className="empty-box">
            <b>No servers</b>
            <span className="muted small">Add one below.</span>
          </div>
        )}
        {servers.map((srv, i) => {
          const st = status.get(srv.id)
          const state = st?.state ?? (srv.enabled ? 'connecting' : 'off')
          return (
            <div key={srv.id} className="provider-card">
              <div className="provider-head">
                <Toggle label={`Enable ${srv.name}`} value={srv.enabled} onChange={(v) => update(i, (s) => ({ ...s, enabled: v }))} />
                <b>{srv.name}</b>
                <span className={`badge ${state === 'ready' ? 'ok' : ''}`} role="status">
                  {STATE_TEXT[state]}
                  {state === 'ready' ? ` · ${st?.toolCount ?? 0} ${st?.toolCount === 1 ? 'tool' : 'tools'}` : ''}
                </span>
                <span className="muted small mono mcp-target" title={srv.transport === 'stdio' ? [srv.command, ...srv.args].join(' ') : srv.url}>
                  {srv.transport === 'stdio' ? [srv.command, ...srv.args].map(quote).join(' ') : srv.url}
                </span>
                <div className="spacer" />
                <button className="btn ghost" disabled={!srv.enabled} onClick={() => api.mcp.restart(srv.id).then(onState, onError)}>
                  Restart
                </button>
                <button className="link danger small" onClick={() => confirm(`Remove ${srv.name}?`) && save((st) => ((st.mcp.servers = st.mcp.servers.filter((x) => x.id !== srv.id)), st))}>
                  Remove
                </button>
              </div>
              {state === 'error' && st?.error && <div className="notice notice-error small">{st.error}</div>}
              {srv.transport === 'http' && (
                <Row
                  label="Bearer token"
                  hint={MCP_PRESETS.find((p) => p.server.transport === 'http' && p.server.url === srv.url)?.token?.hint ?? 'Optional. Sent as Authorization: Bearer …, stored in the keychain like API keys.'}
                  labelFor={`mcp-token-${srv.id}`}
                  search=""
                >
                  <div className="inline">
                    <SecretInput id={`mcp-token-${srv.id}`} label={`Token for ${srv.name}`} saved={!!app.mcp.tokens[srv.id]} placeholder="Paste token" onSave={(v) => api.mcp.setToken(srv.id, v).then(onState, onError)} />
                    {app.mcp.tokens[srv.id] && (
                      <button className="btn ghost" onClick={() => api.mcp.setToken(srv.id, null).then(onState, onError)}>
                        Remove token
                      </button>
                    )}
                  </div>
                </Row>
              )}
              <details className="advanced">
                <summary>Edit</summary>
                {srv.transport === 'stdio' ? (
                  <>
                    <Row label="Command" hint="The program and its arguments" labelFor={`mcp-cmd-${srv.id}`} search="">
                      <TextField
                        label="Command"
                        id={`mcp-cmd-${srv.id}`}
                        mono
                        value={[srv.command, ...srv.args].map(quote).join(' ')}
                        onChange={(v) => {
                          const p = splitCommand(v)
                          if (p.length) update(i, (s) => ({ ...s, command: p[0], args: p.slice(1) }) as McpServer)
                        }}
                      />
                    </Row>
                    <Row label="Environment" hint="KEY=value, added to the server's environment" search="">
                      <ListField label="Environment" placeholder="API_TOKEN=…" value={pairs(srv.env, '=')} onChange={(v) => update(i, (s) => ({ ...s, env: unpairs(v, '=') }) as McpServer)} />
                    </Row>
                  </>
                ) : (
                  <>
                    <Row label="URL" hint="Streamable HTTP endpoint" labelFor={`mcp-url-${srv.id}`} search="">
                      <TextField label="URL" id={`mcp-url-${srv.id}`} mono value={srv.url} onChange={(v) => /^https?:\/\//.test(v) && update(i, (s) => ({ ...s, url: v.trim() }) as McpServer)} />
                    </Row>
                    <Row label="Headers" hint="Name: value, sent with every request (not for secrets; use the token field)" search="">
                      <ListField label="Headers" placeholder="X-Workspace: main" value={pairs(srv.headers, ': ')} onChange={(v) => update(i, (s) => ({ ...s, headers: unpairs(v, ':') }) as McpServer)} />
                    </Row>
                  </>
                )}
              </details>
            </div>
          )
        })}
      </Section>
      <Section title="Add a server" description="Local servers run as a command on this computer; remote ones are reached by URL.">
        {presets.map((p) => (
          <div key={p.id} className="mcp-preset">
            <div>
              <b>{p.label}</b>
              <div className="muted small">
                {p.description}
                {p.token && (
                  <>
                    {' '}
                    <button className="link small" onClick={() => api.app.openExternal(p.token!.url)}>
                      Get a token ↗
                    </button>
                  </>
                )}
              </div>
            </div>
            <button className="btn" onClick={() => save((st) => ((st.mcp.servers = [...st.mcp.servers, presetServer(p, st.mcp.servers)]), st))}>
              Add {p.label}
            </button>
          </div>
        ))}
        <div className="custom-provider">
          <label>
            <span className="small muted">Name</span>
            <input placeholder="github" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span className="small muted">Type</span>
            <Select
              label="Server type"
              value={draft.transport}
              options={[
                { value: 'stdio', label: 'Command' },
                { value: 'http', label: 'URL' },
              ]}
              onChange={(v) => setDraft({ ...draft, transport: v })}
            />
          </label>
          <label className="grow">
            <span className="small muted">{draft.transport === 'stdio' ? 'Command' : 'URL'}</span>
            <input
              className="mono"
              placeholder={draft.transport === 'stdio' ? 'npx -y @modelcontextprotocol/server-filesystem ~/Documents' : 'https://example.com/mcp'}
              value={draft.target}
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && valid && add()}
            />
          </label>
          <button className="btn" disabled={!valid} onClick={add}>
            Add
          </button>
        </div>
        {nameTaken && <div className="small warn">A server named "{draft.name.trim()}" already exists.</div>}
      </Section>
      {tools.length > 0 && (
        <Section title="Available MCP tools">
          <div className="tool-list">
            {tools.map((t) => (
              <div key={t.name} className="tool-item">
                <code>{t.name}</code>
                <span className={`badge ${t.readOnly ? 'ok' : ''}`}>{t.readOnly ? 'read-only' : 'asks'}</span>
                <span className="muted small tool-desc" title={t.description}>
                  {t.description.replace(/^\[MCP: [^\]]*\]\s*/, '')}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

// ---------------------------------------------------------------- Skills & commands

export function SkillsPage({ app, onState, onError }: PageProps) {
  const ext = app.extensions
  return (
    <>
      <Section
        title="Skills"
        description={
          <>
            Instructions the agent loads before a matching task, one folder with a <code>SKILL.md</code> each. Read from <code>skills/</code> in your extensions folder, in the project's <code>.harness/</code> and in <code>~/.claude/skills</code>. The agent saves new ones to your folder after hard, repeatable tasks.
          </>
        }
      >
        {app.skills.length === 0 ? (
          <p className="muted small">No skills yet.</p>
        ) : (
          <div className="tool-list">
            {app.skills.map((s) => (
              <div key={s.dir} className="tool-item">
                <code>{s.name}</code>
                <span className="badge">{s.plugin ? `${s.plugin} plugin` : s.source === 'claude' ? 'Claude Code' : s.source}</span>
                <span className="muted small tool-desc" title={s.description}>
                  {s.description}
                </span>
                <button className="btn ghost" aria-label={`Open folder of skill ${s.name}`} onClick={() => api.app.openPath(s.dir)}>
                  Open folder
                </button>
                {s.source !== 'claude' && !s.plugin && (
                  <button className="btn ghost danger" aria-label={`Delete skill ${s.name}`} onClick={() => confirm(`Delete the skill "${s.name}" and its folder?`) && api.skills.remove(s.dir).then(onState, onError)}>
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Slash commands" description="Type / in the message box to use one.">
        <div className="tool-list">
          {ext.commands.map((c) => (
            <div key={c.name} className="tool-item">
              <code>/{c.name}</code>
              <span className="badge">{c.plugin ? `${c.plugin} plugin` : c.source}</span>
              <span className="muted small tool-desc" title={c.description}>
                {c.description}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Extensions

export function ExtensionsPage({ app, save, onState, onError }: PageProps) {
  const t = app.settings.tools
  const ext = app.extensions
  return (
    <Section
      description={
        <>
          Your own tools (<code>tools/*.mjs</code>) and slash commands (<code>commands/*.md</code>) in <code>{ext.userDir}</code> or in <code>.harness/</code> inside a project.
        </>
      }
    >
      <Row label="Load my extensions" hint={ext.userDir}>
        <Toggle label="Load my extensions" value={t.loadUserExtensions} onChange={(v) => save((s) => ((s.tools.loadUserExtensions = v), s))} />
      </Row>
      <Row label="Load project tool code" hint="Runs .harness/tools/*.mjs from the open project. Only turn on for projects you trust. Project commands always load." search="Load project tool code (extensions)">
        <Toggle label="Load project tool code" value={t.loadProjectExtensions} onChange={(v) => save((s) => ((s.tools.loadProjectExtensions = v), s))} />
      </Row>
      <div className="inline">
        <button className="btn" onClick={() => api.extensions.openDir('user')}>
          Open my extensions folder
        </button>
        <button className="btn" disabled={!ext.projectDir} onClick={() => api.extensions.openDir('project')}>
          Open project .harness folder
        </button>
        <button className="btn" onClick={() => api.extensions.reload().then(onState, onError)}>
          Reload
        </button>
      </div>
      {ext.errors.map((e) => (
        <div key={e.file} className="notice notice-error small">
          {e.file}: {e.error}
        </div>
      ))}
      <details className="howto">
        <summary>Example tool and command</summary>
        <pre>{`// ~/.harness/tools/run_tests.mjs
export default {
  name: 'run_tests',
  description: 'Run the project test suite and return a summary',
  parameters: { type: 'object', properties: { filter: { type: 'string' } } },
  kind: 'exec',          // asks permission like bash
  async execute({ filter }, ctx) {
    const { execSync } = await import('node:child_process')
    return execSync(\`npm test -- \${filter ?? ''}\`, { cwd: ctx.cwd, encoding: 'utf8' })
  },
}

<!-- ~/.harness/commands/review.md -->
---
description: Review changes for bugs
---
Review the uncommitted changes (git diff) for bugs and risky code. Focus on: $ARGUMENTS`}</pre>
      </details>
    </Section>
  )
}
