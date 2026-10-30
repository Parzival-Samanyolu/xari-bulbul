import path from 'node:path'
import { z } from 'zod'
import type { Skill } from '../extensions/loader.js'
import type { MemoryAccess } from '../memory/store.js'
import type { Session, SessionMeta } from '../sessions/store.js'
import type { BrowserAccess } from './browser.js'
import type { JobRegistry } from './jobs.js'
import type { WebSearchConfig } from './web-search.js'
import type { ImageAttachment, JsonSchema, TodoItem } from '../types.js'

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
  /** Which search backend web_search uses, with its key. Defaults to DuckDuckGo. */
  webSearch?: WebSearchConfig
  /** Skills the agent can load, and where save_skill writes; absent when skills are off. */
  skills?: SkillAccess
  /** Saved chats, for session_search; absent when the host keeps none. */
  sessions?: SessionAccess
  /** Background shell jobs owned by this agent. */
  jobs?: JobRegistry
  /** The agent's browser, launched on first use; absent when the browser tools are off. */
  browser?: BrowserAccess
  /** Runs a subagent; provided by the agent loop when subagents are enabled. */
  runSubagent?(input: SubagentInput): Promise<ToolResult>
  /** Asks the user a question and waits for the answer; absent where nobody can answer (headless, subagents). */
  askUser?(question: UserQuestion): Promise<string>
  /** Records a file's content before an edit tool changes it, so the turn can be reverted. `null` = it didn't exist. */
  checkpoint?(abs: string, before: string | null): void
  /** Run a quick syntax/lint check on files after editing them. */
  checkAfterEdit?: boolean
  /** How long that check may run. */
  checkTimeoutSec?: number
}

export interface SkillAccess {
  list: Skill[]
  /** The skills folders save_skill writes to (`~/.harness/skills`, `<project>/.harness/skills`). */
  dirs: { user: string; project: string }
  /** Makes a just-saved skill loadable for the rest of the chat. */
  added?(skill: Skill): void
}

export interface SessionAccess {
  /** Saved chats, newest first; only those in `cwd` when given. */
  list(opts?: { cwd?: string }): SessionMeta[]
  load(id: string): Session | null
  /** The chat doing the search, left out of the results. */
  exclude?: string
}

export interface UserQuestion {
  question: string
  options: string[]
  multiSelect?: boolean
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
  /** Images for the model (screenshots). Only return them when the model accepts images. */
  images?: ImageAttachment[]
}

export interface Tool<I = any> {
  name: string
  description: string
  parameters: JsonSchema
  kind: ToolKind
  readOnly: boolean
  /** Runs without asking (outside plan mode) even though it writes: it only saves the agent's own notes. */
  autoAllow?: boolean
  /** Validates/normalizes raw model input; throw to reject. */
  parse(input: unknown): I
  /** Short human label, also the subject for permission rules (a path or a command). */
  subject(input: I): string
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
  /** Where the tool came from, for the UI. */
  source?: 'builtin' | 'user' | 'project' | 'mcp'
  /** Id of the plugin it came with. */
  plugin?: string
}

/** Helper for built-in tools: zod input → JSON schema + validation. */
export function defineTool<S extends z.ZodType>(def: {
  name: string
  description: string
  input: S
  kind: ToolKind
  readOnly: boolean
  autoAllow?: boolean
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
    autoAllow: def.autoAllow,
    parse: (input) => {
      let res = def.input.safeParse(input)
      const clamped = res.success ? null : clampNumbers(input, res.error.issues)
      if (clamped) res = def.input.safeParse(clamped)
      if (!res.success) throw new Error(`Invalid input: ${z.prettifyError(res.error)}`)
      return res.data
    },
    subject: def.subject,
    execute: def.execute,
    source: 'builtin',
  }
}

/**
 * When every problem is a number out of range, a copy of `input` with those numbers moved to the
 * nearest allowed value. Models often overshoot limits (gpt-oss sends `timeout_sec: 10000`, as if
 * it were milliseconds); running the call with the limit beats failing it. Otherwise null.
 */
export function clampNumbers(input: unknown, issues: z.core.$ZodIssue[]): unknown {
  if (!issues.length || typeof input !== 'object' || input === null) return null
  const copy = structuredClone(input) as Record<PropertyKey, unknown>
  for (const issue of issues) {
    if ((issue.code !== 'too_big' && issue.code !== 'too_small') || issue.origin !== 'number' || !issue.path.length) return null
    const bound = Number(issue.code === 'too_big' ? issue.maximum : issue.minimum)
    let parent: Record<PropertyKey, unknown> = copy
    for (const key of issue.path.slice(0, -1)) parent = parent[key] as Record<PropertyKey, unknown>
    const key = issue.path[issue.path.length - 1]
    if (typeof parent?.[key] !== 'number') return null
    // An exclusive bound can't be reached; integers step by one, anything else is left to fail.
    if (!issue.inclusive) return null
    parent[key] = bound
  }
  return copy
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

/** A file system error as a tool result: "not found" only when it really is missing. */
export function fsErrorText(err: unknown, abs: string, kind: 'File' | 'Directory'): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return `${kind} not found: ${abs}`
  if ((code === 'EPERM' || code === 'EACCES') && process.platform === 'darwin')
    return `Permission denied: ${abs}. macOS blocks this app from the folder; the user can allow it in System Settings → Privacy & Security → Files and Folders.`
  if (code === 'EPERM' || code === 'EACCES') return `Permission denied: ${abs}`
  return `Cannot read ${abs}: ${(err as Error)?.message ?? String(err)}`
}
