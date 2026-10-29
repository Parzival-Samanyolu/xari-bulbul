import type { Provider } from '../providers/types.js'
import type { Usage } from '../types.js'

const TITLE_PROMPT = `Write a title for a chat with a coding agent that starts with the user message below.
3 to 6 words, sentence case, no quotes, no trailing period, no emoji. Name the task, not the user.
Reply with the title only.`

/** Asks a model for a short chat title. Returns '' when the reply is empty or unusable. */
export async function generateTitle(provider: Provider, model: string, text: string, signal?: AbortSignal): Promise<{ title: string; usage?: Usage }> {
  let out = ''
  let usage: Usage | undefined
  for await (const ev of provider.chat({
    model,
    signal,
    messages: [
      { role: 'system', content: TITLE_PROMPT },
      { role: 'user', content: text.slice(0, 4000) },
    ],
  })) {
    if (ev.type === 'text') out += ev.delta
    if (ev.type === 'usage') usage = ev.usage
  }
  return { title: cleanTitle(out), usage }
}

export function cleanTitle(raw: string): string {
  // Reasoning models sometimes leak a preamble; the title is the last non-empty line.
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const title = line
    .replace(/^(title:\s*)/i, '')
    .replace(/^[#*\s"'“”‘’`]+|[*\s"'“”‘’`.]+$/g, '')
    .replace(/\s+/g, ' ')
  return title.length > 60 ? title.slice(0, 57) + '…' : title
}
