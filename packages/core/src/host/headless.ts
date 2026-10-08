import { Agent, type AgentEvent, type AgentOptions, type PermissionRequest, type TurnEndReason } from '../loop/agent.js'
import type { UsageTotals } from '../usage/tracker.js'

export type HeadlessFormat = 'text' | 'json' | 'stream-json'

/** Process exit codes for `xb -p`. */
export const EXIT = { ok: 0, error: 1, usage: 2, budget: 3, maxSteps: 4, interrupted: 130 } as const

export function exitCodeFor(reason: TurnEndReason): number {
  switch (reason) {
    case 'done':
      return EXIT.ok
    case 'budget':
      return EXIT.budget
    case 'max_steps':
      return EXIT.maxSteps
    case 'aborted':
      return EXIT.interrupted
    default:
      return EXIT.error
  }
}

export interface HeadlessOptions {
  prompt: string
  format: HeadlessFormat
  /** Everything the Agent needs except the interactive parts. */
  agent: Omit<AgentOptions, 'askPermission' | 'onEvent'>
  /** stdout and stderr writers. */
  out: (s: string) => void
  err: (s: string) => void
  signal?: AbortSignal
}

export interface HeadlessResult {
  exitCode: number
  reason: TurnEndReason
  text: string
  denied: PermissionRequest[]
}

/**
 * One non-interactive turn. Nobody can answer approval prompts, so anything that would ask is
 * denied (and reported): pick the mode and allow rules up front, e.g. `--mode auto`.
 */
export async function runHeadless(o: HeadlessOptions): Promise<HeadlessResult> {
  const started = Date.now()
  const denied: PermissionRequest[] = []
  let finalText = ''
  let steps = 0
  let lastError = ''
  const json = (v: unknown) => o.out(JSON.stringify(v) + '\n')

  const onEvent = (e: AgentEvent) => {
    if (o.format === 'stream-json') json(streamEvent(e))
    switch (e.type) {
      case 'text':
        finalText += e.delta
        if (o.format === 'text') o.out(e.delta)
        break
      case 'stream_reset':
        finalText = ''
        break
      case 'message':
        if (e.message.role === 'assistant') {
          steps++
          // The reply that counts is the last one; earlier text was narration between tool calls.
          if (e.message.toolCalls?.length) {
            if (o.format === 'text' && e.message.content.trim()) o.out('\n')
            finalText = ''
          }
        }
        break
      case 'tool_start':
        if (o.format === 'text') o.err(`• ${e.name} ${e.subject}\n`)
        break
      case 'notice':
        if (o.format !== 'stream-json') o.err(`${e.level === 'warn' ? 'warning' : 'note'}: ${e.text}\n`)
        break
      case 'error':
        lastError = e.message
        if (o.format !== 'stream-json') o.err(`error: ${e.message}\n`)
        break
    }
  }

  const agent = new Agent({
    ...o.agent,
    onEvent,
    askPermission: async (req) => {
      denied.push(req)
      if (o.format !== 'stream-json') o.err(`denied (no one to ask): ${req.tool} ${req.subject}: ${req.reason}\n`)
      return {
        type: 'deny',
        feedback: 'This is a non-interactive run, so nobody can approve this. Do without it if you can, and say in your reply what you could not do.',
      }
    },
  })
  const onAbort = () => agent.stop()
  o.signal?.addEventListener('abort', onAbort)
  let reason: TurnEndReason
  try {
    reason = await agent.send(o.prompt)
  } finally {
    o.signal?.removeEventListener('abort', onAbort)
    agent.dispose()
  }
  const exitCode = exitCodeFor(reason)
  if (o.format === 'text' && finalText && !finalText.endsWith('\n')) o.out('\n')
  if (o.format !== 'text') {
    const usage: UsageTotals = o.agent.usage.summary(agent.session.meta.id).session
    json({
      type: 'result',
      is_error: exitCode !== 0,
      reason,
      exit_code: exitCode,
      result: finalText.trim(),
      error: lastError || undefined,
      session_id: agent.session.meta.id,
      model: `${agent.model.providerId}:${agent.model.modelId}`,
      steps,
      duration_ms: Date.now() - started,
      usage: {
        requests: usage.requests,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cached_tokens: usage.cachedTokens,
        cost_usd: usage.costPartial && usage.cost === 0 ? null : usage.cost,
      },
      denied: denied.map((d) => ({ tool: d.tool, subject: d.subject, reason: d.reason })),
    })
  }
  return { exitCode, reason, text: finalText.trim(), denied }
}

/** AgentEvents as JSON lines; large or internal fields are trimmed. */
function streamEvent(e: AgentEvent): unknown {
  switch (e.type) {
    case 'message':
      return { type: 'message', index: e.index, message: e.message }
    case 'tool_end':
      return { type: 'tool_end', callId: e.callId, name: e.name, isError: !!e.result.isError, denied: !!e.denied, durationMs: e.durationMs, content: e.result.content }
    case 'usage':
      return { type: 'usage', record: e.record, contextTokens: e.contextTokens, contextLength: e.contextLength }
    default:
      return e
  }
}
