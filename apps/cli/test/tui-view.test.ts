import { describe, expect, it } from 'vitest'
import { setColor, stripAnsi, width } from '../src/tui/ansi.js'
import * as v from '../src/tui/view.js'

const req = { callId: 'c', tool: 'edit_file', kind: 'edit' as const, subject: 'src/a.ts', input: { path: 'src/a.ts', old_string: 'a\n', new_string: 'b\n' }, reason: 'Modifies files.', suggestedRule: 'edit_file(src/a.ts)' }

describe('view', () => {
  it('draws boxes exactly as wide as the terminal', () => {
    setColor(true)
    for (const cols of [40, 80, 120]) {
      const lines = v.permissionBox(req, 0, cols)
      for (const l of lines) expect(width(l)).toBe(cols)
    }
  })

  it('previews an edit as removed and added lines, without a trailing empty line', () => {
    setColor(false)
    const text = v.permissionBox(req, 2, 60).map(stripAnsi).join('\n')
    expect(text).toContain('- a')
    expect(text).toContain('+ b')
    expect(text).not.toMatch(/\+ \s*│/)
    expect(text).toContain('❯ 3. No, tell Xarı what to do instead')
  })

  it('summarizes tool results: diffs with paths relative to the folder, shell output tails, errors', () => {
    setColor(false)
    const diff = v.toolResultLines('edit_file', { content: 'ok', display: { kind: 'diff', path: '/p/src/a.ts', patch: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1 } }, false, 80, '/p')
    expect(diff.map(stripAnsi)).toEqual(['  ↳ +1 -1 src/a.ts', '    @@ -1 +1 @@', '    -a', '    +b'])
    const bash = v.toolResultLines('bash', { content: '1\n2\n3\n4\n5\n6' }, false, 80)
    expect(bash.map(stripAnsi)).toEqual(['  ↳ … 2 lines above', '    3', '    4', '    5', '    6'])
    expect(stripAnsi(v.toolResultLines('read_file', { content: 'nope', isError: true }, false, 80)[0])).toBe('  ↳ nope')
    expect(stripAnsi(v.toolResultLines('bash', { content: 'Denied' }, true, 80)[0])).toBe('  ↳ Denied')
  })

  it('fits the footer to the width, with the context warning past 80%', () => {
    setColor(false)
    const f = v.footer({ mode: 'acceptEdits', model: 'mock/m', contextPct: 85, cost: 0.5, queued: 1, hint: '', cols: 90 })
    expect(width(f)).toBeLessThanOrEqual(90)
    expect(f).toContain('Auto-edit')
    expect(f).toContain('1 queued')
    expect(f).toContain('85% context')
    expect(f).toContain('$0.50')
  })

  it('labels tools in words, MCP tools by server', () => {
    expect(v.toolLabel('bash')).toBe('Run')
    expect(v.toolLabel('mcp__github__create_issue')).toBe('github · create_issue')
    expect(v.toolLabel('custom')).toBe('custom')
  })
})
