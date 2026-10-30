import type { Provider } from '../providers/types.js'
import type { ChatMessage, MixtureProposal, ModelRef, Usage } from '../types.js'

/** How much of the conversation proposers and the aggregator see (characters, ~4 per token). */
const TRANSCRIPT_CHARS = 24_000
/** The latest user message is always included in full, up to this. */
const LATEST_CHARS = 16_000
const TOOL_RESULT_CHARS = 1_200
const PROPOSAL_CHARS = 12_000

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…cut]` : s)

/**
 * The conversation as plain text, newest last and trimmed from the oldest end. Tool calls and
 * results become short notes, so models without tools (and providers that reject tool messages
 * without tool definitions) can still read what the agent found.
 */
export function mixtureTranscript(messages: ChatMessage[], maxChars = TRANSCRIPT_CHARS): string {
  const blocks: string[] = []
  let latest = -1
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      if (m.synthetic) continue
      const files = (m.files ?? []).map((f) => `[Attached file ${f.name}]\n${clip(f.text, 4000)}`)
      const images = (m.images ?? []).map((i) => `[Attached image ${i.name}, not shown here]`)
      latest = blocks.length
      blocks.push(`User:\n${[m.content, ...files, ...images].filter(Boolean).join('\n\n')}`)
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => `[Called ${c.name} ${clip(c.arguments, 300)}]`)
      const text = [clip(m.content.trim(), 6000), ...calls].filter(Boolean).join('\n')
      if (text) blocks.push(`Assistant:\n${text}`)
    } else {
      blocks.push(`[Result of ${m.name}]\n${clip(m.content, TOOL_RESULT_CHARS)}`)
    }
  }
  if (latest >= 0) blocks[latest] = clip(blocks[latest], LATEST_CHARS)
  // Keep the newest blocks that fit, but never drop the latest user message.
  const kept: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const size = blocks[i].length + 2
    if (used + size > maxChars && i !== latest && kept.length) {
      if (i < latest) break
      continue
    }
    kept.unshift(blocks[i])
    used += size
  }
  if (kept.length < blocks.length) kept.unshift('[Earlier messages left out]')
  return kept.join('\n\n')
}

const language = (lang: string) => (lang.trim() ? ` Write in ${lang.trim()}.` : '')

export function proposerMessages(transcript: string, lang = ''): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are one of several models answering the same message independently; another model will combine the answers. ' +
        "Reply to the user's latest message as well as you can, using the conversation for context. You can't use tools or see anything beyond what the conversation shows. " +
        `Be accurate and complete, say when you are unsure, and don't mention that other models are involved.${language(lang)}`,
    },
    { role: 'user', content: `${transcript}\n\n---\nWrite your reply to the user's latest message.` },
  ]
}

export function aggregatorMessages(transcript: string, answers: { label: string; content: string }[], lang = ''): ChatMessage[] {
  const list = answers.map((a, i) => `## Answer ${i + 1} (${a.label})\n\n${clip(a.content, PROPOSAL_CHARS)}`).join('\n\n')
  return [
    {
      role: 'system',
      content:
        "You write the final reply to the user. You get the conversation and several candidate answers to the user's latest message from different models. " +
        'Combine them into one reply that is better than each: keep what is correct and useful, fix or drop mistakes, and when they disagree, work out which is right. ' +
        "An answer marked as the agent's draft was written with tools and saw their results, so trust its facts about files and commands. " +
        `Write directly to the user, as the assistant. Don't mention the candidates, the models or that answers were combined.${language(lang)}`,
    },
    { role: 'user', content: `${transcript}\n\n---\n# Candidate answers\n\n${list}\n\n---\nWrite the final reply to the user's latest message.` },
  ]
}

/** Streams one text-only request and returns its text and usage. */
export async function collectText(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  onText?: (delta: string) => void,
): Promise<{ text: string; usage?: Usage }> {
  let text = ''
  let usage: Usage | undefined
  for await (const ev of provider.chat({ model, messages, signal })) {
    if (ev.type === 'text') {
      text += ev.delta
      onText?.(ev.delta)
    } else if (ev.type === 'usage') usage = ev.usage
  }
  return { text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), usage }
}

/**
 * Asks every proposer at once. A proposer that fails or answers nothing is kept with its error
 * (shown in the reply's disclosure) and left out of the aggregator's input.
 */
export async function runProposers(
  proposers: ModelRef[],
  ask: (ref: ModelRef) => Promise<string>,
): Promise<MixtureProposal[]> {
  return Promise.all(
    proposers.map(async (model): Promise<MixtureProposal> => {
      try {
        const content = await ask(model)
        return content ? { model, content } : { model, error: 'Empty answer' }
      } catch (err) {
        return { model, error: (err as Error).message.slice(0, 300) || 'Failed' }
      }
    }),
  )
}
