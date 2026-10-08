import fs from 'node:fs'
import type { ToolKind } from '../tools/types.js'
import { resolvePath } from '../tools/types.js'
import type { PermissionMode, TodoItem } from '../types.js'

const MODE_NAMES: Record<PermissionMode, string> = {
  ask: 'Ask (every edit and command needs approval)',
  acceptEdits: 'Auto-edit (edits apply without asking; commands still ask)',
  plan: 'Plan (read-only: investigate and present a plan, change nothing)',
  auto: 'Full auto (edits and commands run without asking; destructive ones still ask)',
}

/** Steps without a todo update, while items are open, before a nudge. */
const TODO_STALE_STEPS = 6
/** Steps in one turn without any checklist before suggesting one. */
const NO_TODO_STEPS = 10
const MAX_TRACKED = 200

export interface ReminderState {
  mode: PermissionMode
  todos: TodoItem[]
  hasTodoTool: boolean
  budget: { label: string; spent: number; limit: number }[]
  context: { used: number; length: number }
}

/**
 * Decides which `<system-reminder>` notes the model gets before its next request.
 * Each condition fires once until it resets, so reminders never pile up.
 */
export class Reminders {
  private mode: PermissionMode | null = null
  private stepsSinceTodo = 0
  private stepsThisTurn = 0
  private suggestedTodos = false
  private budgetWarned = new Set<string>()
  private contextWarned = false
  /** mtimes of files the agent read or wrote, to spot edits made by someone else. */
  private mtimes = new Map<string, number>()

  /** `mode` seeds the mode seen by the model on its first turn; later switches produce a reminder. */
  startTurn(mode: PermissionMode) {
    this.mode ??= mode
    this.stepsThisTurn = 0
    this.suggestedTodos = false
  }

  afterTool(name: string, kind: ToolKind | undefined, input: unknown, cwd: string) {
    if (name === 'todo_write') this.stepsSinceTodo = 0
    const p = (input as { path?: unknown } | undefined)?.path
    if ((kind === 'read' || kind === 'edit') && typeof p === 'string' && (name === 'read_file' || kind === 'edit')) {
      const abs = resolvePath(cwd, p)
      const m = mtime(abs)
      if (m !== null) {
        this.mtimes.delete(abs)
        this.mtimes.set(abs, m)
        if (this.mtimes.size > MAX_TRACKED) this.mtimes.delete(this.mtimes.keys().next().value!)
      }
    }
  }

  collect(s: ReminderState): string[] {
    const out: string[] = []
    this.stepsSinceTodo++
    this.stepsThisTurn++

    if (this.mode !== null && this.mode !== s.mode) out.push(`The user switched the permission mode to ${MODE_NAMES[s.mode]}. Follow the new mode from now on.`)
    this.mode = s.mode

    const open = s.todos.filter((t) => t.status !== 'completed')
    if (s.hasTodoTool && open.length && this.stepsSinceTodo > TODO_STALE_STEPS) {
      this.stepsSinceTodo = 0
      out.push(
        `Your checklist has not been updated for a while. Open items:\n${open.map((t) => `- [${t.status}] ${t.content}`).join('\n')}\nIf any are done, mark them completed with todo_write; keep exactly one in progress. Do not mention this reminder to the user.`,
      )
    } else if (s.hasTodoTool && !s.todos.length && !this.suggestedTodos && this.stepsThisTurn > NO_TODO_STEPS) {
      this.suggestedTodos = true
      out.push('This task is taking several steps. If it has more than a couple of parts, track them with todo_write so the user can follow along. Do not mention this reminder to the user.')
    }

    const changed: string[] = []
    for (const [file, seen] of this.mtimes) {
      const now = mtime(file)
      if (now === null || now === seen) continue
      this.mtimes.set(file, now)
      changed.push(file)
    }
    if (changed.length) {
      out.push(
        `These files changed on disk since you last read or wrote them (the user or another program edited them):\n${changed.map((f) => `- ${f}`).join('\n')}\nRead them again before editing; do not undo the changes unless asked.`,
      )
    }

    for (const b of s.budget) {
      if (b.limit > 0 && b.spent >= b.limit * 0.8 && !this.budgetWarned.has(b.label)) {
        this.budgetWarned.add(b.label)
        out.push(`The ${b.label} budget is nearly used: $${b.spent.toFixed(4)} of $${b.limit.toFixed(2)}. Work efficiently and finish the most important part first.`)
      }
    }

    const ratio = s.context.length ? s.context.used / s.context.length : 0
    if (ratio >= 0.7 && !this.contextWarned) {
      this.contextWarned = true
      out.push(`The context window is ${Math.round(ratio * 100)}% full; older messages will soon be summarized. Avoid reading large files whole; use offset/limit and targeted searches.`)
    } else if (ratio < 0.5) this.contextWarned = false

    return out
  }
}

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}
