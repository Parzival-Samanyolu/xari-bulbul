/** Parse a Server-Sent Events byte stream into `data:` payloads. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      // Events are separated by a blank line; tolerate \r\n line endings.
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
        const data = eventData(raw)
        if (data !== null) yield data
      }
    }
    const tail = eventData(buffer + decoder.decode())
    if (tail !== null) yield tail
  } finally {
    reader.releaseLock()
  }
}

function eventData(raw: string): string | null {
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'))
  if (lines.length === 0) return null
  return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n')
}
