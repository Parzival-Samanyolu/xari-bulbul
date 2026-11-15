import { ProviderError } from '../providers/types.js'
import type { ChatMessage } from '../types.js'

/** Whether any message carries images (user attachments or tool screenshots). */
export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => (m.role === 'user' || m.role === 'tool') && !!m.images?.length)
}

/**
 * The messages with images replaced by a short text note, for models that can't see images.
 * The session keeps the images, so a vision model picked later still gets them.
 */
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if ((m.role !== 'user' && m.role !== 'tool') || !m.images?.length) return m
    const names = m.images.map((i) => `[Image ${i.name} not shown: this model can't see images]`).join('\n')
    const { images: _drop, ...rest } = m
    return { ...rest, content: m.content ? `${m.content}\n\n${names}` : names } as ChatMessage
  })
}

const IMAGE_ERROR = /\b(images?|image[ _-]?(input|url)|input_image|vision|multi-?modal|modalit(y|ies))\b/i

/** A failed request that sent images and whose error is about them (the model doesn't take image input). */
export function isImageUnsupported(err: unknown): boolean {
  // Status varies by provider (OpenRouter 404 "no endpoints that support image input", Ollama 500), so only the message counts.
  return err instanceof ProviderError && err.status !== 429 && IMAGE_ERROR.test(err.message)
}
