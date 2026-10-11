import type { McpServerConfig } from '../settings/schema.js'

/** A well-known MCP server the settings can add in one click. */
export interface McpPreset {
  /** Also the server id and name it is added under. */
  id: string
  label: string
  description: string
  server: McpServerConfig
  /** Where to get the bearer token, for servers that need one. */
  token?: { hint: string; url: string }
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'github',
    label: 'GitHub',
    description: "GitHub's hosted server: repositories, issues, pull requests, Actions and code search.",
    server: { id: 'github', name: 'github', enabled: true, transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: {} },
    token: {
      hint: 'A personal access token (or the output of `gh auth token`)',
      url: 'https://github.com/settings/personal-access-tokens/new',
    },
  },
]

/** The server config for a preset, with an id that doesn't clash with existing servers. */
export function presetServer(preset: McpPreset, existing: McpServerConfig[]): McpServerConfig {
  let id = preset.server.id
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${preset.server.id}-${n}`
  return { ...preset.server, id }
}
