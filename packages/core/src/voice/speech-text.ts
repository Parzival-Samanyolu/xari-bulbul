// Text to speech, the pure parts: turning a Markdown reply into plain sentences a voice can read,
// plus the voice lists shown in Settings. No Node APIs, so the renderer imports this as
// `@harness/core/speech`.

export const TTS_PROVIDERS = ['system', 'openai', 'off'] as const
export type TtsProvider = (typeof TTS_PROVIDERS)[number]

export const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1'] as const
export type OpenAiTtsModel = (typeof OPENAI_TTS_MODELS)[number]

/** Voices of OpenAI's `/audio/speech` (all of them work with both models). */
export const OPENAI_TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] as const
export const OPENAI_DEFAULT_VOICE = 'alloy'

export interface TtsVoice {
  /** What goes into settings and the request (system: the voice URI; openai: e.g. `alloy`). */
  id: string
  label: string
  /** BCP 47 locale, e.g. `en-US`, when known. */
  locale?: string
}

/** The sentence the Settings Test button reads. */
export const TTS_SAMPLE = 'Hello. This is how replies will sound when they are read aloud.'

export const CODE_OMITTED = 'Code block omitted.'

/** `https://www.example.com/a/b?c` → `example.com`. Unparseable URLs become "a link". */
export function urlHost(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host || 'a link'
  } catch {
    return 'a link'
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g

/** Ends a line with a full stop when it has no closing punctuation, so voices pause between headings and list items. */
const closeLine = (line: string) => (/[.!?…:;,]["')\]]*$/.test(line) ? line : `${line}.`)

/**
 * Markdown → plain text for speaking: code blocks become "Code block omitted.", inline code
 * keeps its text, links keep their text, bare URLs shrink to their host, and headings, list
 * markers, emphasis, tables, HTML and rules are stripped. Lines become sentences.
 */
export function speechText(markdown: string): string {
  const out: string[] = []
  let fence: string | null = null
  let lastWasCode = false
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw)
    if (fence) {
      // Inside a code block: wait for a closing fence of the same kind and at least the same length.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && raw.trim() === fenceMatch[1]) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      if (!lastWasCode) out.push(CODE_OMITTED)
      lastWasCode = true
      continue
    }
    let line = raw.trim()
    if (!line) continue
    // Table separator rows and horizontal rules say nothing.
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line) || /^([-*_])(\s*\1){2,}$/.test(line)) continue
    line = inline(line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(>\s?)+/, '')
      .replace(/^([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?/, ''))
    // Table rows: cells read as a list.
    if (/^\|.*\|$/.test(line)) line = line.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean).join(', ')
    line = line.replace(/\s+/g, ' ').trim()
    if (!line || !/[\p{L}\p{N}]/u.test(line)) continue
    out.push(closeLine(line))
    lastWasCode = false
  }
  return out.join(' ').trim()
}

/** Inline Markdown → text. */
function inline(s: string): string {
  return (
    s
      // Images keep their alt text, links their label.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, (_, u: string) => urlHost(u))
      // Code spans: the text without backticks (URLs inside still shrink below).
      .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code: string) => code.trim())
      .replace(URL_RE, (u) => urlHost(u))
      // HTML tags and entities.
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      // Emphasis and strikethrough markers.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      // Footnote references.
      .replace(/\[\^[^\]]+\]/g, '')
  )
}

const ENDS = new Set(['.', '!', '?', '…', '。', '！', '？'])
const CLOSERS = /[.!?…"')\]»”’]/

/**
 * Splits after . ! ? … (plus closing quotes and brackets) when whitespace follows. A full stop
 * followed by a lowercase letter ("e.g. this") isn't an end. CJK full stops always are.
 */
export function splitSentences(text: string): string[] {
  const s = text.trim()
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!ENDS.has(ch)) continue
    let j = i + 1
    while (j < s.length && CLOSERS.test(s[j])) j++
    const cjk = ch === '。' || ch === '！' || ch === '？'
    if (!cjk && j < s.length && !/\s/.test(s[j])) continue
    const next = s.slice(j).trimStart()[0]
    if (!cjk && ch === '.' && next && /[a-z]/.test(next)) continue
    const sentence = s.slice(start, j).trim()
    if (sentence) parts.push(sentence)
    start = j
    i = j - 1
  }
  const tail = s.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

/** Breaks one over-long sentence at clause marks, then spaces, then anywhere, keeping each piece ≤ max. */
function splitLong(sentence: string, max: number): string[] {
  const pieces: string[] = []
  let s = sentence
  while (s.length > max) {
    const window = s.slice(0, max + 1)
    let at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' – '), window.lastIndexOf(' — '))
    if (at < max / 3) at = window.lastIndexOf(' ')
    else at += 1
    if (at <= 0) at = max
    pieces.push(s.slice(0, at).trim())
    s = s.slice(at).trim()
  }
  if (s) pieces.push(s)
  return pieces
}

/**
 * Plain text → chunks of at most `max` characters, split at sentence ends. The first chunk is
 * a single sentence so playback starts quickly; later sentences are packed together up to `max`.
 */
export function chunkSpeech(text: string, max = 400): string[] {
  const sentences = splitSentences(text).flatMap((s) => (s.length > max ? splitLong(s, max) : [s]))
  const chunks: string[] = []
  for (const s of sentences) {
    const last = chunks.at(-1)
    if (chunks.length > 1 && last !== undefined && last.length + 1 + s.length <= max) chunks[chunks.length - 1] = `${last} ${s}`
    else chunks.push(s)
  }
  return chunks
}

/** A reply as speakable chunks. Empty when there's nothing to say. */
export function prepareSpeech(markdown: string, max = 400): string[] {
  return chunkSpeech(speechText(markdown), max)
}
