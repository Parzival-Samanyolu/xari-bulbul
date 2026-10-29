import { sleep } from './http.js'

/** Batch replies take minutes, sometimes hours: check every few seconds at first, then every 30s. */
export const BATCH_POLL = { firstMs: 3000, maxMs: 30_000 }

/**
 * Calls `check` until it returns a value. On abort, `cancel` runs (best effort) and the abort is rethrown.
 * Used for Anthropic Message Batches and the OpenAI Batch API.
 */
export async function pollBatch<T>(check: () => Promise<T | undefined>, cancel: () => Promise<unknown>, signal?: AbortSignal): Promise<T> {
  let wait = BATCH_POLL.firstMs
  try {
    while (true) {
      const done = await check()
      if (done !== undefined) return done
      await sleep(wait, signal)
      wait = Math.min(BATCH_POLL.maxMs, Math.round(wait * 1.5))
    }
  } catch (e) {
    if (signal?.aborted) void cancel().catch(() => {})
    throw e
  }
}

/** The line for `customId` in a JSONL results file. */
export function findJsonl<T extends { custom_id?: string }>(text: string, customId: string): T | undefined {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as T
      if (row.custom_id === customId) return row
    } catch {
      // skip malformed lines
    }
  }
  return undefined
}

export const BATCH_STATUS = 'Sent as a batch request (about half price). Waiting for the provider; this can take a few minutes…'
