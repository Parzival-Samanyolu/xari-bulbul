import { ruleMatches } from '../permissions/permissions.js'
import type { HookRule } from '../settings/schema.js'
import { runShell } from '../tools/spawn.js'
import type { Tool, ToolResult } from '../tools/types.js'

export interface HookContext {
  cwd: string
  shell: string
  signal: AbortSignal
  maxChars: number
}

export interface HookOutcome {
  /** A pre hook exited 2: don't run the call; this is the reason the model sees. */
  block?: string
  /** Text to add to the tool result (post hooks). */
  append?: string
  /** Hooks that failed for reasons other than exit 2, for a notice to the user. */
  warnings: string[]
}

function matches(rule: HookRule, tool: Tool, subject: string, cwd: string): boolean {
  if (!rule.enabled) return false
  const m = rule.match.trim()
  return m === '*' || ruleMatches(m, tool, subject, cwd)
}

/**
 * Runs the hooks that match one tool call, in order. Each gets the call as JSON on stdin and
 * HARNESS_TOOL / HARNESS_SUBJECT / HARNESS_CWD in its environment. Exit 2 means "block"
 * (pre) or "tell the model" (post), with stderr as the message; stdout of a post hook is added
 * to the result.
 */
export async function runHooks(
  kind: 'pre' | 'post',
  rules: HookRule[],
  tool: Tool,
  subject: string,
  input: unknown,
  ctx: HookContext,
  result?: ToolResult,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { warnings: [] }
  const appended: string[] = []
  for (const rule of rules) {
    if (ctx.signal.aborted) break
    if (!matches(rule, tool, subject, ctx.cwd)) continue
    const payload = JSON.stringify({
      event: kind === 'pre' ? 'pre_tool' : 'post_tool',
      tool: tool.name,
      subject,
      input,
      ...(result ? { result: { content: result.content, isError: !!result.isError } } : {}),
    })
    const r = await runShell(rule.command, {
      shell: ctx.shell,
      cwd: ctx.cwd,
      timeoutMs: rule.timeoutSec * 1000,
      signal: ctx.signal,
      stdin: payload,
      env: { ...process.env, HARNESS_TOOL: tool.name, HARNESS_SUBJECT: subject, HARNESS_CWD: ctx.cwd },
      maxChars: ctx.maxChars,
    })
    const label = `Hook "${rule.command.slice(0, 60)}"`
    if (r.error) {
      outcome.warnings.push(`${label} could not start: ${r.error.message}`)
      continue
    }
    if (r.killedFor === 'timeout') {
      outcome.warnings.push(`${label} timed out after ${rule.timeoutSec}s.`)
      continue
    }
    if (r.killedFor === 'abort') break
    const stderr = r.stderr.trim()
    if (r.code === 2) {
      if (kind === 'pre') {
        outcome.block = stderr || `Blocked by hook: ${rule.command}`
        break
      }
      appended.push(`Hook feedback:\n${stderr || '(no message)'}`)
      continue
    }
    if (r.code !== 0) {
      outcome.warnings.push(`${label} exited ${r.code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
      continue
    }
    const stdout = r.stdout.trim()
    if (kind === 'post' && stdout) appended.push(`Hook output:\n${stdout}`)
  }
  if (appended.length) outcome.append = appended.join('\n\n').slice(0, ctx.maxChars)
  return outcome
}
