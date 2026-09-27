import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { JsonSchema } from '../types.js'
import type { Tool, ToolContext, ToolKind, ToolResult } from '../tools/types.js'

export const USER_EXT_DIR = path.join(os.homedir(), '.harness')
export const projectExtDir = (cwd: string) => path.join(cwd, '.harness')

/**
 * Shape of a user tool file (`~/.harness/tools/my-tool.mjs`):
 *
 *   export default {
 *     name: 'my_tool',
 *     description: 'What it does, for the model',
 *     parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
 *     readOnly: false,            // optional (default false → asks permission)
 *     kind: 'exec',               // optional: read | edit | exec | network | other
 *     async execute(input, ctx) { return 'result text' }  // or { content, isError }
 *   }
 */
export interface UserToolModule {
  name: string
  description: string
  parameters?: JsonSchema
  readOnly?: boolean
  kind?: ToolKind
  subject?: (input: any) => string
  execute: (input: any, ctx: ToolContext) => Promise<string | ToolResult> | string | ToolResult
}

export interface LoadedExtensions {
  tools: Tool[]
  commands: SlashCommand[]
  errors: { file: string; error: string }[]
}

export interface SlashCommand {
  name: string
  description: string
  template: string
  source: 'user' | 'project'
  file: string
}

function listFiles(dir: string, exts: string[]): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

function adaptTool(mod: UserToolModule, source: 'user' | 'project'): Tool {
  if (!mod || typeof mod.name !== 'string' || typeof mod.execute !== 'function') {
    throw new Error('Tool module must default-export { name, description, execute }')
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(mod.name)) throw new Error(`Invalid tool name "${mod.name}"`)
  return {
    name: mod.name,
    description: mod.description ?? '',
    parameters: mod.parameters ?? { type: 'object', properties: {} },
    kind: mod.kind ?? 'other',
    readOnly: mod.readOnly ?? false,
    parse: (input) => (input && typeof input === 'object' ? input : {}),
    subject: mod.subject ?? ((input) => JSON.stringify(input).slice(0, 200)),
    async execute(input, ctx) {
      const r = await mod.execute(input, ctx)
      return typeof r === 'string' ? { content: r } : r
    },
    source,
  }
}

function parseCommand(file: string, source: 'user' | 'project'): SlashCommand {
  const raw = fs.readFileSync(file, 'utf8')
  let description = ''
  let template = raw
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (fm) {
    template = raw.slice(fm[0].length)
    description = /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim() ?? ''
  }
  if (!description) description = template.trim().split('\n')[0].slice(0, 80)
  return { name: path.basename(file).replace(/\.md$/, ''), description, template, source, file }
}

export async function loadExtensions(
  cwd: string,
  opts: { user: boolean; project: boolean; userDir?: string },
): Promise<LoadedExtensions> {
  const result: LoadedExtensions = { tools: [], commands: [], errors: [] }
  const roots: { dir: string; source: 'user' | 'project'; allowCode: boolean }[] = [
    { dir: opts.userDir ?? USER_EXT_DIR, source: 'user', allowCode: opts.user },
    // Markdown commands are always safe to load; project *code* requires opt-in.
    { dir: projectExtDir(cwd), source: 'project', allowCode: opts.project },
  ]
  for (const root of roots) {
    if (root.allowCode) {
      for (const file of listFiles(path.join(root.dir, 'tools'), ['.mjs', '.js'])) {
        try {
          // Cache-bust so edits are picked up on reload.
          const url = `${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`
          const mod = await import(/* @vite-ignore */ url)
          result.tools.push(adaptTool(mod.default ?? mod, root.source))
        } catch (e) {
          result.errors.push({ file, error: (e as Error).message })
        }
      }
    }
    for (const file of listFiles(path.join(root.dir, 'commands'), ['.md'])) {
      try {
        result.commands.push(parseCommand(file, root.source))
      } catch (e) {
        result.errors.push({ file, error: (e as Error).message })
      }
    }
  }
  // Project commands override user commands with the same name.
  const byName = new Map(result.commands.map((c) => [c.name, c]))
  result.commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return result
}

/** `/review src/app.ts` → the command template with $ARGUMENTS filled in. Returns null if not a command. */
export function expandSlashCommand(input: string, commands: SlashCommand[]): string | null {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!m) return null
  const cmd = commands.find((c) => c.name === m[1])
  if (!cmd) return null
  const args = (m[2] ?? '').trim()
  return cmd.template.includes('$ARGUMENTS')
    ? cmd.template.replaceAll('$ARGUMENTS', args)
    : args
      ? `${cmd.template.trim()}\n\n${args}`
      : cmd.template.trim()
}
