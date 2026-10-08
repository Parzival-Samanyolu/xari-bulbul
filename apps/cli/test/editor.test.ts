import { describe, expect, it } from 'vitest'
import { parseCliArgs, UsageError } from '../src/args.js'
import * as E from '../src/ui/editor.js'
import { nextMode, parseMode, shortPath, tokens, usd } from '../src/ui/format.js'

const b = (text: string, cursor = text.length): E.Buffer => ({ text, cursor })

describe('composer buffer', () => {
  it('edits and moves across lines', () => {
    expect(E.insert(b('ac', 1), 'b')).toEqual(b('abc', 2))
    expect(E.backspace(b('abc', 3))).toEqual(b('ab', 2))
    expect(E.up(b('one\ntwo', 6))).toEqual(b('one\ntwo', 2))
    expect(E.up(b('one', 2))).toBeNull()
    expect(E.down(b('one\ntwo', 1))).toEqual(b('one\ntwo', 5))
    expect(E.down(b('one\ntwo', 5))).toBeNull()
    expect(E.deleteWord(b('git commit -m'))).toEqual(b('git commit ', 11))
    expect(E.deleteToLineStart(b('a\nbcd', 4))).toEqual(b('a\nd', 2))
    expect(E.home(b('a\nbcd', 4)).cursor).toBe(2)
    expect(E.end(b('a\nbcd', 2)).cursor).toBe(5)
  })

  it('finds the slash command or @ mention being typed', () => {
    expect(E.activeToken(b('/mo'))).toEqual({ kind: 'slash', query: 'mo', start: 0 })
    expect(E.activeToken(b('/model x'))).toBeNull()
    expect(E.activeToken(b('look at @src/a'))).toEqual({ kind: 'mention', query: 'src/a', start: 8 })
    expect(E.activeToken(b('mail@example'))).toBeNull()
    expect(E.replaceToken(b('see @sr'), 4, '@src/app.ts ')).toEqual(b('see @src/app.ts ', 16))
  })

  it('collapses big pastes and expands them on send', () => {
    const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const label = E.pasteLabel(big, 1)
    expect(label).toBe('[Pasted 20 lines]')
    expect(E.expandPastes(`fix this ${label}`, new Map([[label, big]]))).toBe(`fix this ${big}`)
  })

  it('fuzzy-matches with prefix and substring first', () => {
    expect(E.fuzzyScore('mo', 'model')).toBe(0)
    expect(E.fuzzyScore('del', 'model')).toBeLessThan(2)
    expect(E.fuzzyScore('mdl', 'model')).toBeGreaterThanOrEqual(2)
    expect(E.fuzzyScore('xyz', 'model')).toBeNull()
    expect(E.fuzzyIndices('mdl', 'model')).toEqual([0, 2, 4])
  })
})

describe('formatting', () => {
  it('formats tokens, money and paths honestly', () => {
    expect(tokens(950)).toBe('950')
    expect(tokens(1234)).toBe('1.2k')
    expect(tokens(1_234_567)).toBe('1.23M')
    expect(usd(0)).toBe('$0')
    expect(usd(0.00042)).toBe('$0.00042')
    expect(usd(0.0123)).toBe('$0.012')
    expect(usd(1.5, true)).toBe('$1.50+')
    expect(shortPath('/Users/a/code/x', 48, '/Users/a')).toBe('~/code/x')
  })

  it('cycles and parses modes', () => {
    expect(nextMode('ask')).toBe('acceptEdits')
    expect(nextMode('auto')).toBe('ask')
    expect(parseMode('full-auto')).toBe('auto')
    expect(parseMode('Auto-edit')).toBe('acceptEdits')
    expect(parseMode('nope')).toBeNull()
  })
})

describe('command line', () => {
  it('parses chat, exec and login forms', () => {
    expect(parseCliArgs([])).toMatchObject({ command: 'chat', continue: false })
    expect(parseCliArgs(['fix', 'the', 'tests'])).toMatchObject({ command: 'chat', prompt: 'fix the tests' })
    expect(parseCliArgs(['-p', 'hi', '--output-format', 'json'])).toMatchObject({ command: 'exec', prompt: 'hi', format: 'json' })
    expect(parseCliArgs(['exec', 'do', 'it', '--mode', 'full-auto'])).toMatchObject({ command: 'exec', prompt: 'do it', mode: 'auto' })
    expect(parseCliArgs(['login', 'groq'])).toMatchObject({ command: 'login', provider: 'groq' })
    expect(parseCliArgs(['-c', '-m', 'ollama-cloud:glm-5.3'])).toMatchObject({ continue: true, model: 'ollama-cloud:glm-5.3' })
  })

  it('takes an optional id after --resume', () => {
    expect(parseCliArgs(['--resume']).resume).toBe(true)
    expect(parseCliArgs(['-r', '7b8ad8f7']).resume).toBe('7b8ad8f7')
    expect(parseCliArgs(['--resume', 'fix tests'])).toMatchObject({ resume: true, prompt: 'fix tests' })
  })

  it('rejects bad input with a usage error', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow(UsageError)
    expect(() => parseCliArgs(['--mode', 'wild'])).toThrow(/--mode/)
    expect(() => parseCliArgs(['-p', 'x', '--output-format', 'xml'])).toThrow(/output-format/)
  })
})
