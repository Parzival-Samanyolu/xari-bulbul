// Allowed iMessage senders. No Node imports: the renderer uses these too (`@harness/core/gateway-senders`).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * A sender as stored in settings: emails lowercased, phone numbers as E.164 (`+` and digits).
 * Phones need their country code (`+` or `00`), since chat.db stores numbers that way.
 * Returns null for anything else.
 */
export function normalizeSender(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (s.includes('@')) {
    const email = s.replace(/^mailto:/i, '').toLowerCase()
    return EMAIL.test(email) ? email : null
  }
  const cleaned = s.replace(/^tel:/i, '').replace(/[\s().\- ]/g, '')
  const intl = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned
  return /^\+[1-9]\d{6,14}$/.test(intl) ? intl : null
}

/** A `handle.id` from chat.db in the same form; numbers stored without `+` get one. */
export function normalizeHandle(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (s.includes('@')) return normalizeSender(s)
  const digits = s.replace(/^tel:/i, '').replace(/[\s().\- ]/g, '')
  return normalizeSender(/^\d+$/.test(digits) ? `+${digits}` : digits)
}

/** The allowed sender `handle` matches, or null. Nobody is allowed while the list is empty. */
export function allowedSender(handle: string, senders: readonly string[]): string | null {
  const h = normalizeHandle(handle)
  if (!h) return null
  for (const raw of senders) {
    const s = normalizeSender(raw)
    if (s && s === h) return s
  }
  return null
}
