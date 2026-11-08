import { ProviderError } from './types.js'

/** fetch with retry on network errors, 408/409/429/5xx (only before the stream starts). */
export async function requestWithRetry(
  fetchImpl: typeof fetch,
  providerName: string,
  retries: number,
  url: string,
  init: RequestInit,
  /** Statuses to throw at once instead of retrying (e.g. a 429 when another account can take over). */
  noRetry: readonly number[] = [],
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
    const retryAfter = Number(res.headers.get('retry-after'))
    if (retryable && !noRetry.includes(res.status) && attempt++ < retries) {
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), init.signal)
      continue
    }
    throw new ProviderError(`${providerName} error ${res.status}: ${extractError(text)}`, res.status, retryable, retryAfter > 0 ? retryAfter * 1000 : undefined)
  }
}

/**
 * Runs a streamed request and gives up when nothing arrives for `stallMs` (0 = never): a dropped
 * connection or a queued request otherwise hangs the chat forever. `run` gets the signal to send
 * the request with and calls `touch` whenever bytes arrive. A user stop still surfaces as an abort.
 */
export async function* withStallGuard<T>(
  name: string,
  model: string,
  stallMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined, touch: () => void) => AsyncIterable<T>,
): AsyncIterable<T> {
  if (!stallMs) return yield* run(signal, () => {})
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(signal?.reason)
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ((stalled = true), ctrl.abort()), stallMs)
  }
  try {
    touch()
    yield* run(ctrl.signal, touch)
  } catch (e) {
    if (!stalled || signal?.aborted) throw e
    throw new ProviderError(`${name} sent nothing for ${Math.round(stallMs / 1000)}s on ${model}; it may be queued or overloaded, or the connection dropped. Try another model.`, 408)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
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
