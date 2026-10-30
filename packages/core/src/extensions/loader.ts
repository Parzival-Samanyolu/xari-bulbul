import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { JsonSchema } from '../types.js'
import type { Tool, ToolContext, ToolKind, ToolResult } from '../tools/types.js'
import { changedPluginFiles, type PluginRoot } from '../plugins/install.js'

export const USER_EXT_DIR = path.join(os.homedir(), '.harness')
export const projectExtDir = (cwd: string) => path.join(cwd, '.harness')
/** Claude Code's folder; only its `skills/` is read. */
export const CLAUDE_DIR = path.join(os.homedir(), '.claude')

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
  skills: Skill[]
  errors: { file: string; error: string }[]
}

export interface SlashCommand {
  name: string
  description: string
  template: string
  source: 'user' | 'project'
  file: string
  /** Id of the plugin it came with. */
  plugin?: string
}

/**
 * A folder with a SKILL.md: instructions the agent loads with the `skill` tool before a matching task.
 *
 *   ---
 *   name: release
 *   description: How to cut a release of this app
 *   ---
 *   Steps…
 */
export interface Skill {
  name: string
  description: string
  dir: string
  file: string
  source: 'user' | 'project' | 'claude'
  /** Id of the plugin it came with. */
  plugin?: string
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

function adaptTool(mod: UserToolModule, source: 'user' | 'project', plugin?: string): Tool {
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
    ...(plugin ? { plugin } : {}),
  }
}

/** Splits `---` frontmatter from the body and reads simple `key: value` fields (quoted or folded with `>`/`|`). */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!fm) return { fields: {}, body: raw }
  const fields: Record<string, string> = {}
  const lines = fm[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    let value = m[2].trim()
    if (value === '' || value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      value = block.join(' ')
    }
    fields[m[1]] = unquote(value)
  }
  return { fields, body: raw.slice(fm[0].length) }
}

function unquote(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value)
    } catch {
      /* fall through */
    }
  }
  return value.replace(/^(["'])(.*)\1$/, '$2')
}

function parseCommand(file: string, source: 'user' | 'project', plugin?: string): SlashCommand {
  const { fields, body: template } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
  let description = fields.description ?? ''
  if (!description) description = template.trim().split('\n')[0].slice(0, 80)
  return { name: path.basename(file).replace(/\.md$/, ''), description, template, source, file, ...(plugin ? { plugin } : {}) }
}

function parseSkill(file: string, source: Skill['source'], plugin?: string): Skill {
  const { fields, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
  const dir = path.dirname(file)
  const name = fields.name || path.basename(dir)
  const description = fields.description || body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200)
  return { name, description, dir, file, source, ...(plugin ? { plugin } : {}) }
}

/** `<root>/skills/*\/SKILL.md` */
function loadSkills(root: string, source: Skill['source'], out: LoadedExtensions, plugin?: string) {
  let dirs: string[]
  try {
    dirs = fs.readdirSync(path.join(root, 'skills'))
  } catch {
    return
  }
  for (const d of dirs) {
    const file = path.join(root, 'skills', d, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    try {
      out.skills.push(parseSkill(file, source, plugin))
    } catch (e) {
      out.errors.push({ file, error: (e as Error).message })
    }
  }
}

/** A skill name as a folder name: `Cut a Release!` → `cut-a-release`. */
export function skillSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Writes `<skillsDir>/<slug>/SKILL.md`, replacing an existing skill with the same slug. */
export function writeSkill(skillsDir: string, s: { name: string; description: string; body: string }, source: Skill['source']): Skill {
  const name = skillSlug(s.name)
  if (!name) throw new Error('The skill name needs at least one letter or digit.')
  const description = s.description.replace(/\s+/g, ' ').trim()
  const dir = path.join(skillsDir, name)
  const file = path.join(dir, 'SKILL.md')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${s.body.trim()}\n`)
  return { name, description, dir, file, source }
}

export async function loadExtensions(
  cwd: string,
  opts: {
    user: boolean
    project: boolean
    userDir?: string
    claudeDir?: string
    /** Installed, turned-on plugins. Their tool code loads whatever `user`/`project` say: the user installed that reviewed pin. */
    plugins?: PluginRoot[]
  },
): Promise<LoadedExtensions> {
  const result: LoadedExtensions = { tools: [], commands: [], skills: [], errors: [] }
  // Skills are Markdown like commands, so they always load. Later roots win on a name clash.
  loadSkills(opts.claudeDir ?? CLAUDE_DIR, 'claude', result)
  const roots: { dir: string; source: 'user' | 'project'; allowCode: boolean; plugin?: PluginRoot }[] = [
    { dir: opts.userDir ?? USER_EXT_DIR, source: 'user', allowCode: opts.user },
    // Plugins sit between the user's own extensions and the project's.
    ...(opts.plugins ?? []).map((p) => ({ dir: p.dir, source: p.source, allowCode: true, plugin: p })),
    // Markdown commands are always safe to load; project *code* requires opt-in.
    { dir: projectExtDir(cwd), source: 'project' as const, allowCode: opts.project },
  ]
  for (const root of roots) {
    let tools = listFiles(path.join(root.dir, 'tools'), ['.mjs', '.js'])
    if (root.plugin) {
      // A plugin loads only as installed: changed files could be code nobody reviewed.
      if (!fs.existsSync(root.dir)) {
        result.errors.push({ file: root.dir, error: `Plugin "${root.plugin.id}" is missing. Reinstall or remove it in Settings › Plugins.` })
        continue
      }
      const changed = changedPluginFiles(root.dir, root.plugin.files)
      if (changed.length) {
        result.errors.push({ file: root.dir, error: `Plugin "${root.plugin.id}" was not loaded because files changed after it was installed (${changed.join(', ')}). Reinstall it in Settings › Plugins.` })
        continue
      }
      const listed = new Set(root.plugin.files.map((f) => path.join(root.dir, ...f.path.split('/'))))
      tools = tools.filter((f) => listed.has(f))
    }
    if (root.allowCode) {
      for (const file of tools) {
        try {
          // Cache-bust so edits are picked up on reload.
          const url = `${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`
          const mod = await import(/* @vite-ignore */ url)
          result.tools.push(adaptTool(mod.default ?? mod, root.source, root.plugin?.id))
        } catch (e) {
          result.errors.push({ file, error: (e as Error).message })
        }
      }
    }
    for (const file of listFiles(path.join(root.dir, 'commands'), ['.md'])) {
      try {
        result.commands.push(parseCommand(file, root.source, root.plugin?.id))
      } catch (e) {
        result.errors.push({ file, error: (e as Error).message })
      }
    }
    loadSkills(root.dir, root.source, result, root.plugin?.id)
  }
  const skills = new Map(result.skills.map((s) => [s.name, s]))
  result.skills = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
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
