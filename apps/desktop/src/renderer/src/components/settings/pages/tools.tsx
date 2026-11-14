import { useState } from 'react'
import { MCP_PRESETS, presetServer } from '@harness/core/mcp-presets'
import type { AppState, FoundSkillInfo, McpServerStatus, Settings, SkillRepoHit } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useT } from '../../../lib/i18n'
import { ListField, Row, Section, Select, TextField, Toggle } from '../../fields'
import { SecretInput, type PageProps } from '../common'
import { rich } from '../../../lib/rich'

type T = ReturnType<typeof useT>['t']

/** Where a tool, skill or command comes from, as shown on its badge. */
function sourceText(t: T, source: string, plugin?: string): string {
  if (plugin) return t('settings.tools.pluginBadge', { name: plugin })
  if (source === 'user') return t('settings.tools.sourceUser')
  if (source === 'project') return t('settings.tools.sourceProject')
  if (source === 'claude') return 'Claude Code'
  return source
}

// ---------------------------------------------------------------- Tools

export function ToolsListPage({ app, save }: PageProps) {
  const { t } = useT()
  const disabled = new Set(app.settings.tools.disabled)
  const tools = app.extensions.tools.filter((t) => t.source !== 'mcp')
  return (
    <Section description={t('settings.tools.listIntro')}>
      <div className="tool-list">
        {tools.map((tool) => (
          <div key={tool.name} className="tool-item">
            <Toggle label={t('settings.tools.enableTool', { name: tool.name })} value={!disabled.has(tool.name)} onChange={(on) => save((s) => ((s.tools.disabled = on ? s.tools.disabled.filter((x) => x !== tool.name) : [...s.tools.disabled, tool.name]), s))} />
            <code>{tool.name}</code>
            <span className={`badge ${tool.readOnly && tool.kind !== 'network' ? 'ok' : ''}`}>
              {tool.kind === 'network'
                ? t('settings.tools.kindNetwork')
                : tool.readOnly
                  ? t('settings.tools.kindReadOnly')
                  : tool.kind === 'exec'
                    ? t('settings.tools.kindExec')
                    : tool.kind === 'edit'
                      ? t('settings.tools.kindEdit')
                      : tool.kind === 'other'
                        ? t('settings.tools.kindOther')
                        : tool.kind}
            </span>
            {tool.source !== 'builtin' && <span className="badge">{sourceText(t, tool.source, tool.plugin)}</span>}
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

const searchBackends = (t: T, num: (n: number) => string) =>
  [
    { value: 'auto', label: t('settings.tools.backendAuto') },
    { value: 'duckduckgo', label: t('settings.tools.backendKeyless') },
    { value: 'brave', label: t('settings.tools.backendBrave', { num: num(2000) }) },
    { value: 'tavily', label: t('settings.tools.backendTavily', { num: num(1000) }) },
    { value: 'searxng', label: t('settings.tools.backendSearxng') },
  ] as const

const SEARCH_KEY_LINKS: Record<string, string> = { brave: 'https://brave.com/search/api/', tavily: 'https://app.tavily.com/' }

export function WebSearchPage({ app, save, onState, onError }: PageProps) {
  const { t, lang } = useT()
  const num = (n: number) => n.toLocaleString(lang)
  const keyLabel = (id: 'brave' | 'tavily') => (id === 'brave' ? t('settings.tools.braveKey') : t('settings.tools.tavilyKey'))
  const ws = app.settings.tools.webSearch
  const keyIds = ['brave', 'tavily'] as const
  return (
    <Section description={t('settings.tools.webSearchIntro')}>
      <Row label={t('settings.tools.searchWith')} search="Search with">
        <Select label={t('settings.tools.searchWith')} value={ws.backend} options={[...searchBackends(t, num)]} onChange={(v) => save((s) => ((s.tools.webSearch.backend = v), s))} />
      </Row>
      {keyIds.map((id) => (
        <Row
          key={id}
          label={keyLabel(id)}
          search={id === 'brave' ? 'Brave Search key' : 'Tavily key'}
          hint={
            <>
              {app.keys[id] ? `${t('settings.tools.keySaved')} ` : ''}
              {t('settings.tools.freeTier', { count: id === 'brave' ? 2000 : 1000, num: num(id === 'brave' ? 2000 : 1000) })}{' '}
              <button className="link small" onClick={() => api.app.openExternal(SEARCH_KEY_LINKS[id])}>
                {t('settings.tools.getKey')}
              </button>
              {app.keys[id] && (
                <>
                  {' · '}
                  <button className="link small danger" onClick={() => api.keys.set(id, null).then(onState, onError)}>
                    {t('common.remove')}
                  </button>
                </>
              )}
            </>
          }
          labelFor={`search-key-${id}`}
        >
          <SecretInput id={`search-key-${id}`} label={keyLabel(id)} saved={!!app.keys[id]} placeholder={t('settings.tools.pasteKey')} onSave={(v) => api.keys.set(id, v).then(onState, onError)} />
        </Row>
      ))}
      <Row label={t('settings.tools.searxngUrl')} search="SearXNG URL" hint={t('settings.tools.searxngUrlHint')} labelFor="searxng-url">
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

const stateText = (t: T, state: McpServerStatus['state']): string =>
  ({ connecting: t('settings.tools.mcpConnecting'), ready: t('settings.tools.mcpConnected'), error: t('settings.tools.mcpFailed'), off: t('settings.tools.mcpOff') })[state]

export function McpPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const servers = app.settings.mcp.servers
  const status = new Map(app.mcp.servers.map((s) => [s.id, s]))
  const [draft, setDraft] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http', target: '' })
  const tools = app.extensions.tools.filter((x) => x.source === 'mcp')

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
    // New servers start off: their tools are sent with every request, so the user turns them on.
    const base = { id: idFor(draft.name), name: draft.name.trim(), enabled: false }
    const server: McpServer = draft.transport === 'stdio' ? { ...base, transport: 'stdio', command: parts[0], args: parts.slice(1), env: {} } : { ...base, transport: 'http', url: draft.target.trim(), headers: {} }
    save((st) => ((st.mcp.servers = [...st.mcp.servers, server]), st))
    setDraft({ name: '', transport: draft.transport, target: '' })
  }
  const presets = MCP_PRESETS.filter((p) => !servers.some((s) => s.transport === 'http' && p.server.transport === 'http' && s.url === p.server.url))

  return (
    <>
      <Section description={t('settings.tools.mcpIntro', { pattern: 'mcp__<server>__<tool>' })}>
        {servers.length === 0 && (
          <div className="empty-box">
            <b>{t('settings.tools.noServers')}</b>
            <span className="muted small">{t('settings.tools.addOneBelow')}</span>
          </div>
        )}
        {servers.map((srv, i) => {
          const st = status.get(srv.id)
          const state = st?.state ?? (srv.enabled ? 'connecting' : 'off')
          return (
            <div key={srv.id} className="provider-card mcp-card">
              <div className="provider-head">
                <Toggle label={t('settings.tools.enableServer', { name: srv.name })} value={srv.enabled} onChange={(v) => update(i, (s) => ({ ...s, enabled: v }))} />
                <b>{srv.name}</b>
                <span className={`badge ${state === 'ready' ? 'ok' : ''}`} role="status">
                  {stateText(t, state)}
                  {state === 'ready' ? ` · ${t('settings.tools.toolCount', { count: st?.toolCount ?? 0 })}` : ''}
                </span>
                {state === 'ready' && app.mcp.toolTokens[srv.id] ? (
                  <span className="badge" title={t('settings.tools.mcpTokensHint', { tokens: app.mcp.toolTokens[srv.id] })}>
                    {t('settings.tools.mcpTokens', { tokens: tokensText(app.mcp.toolTokens[srv.id]) })}
                  </span>
                ) : null}
                <span className="muted small mono mcp-target" title={srv.transport === 'stdio' ? [srv.command, ...srv.args].join(' ') : srv.url}>
                  {srv.transport === 'stdio' ? [srv.command, ...srv.args].map(quote).join(' ') : srv.url}
                </span>
                <div className="spacer" />
                <button className="btn ghost" disabled={!srv.enabled} onClick={() => api.mcp.restart(srv.id).then(onState, onError)}>
                  {t('settings.tools.restart')}
                </button>
                <button className="link danger small" onClick={() => confirm(t('settings.tools.removeServerConfirm', { name: srv.name })) && save((st) => ((st.mcp.servers = st.mcp.servers.filter((x) => x.id !== srv.id)), st))}>
                  {t('common.remove')}
                </button>
              </div>
              {state === 'error' && st?.error && <div className="notice notice-error small">{st.error}</div>}
              {srv.transport === 'http' && (
                <Row
                  label={t('settings.tools.bearerToken')}
                  hint={MCP_PRESETS.find((p) => p.server.transport === 'http' && p.server.url === srv.url)?.token?.hint ?? t('settings.tools.bearerTokenHint', { header: 'Authorization: Bearer …' })}
                  labelFor={`mcp-token-${srv.id}`}
                  search=""
                >
                  <div className="inline">
                    <SecretInput id={`mcp-token-${srv.id}`} label={t('settings.tools.tokenFor', { name: srv.name })} saved={!!app.mcp.tokens[srv.id]} placeholder={t('settings.tools.pasteToken')} onSave={(v) => api.mcp.setToken(srv.id, v).then(onState, onError)} />
                    {app.mcp.tokens[srv.id] && (
                      <button className="btn ghost" onClick={() => api.mcp.setToken(srv.id, null).then(onState, onError)}>
                        {t('settings.tools.removeToken')}
                      </button>
                    )}
                  </div>
                </Row>
              )}
              <details className="advanced">
                <summary>{t('common.edit')}</summary>
                {srv.transport === 'stdio' ? (
                  <>
                    <Row label={t('settings.tools.command')} hint={t('settings.tools.commandHint')} labelFor={`mcp-cmd-${srv.id}`} search="">
                      <TextField
                        label={t('settings.tools.command')}
                        id={`mcp-cmd-${srv.id}`}
                        mono
                        value={[srv.command, ...srv.args].map(quote).join(' ')}
                        onChange={(v) => {
                          const p = splitCommand(v)
                          if (p.length) update(i, (s) => ({ ...s, command: p[0], args: p.slice(1) }) as McpServer)
                        }}
                      />
                    </Row>
                    <Row label={t('settings.tools.environment')} hint={t('settings.tools.environmentHint', { format: 'KEY=value' })} search="">
                      <ListField label={t('settings.tools.environment')} placeholder="API_TOKEN=…" value={pairs(srv.env, '=')} onChange={(v) => update(i, (s) => ({ ...s, env: unpairs(v, '=') }) as McpServer)} />
                    </Row>
                  </>
                ) : (
                  <>
                    <Row label="URL" hint={t('settings.tools.urlHint')} labelFor={`mcp-url-${srv.id}`} search="">
                      <TextField label="URL" id={`mcp-url-${srv.id}`} mono value={srv.url} onChange={(v) => /^https?:\/\//.test(v) && update(i, (s) => ({ ...s, url: v.trim() }) as McpServer)} />
                    </Row>
                    <Row label={t('settings.tools.headers')} hint={t('settings.tools.headersHint', { format: 'Name: value' })} search="">
                      <ListField label={t('settings.tools.headers')} placeholder="X-Workspace: main" value={pairs(srv.headers, ': ')} onChange={(v) => update(i, (s) => ({ ...s, headers: unpairs(v, ':') }) as McpServer)} />
                    </Row>
                  </>
                )}
              </details>
            </div>
          )
        })}
      </Section>
      <Section title={t('settings.tools.addServer')} search="Add a server" description={t('settings.tools.addServerHint')}>
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
                      {t('settings.tools.getToken')}
                    </button>
                  </>
                )}
              </div>
            </div>
            <button className="btn" onClick={() => save((st) => ((st.mcp.servers = [...st.mcp.servers, presetServer(p, st.mcp.servers)]), st))}>
              {t('settings.tools.addPreset', { name: p.label })}
            </button>
          </div>
        ))}
        <div className="custom-provider">
          <label>
            <span className="small muted">{t('settings.tools.name')}</span>
            <input placeholder="github" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span className="small muted">{t('settings.tools.type')}</span>
            <Select
              label={t('settings.tools.serverType')}
              value={draft.transport}
              options={[
                { value: 'stdio', label: t('settings.tools.command') },
                { value: 'http', label: 'URL' },
              ]}
              onChange={(v) => setDraft({ ...draft, transport: v })}
            />
          </label>
          <label className="grow">
            <span className="small muted">{draft.transport === 'stdio' ? t('settings.tools.command') : 'URL'}</span>
            <input
              className="mono"
              placeholder={draft.transport === 'stdio' ? 'npx -y @modelcontextprotocol/server-filesystem ~/Documents' : 'https://example.com/mcp'}
              value={draft.target}
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && valid && add()}
            />
          </label>
          <button className="btn" disabled={!valid} onClick={add}>
            {t('common.add')}
          </button>
        </div>
        {nameTaken && <div className="small warn">{t('settings.tools.nameTaken', { name: draft.name.trim() })}</div>}
      </Section>
      {tools.length > 0 && (
        <Section title={t('settings.tools.mcpTools')}>
          <div className="tool-list">
            {tools.map((tool) => (
              <div key={tool.name} className="tool-item">
                <code>{tool.name}</code>
                <span className={`badge ${tool.readOnly ? 'ok' : ''}`}>{tool.readOnly ? t('settings.tools.kindReadOnly') : t('settings.tools.asks')}</span>
                <span className="muted small tool-desc" title={tool.description}>
                  {tool.description.replace(/^\[MCP: [^\]]*\]\s*/, '')}
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

export function SkillsPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const ext = app.extensions
  const off = new Set(app.settings.tools.disabledSkills)
  const setOn = (name: string, on: boolean) =>
    save((st) => ((st.tools.disabledSkills = on ? st.tools.disabledSkills.filter((n) => n !== name) : [...new Set([...st.tools.disabledSkills, name])]), st))
  return (
    <>
      <Section
        title={t('settings.tools.skills')}
        search="Skills"
        description={rich(t('settings.tools.skillsIntro'), {
          file: <code>SKILL.md</code>,
          skillsDir: <code>skills/</code>,
          projectDir: <code>.harness/</code>,
          claudeDir: <code>~/.claude/skills</code>,
        })}
      >
        {app.skills.length === 0 ? (
          <p className="muted small">{t('settings.tools.noSkills')}</p>
        ) : (
          <div className="tool-list">
            {app.skills.map((s) => (
              <div key={s.dir} className={`tool-item${off.has(s.name) ? ' is-off' : ''}`}>
                <Toggle label={t('settings.tools.enableSkill', { name: s.name })} value={!off.has(s.name)} onChange={(v) => setOn(s.name, v)} />
                <code>{s.name}</code>
                <span className="badge">{sourceText(t, s.source, s.plugin)}</span>
                <SkillTokensBadge tokens={s.tokens} />
                <span className="muted small tool-desc" title={s.description}>
                  {s.description}
                </span>
                <button className="btn ghost" aria-label={t('settings.tools.openSkillFolder', { name: s.name })} onClick={() => api.app.openPath(s.dir)}>
                  {t('settings.parts.openFolder')}
                </button>
                {s.source !== 'claude' && !s.plugin && (
                  <button className="btn ghost danger" aria-label={t('settings.tools.deleteSkillLabel', { name: s.name })} onClick={() => confirm(t('settings.tools.deleteSkillConfirm', { name: s.name })) && api.skills.remove(s.dir).then(onState, onError)}>
                    {t('common.delete')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <SkillCatalog app={app} onState={onState} onError={onError} />
      <SkillSearch onState={onState} onError={onError} />
      <Section title={t('settings.tools.slashCommands')} search="Slash commands" description={t('settings.tools.slashCommandsHint')}>
        <div className="tool-list">
          {ext.commands.map((c) => (
            <div key={c.name} className="tool-item">
              <code>/{c.name}</code>
              <span className="badge">{sourceText(t, c.source, c.plugin)}</span>
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
  const { t } = useT()
  const tools = app.settings.tools
  const ext = app.extensions
  return (
    <Section
      description={rich(t('settings.tools.extensionsIntro'), {
        toolsGlob: <code>tools/*.mjs</code>,
        commandsGlob: <code>commands/*.md</code>,
        userDir: <code>{ext.userDir}</code>,
        projectDir: <code>.harness/</code>,
      })}
    >
      <Row label={t('settings.tools.loadMine')} search="Load my extensions" hint={ext.userDir}>
        <Toggle label={t('settings.tools.loadMine')} value={tools.loadUserExtensions} onChange={(v) => save((s) => ((s.tools.loadUserExtensions = v), s))} />
      </Row>
      <Row label={t('settings.tools.loadProject')} hint={t('settings.tools.loadProjectHint', { glob: '.harness/tools/*.mjs' })} search="Load project tool code (extensions)">
        <Toggle label={t('settings.tools.loadProject')} value={tools.loadProjectExtensions} onChange={(v) => save((s) => ((s.tools.loadProjectExtensions = v), s))} />
      </Row>
      <div className="inline">
        <button className="btn" onClick={() => api.extensions.openDir('user')}>
          {t('settings.tools.openMine')}
        </button>
        <button className="btn" disabled={!ext.projectDir} onClick={() => api.extensions.openDir('project')}>
          {t('settings.tools.openProject', { dir: '.harness' })}
        </button>
        <button className="btn" onClick={() => api.extensions.reload().then(onState, onError)}>
          {t('settings.tools.reload')}
        </button>
      </div>
      {ext.errors.map((e) => (
        <div key={e.file} className="notice notice-error small">
          {e.file}: {e.error}
        </div>
      ))}
      <details className="howto">
        <summary>{t('settings.tools.example')}</summary>
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

// ---------------------------------------------------------------- Skill catalog and search

/** `1.2K` style token count. */
const tokensText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n))

/** "~45 tokens · ~3.2K when used", with the details on hover. */
function SkillTokensBadge({ tokens }: { tokens: { listed: number; loaded: number } }) {
  const { t } = useT()
  return (
    <span className="badge" title={t('settings.tools.skillTokensHint', { listed: tokens.listed, loaded: tokens.loaded })}>
      {t('settings.tools.skillTokens', { listed: tokensText(tokens.listed), loaded: tokensText(tokens.loaded) })}
    </span>
  )
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Reviewed skills from public repos, installed into ~/.harness/skills in one click. */
function SkillCatalog({ app, onState, onError }: { app: AppState; onState: PageProps['onState']; onError: PageProps['onError'] }) {
  const { t } = useT()
  if (!app.skillCatalog.length) return null
  const busy = app.skillCatalog.some((s) => s.busy)
  return (
    <Section title={t('settings.tools.skillCatalog')} search="Get skills catalog" description={t('settings.tools.skillCatalogHint')}>
      <div className="tool-list">
        {app.skillCatalog.map((s) => (
          <div key={s.id} className="tool-item">
            <code>{s.name}</code>
            <span className="badge">{s.repo}</span>
            <span className="badge">{s.license}</span>
            {s.scripts && <span className="badge" title={t('settings.tools.skillScriptsHint')}>{t('settings.tools.skillScripts')}</span>}
            <SkillTokensBadge tokens={s.tokens} />
            <span className="muted small tool-desc" title={s.description}>
              {s.description}
            </span>
            <button className="btn ghost" aria-label={t('settings.tools.viewSkillLabel', { name: s.name })} onClick={() => api.app.openExternal(s.treeUrl)}>
              {t('settings.tools.viewSkill')}
            </button>
            {s.installed && !s.update ? (
              <span className="muted small">{t('settings.tools.skillInstalled')}</span>
            ) : (
              <button className="btn" disabled={busy} aria-label={t(s.update ? 'settings.tools.updateSkillLabel' : 'settings.tools.installSkillLabel', { name: s.name })} onClick={() => api.skills.install(s.id).then(onState, onError)}>
                {s.busy ? t('settings.tools.skillInstalling') : t(s.update ? 'settings.tools.updateSkill' : 'settings.tools.installSkill')}
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

/** Any public skill on GitHub: search tagged repos, or paste a repo or folder link. Not reviewed. */
function SkillSearch({ onState, onError }: { onState: PageProps['onState']; onError: PageProps['onError'] }) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [repos, setRepos] = useState<SkillRepoHit[] | null>(null)
  const [open, setOpen] = useState<{ repo: string; skills: FoundSkillInfo[] | null } | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const fail = (e: unknown) => {
    setLoading(false)
    onError(e)
  }
  const browse = (repo: string) => {
    setOpen({ repo, skills: null })
    api.skills.browse(repo).then((skills) => setOpen({ repo, skills }), (e) => (setOpen(null), onError(e)))
  }
  const run = () => {
    const q = query.trim()
    if (!q) return
    // A pasted repo or link goes straight to its skills.
    if (/^(https?:\/\/)?github\.com\//.test(q) || /^[\w.-]+\/[\w.-]+$/.test(q)) {
      setRepos(null)
      browse(q)
      return
    }
    setLoading(true)
    setOpen(null)
    api.skills.search(q).then((r) => (setLoading(false), setRepos(r)), fail)
  }
  const install = (s: FoundSkillInfo) => {
    if (!confirm(t(s.scripts ? 'settings.tools.unreviewedScriptsConfirm' : 'settings.tools.unreviewedConfirm', { name: s.name, repo: s.repo }))) return
    setInstalling(s.key)
    api.skills.installFound(s.key).then(
      (st) => {
        setInstalling(null)
        setOpen((o) => o && { ...o, skills: o.skills?.map((x) => (x.key === s.key ? { ...x, installed: true } : x)) ?? null })
        onState(st)
      },
      (e) => (setInstalling(null), onError(e)),
    )
  }
  const skillList = (skills: FoundSkillInfo[] | null) =>
    skills === null ? (
      <p className="muted small">{t('settings.tools.skillsLoading')}</p>
    ) : skills.length === 0 ? (
      <p className="muted small">{t('settings.tools.noSkillsInRepo')}</p>
    ) : (
      <div className="tool-list">
        {skills.map((s) => (
          <div key={s.key} className="tool-item">
            <code>{s.name}</code>
            <span className="badge">{t('settings.tools.notReviewed')}</span>
            {s.license ? <span className="badge">{s.license}</span> : <span className="badge">{t('settings.tools.noLicense')}</span>}
            {s.scripts && <span className="badge" title={t('settings.tools.skillScriptsHint')}>{t('settings.tools.skillScripts')}</span>}
            <SkillTokensBadge tokens={s.tokens} />
            <span className="muted small tool-desc" title={s.description}>
              {s.description} · {t('settings.tools.skillFiles', { count: s.files })}, {kb(s.bytes)}
            </span>
            <button className="btn ghost" aria-label={t('settings.tools.viewSkillLabel', { name: s.name })} onClick={() => api.app.openExternal(s.treeUrl)}>
              {t('settings.tools.viewSkill')}
            </button>
            {s.installed ? (
              <span className="muted small">{t('settings.tools.skillInstalled')}</span>
            ) : (
              <button className="btn" disabled={!!installing} aria-label={t('settings.tools.installSkillLabel', { name: s.name })} onClick={() => install(s)}>
                {installing === s.key ? t('settings.tools.skillInstalling') : t('settings.tools.installSkill')}
              </button>
            )}
          </div>
        ))}
      </div>
    )

  return (
    <Section title={t('settings.tools.findSkills')} search="Find skills GitHub search" description={t('settings.tools.findSkillsHint')}>
      <div className="inline">
        <input
          className="grow"
          aria-label={t('settings.tools.findSkills')}
          placeholder={t('settings.tools.findSkillsPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="btn" disabled={loading || !query.trim()} onClick={run}>
          {loading ? t('settings.tools.searching') : t('settings.tools.searchSkills')}
        </button>
      </div>
      {repos && repos.length === 0 && <p className="muted small">{t('settings.tools.noSkillRepos')}</p>}
      {repos && repos.length > 0 && (
        <div className="tool-list">
          {repos.map((r) => (
            <div key={r.repo}>
              <div className="tool-item">
                <code>{r.repo}</code>
                <span className="badge">★ {r.stars.toLocaleString()}</span>
                {r.license && <span className="badge">{r.license}</span>}
                <span className="muted small tool-desc" title={r.description}>
                  {r.description}
                </span>
                <button className="btn ghost" onClick={() => (open?.repo === r.repo ? setOpen(null) : browse(r.repo))} aria-expanded={open?.repo === r.repo}>
                  {open?.repo === r.repo ? t('settings.tools.hideSkills') : t('settings.tools.showSkills')}
                </button>
              </div>
              {open?.repo === r.repo && <div className="skill-found">{skillList(open.skills)}</div>}
            </div>
          ))}
        </div>
      )}
      {open && !repos && skillList(open.skills)}
    </Section>
  )
}
