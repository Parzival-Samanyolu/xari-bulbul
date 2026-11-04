import { createHash } from 'node:crypto'

/** An identical call (same tool, same arguments, same result) seen this many times in the window gets a nudge. */
export const REPEAT_NUDGE_AT = 3
/** After the nudge, a repeat reaching this count stops the turn. */
export const REPEAT_STOP_AT = 5
/** How many recent tool calls are compared. */
const CALL_WINDOW = 12
/** How many recent assistant texts are compared. */
const TEXT_WINDOW = 8
/** Shorter texts ("Let me check.") repeat naturally and are ignored. */
const MIN_TEXT_CHARS = 40
/** Word-set overlap at which two texts count as the same. */
const TEXT_SIMILARITY = 0.9

export interface StepRecord {
  /** The assistant's text for the step. */
  text: string
  /** Each call with its result, in order. */
  calls: { name: string; arguments: string; result: string }[]
}

export type RepeatVerdict = { action: 'ok' } | { action: 'nudge' | 'stop'; what: string; count: number }

/**
 * Notices when the model is stuck: the same tool call coming back with the same result, or the
 * same text, over and over within one turn. The first time it suggests a nudge; if the
 * repetition goes on after that, it says to stop.
 */
export class RepeatGuard {
  private calls: string[] = []
  private texts: { words: Set<string>; norm: string }[] = []
  private nudged = false

  startTurn() {
    this.calls = []
    this.texts = []
    this.nudged = false
  }

  /** Records a finished step (after its tool results are in) and says what to do. */
  observe(step: StepRecord): RepeatVerdict {
    let worst: { what: string; count: number } | null = null
    const consider = (what: string, count: number) => {
      if (count >= REPEAT_NUDGE_AT && (!worst || count > worst.count)) worst = { what, count }
    }

    for (const c of step.calls) {
      const key = `${c.name}\u0000${normalizeArgs(c.arguments)}\u0000${hash(c.result)}`
      this.calls.push(key)
      if (this.calls.length > CALL_WINDOW) this.calls.shift()
      consider(`the same ${c.name} call`, this.calls.filter((k) => k === key).length)
    }

    const norm = normalizeText(step.text)
    if (norm.length >= MIN_TEXT_CHARS) {
      const words = new Set(norm.split(' '))
      const count = 1 + this.texts.filter((t) => t.norm === norm || similarity(t.words, words) >= TEXT_SIMILARITY).length
      this.texts.push({ words, norm })
      if (this.texts.length > TEXT_WINDOW) this.texts.shift()
      consider('the same message', count)
    }

    if (!worst) return { action: 'ok' }
    const { what, count } = worst
    if (!this.nudged) {
      this.nudged = true
      return { action: 'nudge', what, count }
    }
    return count >= REPEAT_STOP_AT ? { action: 'stop', what, count } : { action: 'ok' }
  }
}

/** The `<system-reminder>` text the model gets on the first detection. */
export function repeatNudge(what: string, count: number): string {
  return `You have repeated ${what} ${count} times with the same result; you are going in circles. Repeating it again will not give a different answer. Change your approach (different tool, different arguments, or a different plan), or stop and tell the user plainly what is blocking you. Do not mention this reminder to the user.`
}

function normalizeArgs(raw: string): string {
  const text = raw.trim()
  if (!text) return '{}'
  try {
    return stableStringify(JSON.parse(text))
  } catch {
    return text.replace(/\s+/g, ' ')
  }
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`
  }
  return typeof v === 'string' ? JSON.stringify(v.trim()) : JSON.stringify(v)
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared || 1)
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}
