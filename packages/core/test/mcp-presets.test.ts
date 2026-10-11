import { describe, expect, it } from 'vitest'
import { MCP_PRESETS, presetServer } from '../src/mcp/presets.js'
import { McpServerSchema } from '../src/settings/schema.js'

describe('MCP presets', () => {
  it('are valid server configs', () => {
    for (const p of MCP_PRESETS) expect(McpServerSchema.parse(p.server)).toEqual(p.server)
  })

  it('picks a free id when the preset id is taken', () => {
    const github = MCP_PRESETS.find((p) => p.id === 'github')!
    expect(presetServer(github, []).id).toBe('github')
    expect(presetServer(github, [{ ...github.server }]).id).toBe('github-2')
  })
})
