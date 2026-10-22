import { ProviderError } from './types.js'

/** fetch with retry on network errors, 408/409/429/5xx (only before the stream starts). */
export async function requestWithRetry(
  fetchImpl: typeof fetch,
  providerName: string,
  retries: number,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let attempt = 0
  while (true) {
    let res: Response
    try {
      res = await fetchImpl(url, init)
    } catch (err) {
      if (init.signal?.aborted) throw err
      if (attempt++ >= retries) throw new ProviderError(`Network error: ${(err as Error).message}`)
      await sleep(backoff(attempt), init.signal)
      continue
    }
    if (res.ok) return res
    const retryable = [408, 409, 429].includes(res.status) || res.status >= 500
    const text = await res.text().catch(() => '')
    if (retryable && attempt++ < retries) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), init.signal)
      continue
    }
    throw new ProviderError(`${providerName} error ${res.status}: ${extractError(text)}`, res.status, retryable)
  }
}

export function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15_000) + Math.random() * 250
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })
}

export function extractError(text: string): string {
  try {
    const j = JSON.parse(text)
    return j.error?.message ?? j.message ?? text
  } catch {
    return text.slice(0, 500) || 'unknown error'
  }
}

const CONTEXT_OVERFLOW =
  /context.{0,20}(length|window|limit|size)|prompt is too long|too many tokens|token limit|maximum.{0,40}tokens|exceeds?.{0,40}(context|tokens)/i

/** The request didn't fit the model's context window; compacting history and retrying can fix it. */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false
  return (err.status == null || err.status === 400 || err.status === 413) && CONTEXT_OVERFLOW.test(err.message)
}

export function midStreamError(provider: string, message: string | undefined, code: number | undefined): ProviderError {
  // Client errors (bad request, context too long) won't fix themselves; everything else is worth a retry.
  const retryable = code == null || code === 408 || code === 429 || code >= 500
  const detail = message && !/injected into SSE stream/i.test(message) ? ` (${message})` : ''
  return new ProviderError(`${provider}: the model's provider failed partway through its reply${detail}.`, code, retryable)
}
