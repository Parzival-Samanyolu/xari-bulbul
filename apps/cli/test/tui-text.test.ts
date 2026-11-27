import { describe, expect, it } from 'vitest'
import { setColor, stripAnsi, style, truncate, width, wrap } from '../src/tui/ansi.js'
import { inline, renderMarkdown, splitStable } from '../src/tui/markdown.js'

describe('ansi', () => {
  it('measures wide characters and ignores colour codes', () => {
    setColor(true)
    expect(width(style.bold('abc'))).toBe(3)
    expect(width('日本')).toBe(4)
    expect(width('Xarı Bülbül')).toBe(11)
    expect(width('é')).toBe(1)
  })

  it('wraps at spaces and carries colours to the next line', () => {
    setColor(true)
    const lines = wrap(style.red('one two three four five'), 10)
    expect(lines.map(stripAnsi)).toEqual(['one two', 'three four', 'five'])
    // every wrapped line is red on its own
    for (const l of lines) expect(l).toContain('\x1b[31m')
    expect(wrap('abcdefghijklmnop', 5).map(stripAnsi)).toEqual(['abcde', 'fghij', 'klmno', 'p'])
  })

  it('truncates with an ellipsis', () => {
    setColor(false)
    expect(truncate('hello world', 6)).toBe('hello…')
    expect(truncate('hi', 6)).toBe('hi')
  })
})

describe('markdown', () => {
  it('styles inline code, bold, italics and links, but not inside code', () => {
    setColor(false)
    expect(inline('use `**not bold**` and **bold** [docs](https://x.y)')).toBe('use **not bold** and bold docs (https://x.y)')
    setColor(true)
    expect(inline('**b**')).toBe('\x1b[1mb\x1b[22m')
    // a styled word before a link must not swallow it
    expect(stripAnsi(inline('*italics* and [links](https://x.y)'))).toBe('italics and links (https://x.y)')
  })

  it('renders headings, lists, quotes and code blocks', () => {
    setColor(false)
    const md = '# Title\n\nSome text.\n\n- one\n- [x] done\n  - nested\n1. first\n\n> quoted\n\n```ts\nconst a = 1\n```\n'
    expect(renderMarkdown(md, 60)).toEqual(['Title', '', 'Some text.', '', '• one', '• ☑ done', '  • nested', '1. first', '', '┃ quoted', '', '│ ts', '│ const a = 1'])
  })

  it('hangs wrapped list items under their text', () => {
    setColor(false)
    expect(renderMarkdown('- alpha beta gamma delta', 14)).toEqual(['• alpha beta', '  gamma delta'])
  })

  it('splits streamed text after the last finished block, never inside code', () => {
    expect(splitStable('para one\n\npara tw')).toEqual(['para one\n\n', 'para tw'])
    expect(splitStable('intro\n\n```\na\n\nb')).toEqual(['intro\n\n', '```\na\n\nb'])
    expect(splitStable('no break yet')).toEqual(['', 'no break yet'])
  })
})
