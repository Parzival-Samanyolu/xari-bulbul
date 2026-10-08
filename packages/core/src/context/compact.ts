import type { ChatMessage } from '../types.js'
import { userText } from '../providers/openai-compat.js'

/** Rough per-image token cost, for estimates only. */
const IMAGE_TOKENS = 1000
import type { Provider } from '../providers/types.js'

/** Rough token estimate (~4 chars per token) for when the provider hasn't told us yet. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.role === 'user' ? userText(m).length + (m.images?.length ?? 0) * IMAGE_TOKENS * 4 : m.content.length
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) chars += c.arguments.length + c.name.length
  }
  return Math.ceil(chars / 4)
}

/**
 * Choose where to split history: everything before the index gets summarized.
 * The split always lands on a user message so tool calls and their results stay paired.
 * Keeps at least the last `keepTurns` user turns verbatim.
 */
export function compactionSplit(messages: ChatMessage[], keepTurns = 2): number {
  const userIdx = messages.flatMap((m, i) => (m.role === 'user' && !m.synthetic ? [i] : []))
  if (userIdx.length <= keepTurns) {
    // One long turn: summarize the first half, splitting where a new assistant step begins.
    for (let i = Math.ceil(messages.length / 2); i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i - 1].role !== 'assistant') return i
    }
    return 0
  }
  return userIdx[userIdx.length - keepTurns]
}

function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'tool') return `[tool result: ${m.name}]\n${m.content.slice(0, 2000)}`
      if (m.role === 'assistant') {
        const calls = (m.toolCalls ?? []).map((c) => `[tool call: ${c.name} ${c.arguments.slice(0, 500)}]`).join('\n')
        return `[assistant]\n${m.content}\n${calls}`.trim()
      }
      if (m.role === 'user') {
        const images = m.images?.length ? `\n[${m.images.length} image(s) attached: ${m.images.map((i) => i.name).join(', ')}]` : ''
        return `[user]\n${userText(m).slice(0, 8000)}${images}`
      }
      return `[${m.role}]\n${m.content}`
    })
    .join('\n\n')
}

const SUMMARY_PROMPT = `Summarize the conversation below so a coding agent can continue the work without it.
Include: the user's goals and requirements, key decisions, files read or modified (with paths), important code facts,
commands run and their outcomes, errors encountered, and what remains to be done. Be specific and dense. Use markdown.`

export async function summarize(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ summary: string; usage?: import('../types.js').Usage }> {
  let summary = ''
  let usage
  for await (const ev of provider.chat({
    model,
    signal,
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: transcript(messages).slice(-400_000) },
    ],
  })) {
    if (ev.type === 'text') summary += ev.delta
    if (ev.type === 'usage') usage = ev.usage
  }
  return { summary: summary.trim(), usage }
}
