import path from 'node:path'
import { z } from 'zod'
import type { MemoryAccess } from '../memory/store.js'
import type { JsonSchema, TodoItem } from '../types.js'

export type ToolKind = 'read' | 'edit' | 'exec' | 'network' | 'other'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Absolute paths the agent has read this session (edit_file requires a prior read). */
  readFiles: Set<string>
  toolOutputMaxChars: number
  bashTimeoutSec: number
  shell: string
  setTodos(todos: TodoItem[]): void
  /** Streamed progress text (e.g. live bash output). */
  progress(text: string): void
  /** Saved facts for this workspace; absent when memory is off. */
  memory?: MemoryAccess
  /** Runs a subagent; provided by the agent loop when subagents are enabled. */
  runSubagent?(input: SubagentInput): Promise<ToolResult>
}

export interface SubagentInput {
  description: string
  prompt: string
  type: 'explore' | 'general'
}

export type ToolDisplay =
  | { kind: 'diff'; path: string; patch: string; added: number; removed: number }
  | { kind: 'text'; text: string }

export interface ToolResult {
  content: string
  isError?: boolean
  display?: ToolDisplay
}

export interface Tool<I = any> {
  name: string
  description: string
  parameters: JsonSchema
  kind: ToolKind
  readOnly: boolean
  /** Validates/normalizes raw model input; throw to reject. */
  parse(input: unknown): I
  /** Short human label, also the subject for permission rules (a path or a command). */
  subject(input: I): string
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
  /** Where the tool came from, for the UI. */
  source?: 'builtin' | 'user' | 'project' | 'mcp'
}

/** Helper for built-in tools: zod input → JSON schema + validation. */
export function defineTool<S extends z.ZodType>(def: {
  name: string
  description: string
  input: S
  kind: ToolKind
  readOnly: boolean
  subject: (input: z.infer<S>) => string
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>
}): Tool<z.infer<S>> {
  const schema = z.toJSONSchema(def.input) as JsonSchema
  delete schema.$schema
  return {
    name: def.name,
    description: def.description,
    parameters: schema,
    kind: def.kind,
    readOnly: def.readOnly,
    parse: (input) => {
      const res = def.input.safeParse(input)
      if (!res.success) throw new Error(`Invalid input: ${z.prettifyError(res.error)}`)
      return res.data
    },
    subject: def.subject,
    execute: def.execute,
    source: 'builtin',
  }
}

export function resolvePath(cwd: string, p: string): string {
  const expanded = p.startsWith('~') ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', p.slice(1)) : p
  return path.resolve(cwd, expanded)
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Keep head and tail of oversized output so errors at the end aren't lost. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters truncated] …\n\n${text.slice(-tail)}`
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}
