import type { MessageKey } from './i18n/catalog'

/**
 * Errors the main process throws are translated, so the renderer can't act on their wording.
 * Across IPC (only `message` survives) the catalogue key travels in front of the text:
 * "⟦main.error.needsKey⟧ OpenRouter needs an API key…". The renderer reads the key and shows the text.
 */
const CODED = /^⟦([\w.]+)⟧ /

export function encodeAppError(key: MessageKey, text: string): string {
  return `⟦${key}⟧ ${text}`
}

export function decodeAppError(raw: string): { text: string; key?: MessageKey } {
  const m = CODED.exec(raw)
  return m ? { text: raw.slice(m[0].length), key: m[1] as MessageKey } : { text: raw }
}
