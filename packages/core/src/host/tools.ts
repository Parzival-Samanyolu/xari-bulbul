import { builtinTools } from '../tools/index.js'
import type { Tool } from '../tools/types.js'

/**
 * Built-in tools, then extension tools, then MCP tools. A later tool whose name is already
 * taken is skipped and reported, so an extension can never shadow `bash` or `edit_file`.
 */
export function assembleTools(extensions: Tool[], mcp: Tool[] = [], builtin: Tool[] = builtinTools()): { tools: Tool[]; conflicts: string[] } {
  const tools = [...builtin]
  const names = new Set(tools.map((t) => t.name))
  const conflicts: string[] = []
  for (const t of [...extensions, ...mcp]) {
    if (names.has(t.name)) conflicts.push(t.name)
    else {
      names.add(t.name)
      tools.push(t)
    }
  }
  return { tools, conflicts }
}
