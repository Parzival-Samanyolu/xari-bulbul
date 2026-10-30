import { SettingsSchema, defaultSettings, type McpServerConfig, type Settings } from './schema.js'

// Moving settings between machines: export without secrets or this machine's folders,
// import with validation, and reset to defaults. API keys never live in settings at all.

/** Env vars and headers whose values are likely secrets. */
const SECRET_NAME = /key|token|secret|password|passwd|auth|credential|cookie|session/i

function scrubServer(s: McpServerConfig): McpServerConfig {
  if (s.transport === 'stdio') return { ...s, env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, SECRET_NAME.test(k) ? '' : v])) }
  return { ...s, headers: Object.fromEntries(Object.entries(s.headers).filter(([k]) => !SECRET_NAME.test(k))) }
}

/** This machine's folders and window state; kept on import and reset, left out of exports. */
type LocalApp = Pick<Settings['app'], 'lastWorkspace' | 'openWorkspaces' | 'recentWorkspaces' | 'panels' | 'layoutChosen' | 'skippedPlugins' | 'collapsedProviders'>

function localApp(s: Settings): LocalApp {
  const { lastWorkspace, openWorkspaces, recentWorkspaces, panels, layoutChosen, skippedPlugins, collapsedProviders } = s.app
  return { lastWorkspace, openWorkspaces, recentWorkspaces, panels, layoutChosen, skippedPlugins, collapsedProviders }
}

/**
 * Settings as a shareable JSON object: no folder paths from this machine, no MCP servers that
 * installed plugins added (the plugin adds them again), and secret-looking MCP env values and
 * headers blanked.
 */
export function exportSettings(s: Settings): Record<string, unknown> {
  const out = structuredClone(s) as Settings
  const app = out.app as Partial<Settings['app']>
  delete app.lastWorkspace
  delete app.openWorkspaces
  delete app.recentWorkspaces
  delete app.panels
  out.mcp.servers = out.mcp.servers.filter((x) => !x.plugin).map(scrubServer)
  out.providers = out.providers.map((p) => ({ ...p, headers: Object.fromEntries(Object.entries(p.headers).filter(([k]) => !SECRET_NAME.test(k))) }))
  return out as unknown as Record<string, unknown>
}

export type ImportResult = { ok: true; settings: Settings } | { ok: false; errors: string[] }

/**
 * Validates an imported file against the schema. Nothing is applied when any field is wrong;
 * the errors name each field. This machine's folders and plugin MCP servers are kept.
 */
export function importSettings(raw: unknown, current: Settings): ImportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['The file is not a settings object.'] }
  // Any JSON object parses (every section has defaults), so a stray file would quietly reset everything.
  const known = Object.keys(SettingsSchema.shape)
  if (!Object.keys(raw).some((k) => known.includes(k))) return { ok: false, errors: ['The file has none of the settings sections, so it is probably not a settings file.'] }
  const res = SettingsSchema.safeParse(raw)
  if (!res.success) {
    const errors = res.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`)
    if (res.error.issues.length > 8) errors.push(`…and ${res.error.issues.length - 8} more.`)
    return { ok: false, errors }
  }
  return { ok: true, settings: restoreSecrets(keepLocal(res.data, current), current) }
}

/** Exports blank secret MCP env values and drop secret headers; importing on a machine that has them keeps them. */
function restoreSecrets(next: Settings, current: Settings): Settings {
  const servers = next.mcp.servers.map((s): McpServerConfig => {
    const mine = current.mcp.servers.find((c) => c.id === s.id && c.transport === s.transport)
    if (!mine) return s
    if (s.transport === 'stdio' && mine.transport === 'stdio')
      return { ...s, env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, v === '' && mine.env[k] ? mine.env[k] : v])) }
    if (s.transport === 'http' && mine.transport === 'http') return { ...s, headers: { ...Object.fromEntries(Object.entries(mine.headers).filter(([k]) => SECRET_NAME.test(k))), ...s.headers } }
    return s
  })
  const providers = next.providers.map((p) => {
    const mine = current.providers.find((c) => c.id === p.id)
    return mine ? { ...p, headers: { ...Object.fromEntries(Object.entries(mine.headers).filter(([k]) => SECRET_NAME.test(k))), ...p.headers } } : p
  })
  return { ...next, providers, mcp: { ...next.mcp, servers } }
}

/** Every setting back to its default, keeping this machine's folders and plugin MCP servers. */
export function resetSettings(current: Settings): Settings {
  return keepLocal(defaultSettings(), current)
}

function keepLocal(next: Settings, current: Settings): Settings {
  const plugins = current.mcp.servers.filter((s) => s.plugin)
  return {
    ...next,
    app: { ...next.app, ...localApp(current) },
    mcp: { ...next.mcp, servers: [...next.mcp.servers.filter((s) => !s.plugin), ...plugins] },
  }
}
