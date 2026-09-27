import path from 'node:path'
import type { PermissionMode } from '../types.js'
import { destructiveReason } from './destructive.js'
import { isInside, resolvePath, toPosix, type Tool } from '../tools/types.js'

export interface PermissionConfig {
  mode: PermissionMode
  allow: string[]
  deny: string[]
  allowOutsideWorkspace: boolean
  /** Ask before destructive shell commands (rm, git reset --hard, …) in every mode. Default true. */
  confirmDestructive?: boolean
}

export type Verdict = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string }

/** What the user answers when asked. */
export type PermissionAnswer =
  | { type: 'allow' }
  | { type: 'allowAlways' } // adds a session rule for this tool + subject
  | { type: 'deny'; feedback?: string }

interface ParsedRule {
  tool: string
  pattern?: RegExp
}

/** `bash(npm test*)`, `write_file(src/**)`, `edit_file`. */
export function parseRule(rule: string, isCommand = false): ParsedRule | null {
  const m = /^\s*([\w.-]+)\s*(?:\((.*)\))?\s*$/.exec(rule)
  if (!m) return null
  return { tool: m[1], pattern: m[2] !== undefined ? globToRegex(m[2], isCommand) : undefined }
}

/** `**` matches anything; `*` matches anything for commands, a single path segment for paths. */
export function globToRegex(glob: string, isCommand: boolean): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // `**/` also matches zero dirs
      } else re += isCommand ? '.*' : '[^/]*'
    } else if (c === '?') re += isCommand ? '.' : '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 's')
}

export function ruleMatches(rule: string, tool: Tool, subject: string, cwd: string): boolean {
  const parsed = parseRule(rule, tool.kind === 'exec')
  if (!parsed || parsed.tool !== tool.name) return false
  if (!parsed.pattern) return true
  const candidates = [subject.trim()]
  if (tool.kind === 'read' || tool.kind === 'edit') {
    const abs = resolvePath(cwd, subject)
    candidates.push(toPosix(abs), toPosix(path.relative(cwd, abs)))
  }
  return candidates.some((c) => parsed.pattern!.test(c))
}

export function ruleFor(tool: Tool, subject: string): string {
  if (tool.kind === 'exec') {
    // Allow the same command "family": first word(s) + wildcard.
    const words = subject.trim().split(/\s+/)
    const prefix = words.slice(0, Math.min(2, words.length)).join(' ')
    return `${tool.name}(${prefix}*)`
  }
  if (tool.kind === 'edit') return `${tool.name}(${subject})`
  return tool.name
}

export class Permissions {
  /** Rules granted with "always allow" during this session. */
  readonly sessionAllow: string[] = []

  constructor(
    private config: PermissionConfig,
    private cwd: string,
  ) {}

  update(config: PermissionConfig) {
    this.config = config
  }

  get mode(): PermissionMode {
    return this.config.mode
  }

  setMode(mode: PermissionMode) {
    this.config = { ...this.config, mode }
  }

  check(tool: Tool, subject: string): Verdict {
    const { mode, allow, deny } = this.config
    if (deny.some((r) => ruleMatches(r, tool, subject, this.cwd))) {
      return { decision: 'deny', reason: `Blocked by a deny rule in Settings → Permissions.` }
    }
    if (tool.readOnly) return { decision: 'allow' }
    if (mode === 'plan') {
      return { decision: 'deny', reason: 'Plan mode is read-only. Present a plan instead of making changes.' }
    }
    const outside =
      tool.kind === 'edit' && !this.config.allowOutsideWorkspace && !isInside(this.cwd, resolvePath(this.cwd, subject))
    if (outside) return { decision: 'ask', reason: 'Writes outside the workspace folder.' }
    // Destructive commands ask even in auto mode; only a rule the user wrote in Settings skips that.
    const destructive = this.destructive(tool, subject)
    if (destructive) {
      if (allow.some((r) => ruleMatches(r, tool, subject, this.cwd))) return { decision: 'allow' }
      return { decision: 'ask', reason: `${destructive}. This can't be undone.` }
    }
    if ([...allow, ...this.sessionAllow].some((r) => ruleMatches(r, tool, subject, this.cwd))) return { decision: 'allow' }
    if (mode === 'auto') return { decision: 'allow' }
    if (mode === 'acceptEdits' && tool.kind === 'edit') return { decision: 'allow' }
    return { decision: 'ask', reason: tool.kind === 'exec' ? 'Runs a shell command.' : 'Modifies files.' }
  }

  private destructive(tool: Tool, subject: string): string | null {
    if (tool.kind !== 'exec' || this.config.confirmDestructive === false) return null
    return destructiveReason(subject)
  }

  /** The rule "always allow" would add, or '' when only a one-time allow is offered. */
  suggestRule(tool: Tool, subject: string): string {
    return this.destructive(tool, subject) ? '' : ruleFor(tool, subject)
  }

  /** Grants a session rule for "always allow". Destructive commands are only ever allowed once. */
  remember(tool: Tool, subject: string): string {
    const rule = ruleFor(tool, subject)
    if (this.destructive(tool, subject)) return rule
    if (!this.sessionAllow.includes(rule)) this.sessionAllow.push(rule)
    return rule
  }
}
