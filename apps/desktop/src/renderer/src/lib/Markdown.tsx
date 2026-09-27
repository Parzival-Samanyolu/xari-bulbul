import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { memo, useMemo } from 'react'

marked.setOptions({ gfm: true, breaks: false })

/** Model output is untrusted: render markdown, then sanitize. Links are opened externally by main. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})
