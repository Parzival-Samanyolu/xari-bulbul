import { z } from 'zod'
import { defineTool, truncate } from './types.js'

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export const webFetchTool = defineTool({
  name: 'web_fetch',
  description: 'Fetch a URL over HTTP(S) and return its content as plain text (HTML is stripped).',
  input: z.object({ url: z.string().url().describe('http(s) URL') }),
  kind: 'network',
  readOnly: true,
  subject: (i) => i.url,
  async execute(input, ctx) {
    if (!/^https?:\/\//i.test(input.url)) return { content: 'Only http(s) URLs are supported.', isError: true }
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
    const res = await fetch(input.url, { signal, headers: { 'user-agent': 'XariBulbul/0.1 (+coding agent)' } })
    const type = res.headers.get('content-type') ?? ''
    const raw = await res.text()
    const text = type.includes('html') ? htmlToText(raw) : raw
    return {
      content: `[${res.status} ${type}]\n${truncate(text, ctx.toolOutputMaxChars)}`,
      isError: !res.ok,
    }
  },
})
