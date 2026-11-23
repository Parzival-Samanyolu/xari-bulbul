import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'

const ok = (argv: string[]) => {
  const r = parseArgs(argv)
  if (!r.ok) throw new Error(r.error)
  return r.args
}
const err = (argv: string[]) => {
  const r = parseArgs(argv)
  if (r.ok) throw new Error('expected an error')
  return r.error
}

describe('parseArgs', () => {
  it('defaults to an interactive chat', () => {
    expect(ok([]).print).toBeUndefined()
    expect(ok([])).toMatchObject({ outputFormat: 'text', continue: false, prompt: '' })
  })

  it('treats positional words as the first interactive prompt', () => {
    expect(ok(['fix', 'the', 'bug']).prompt).toBe('fix the bug')
    expect(ok(['--', '--weird', 'prompt']).prompt).toBe('--weird prompt')
  })

  it('reads -p with a value, inline, or none (prompt from stdin)', () => {
    expect(ok(['-p', 'hello']).print).toBe('hello')
    expect(ok(['--print=hello there']).print).toBe('hello there')
    expect(ok(['-phello']).print).toBe('hello')
    expect(ok(['-p']).print).toBe('')
    expect(ok(['-p', '--mode', 'auto']).print).toBe('')
  })

  it('joins unquoted words after -p into the prompt', () => {
    expect(ok(['-p', 'fix', 'the', 'bug']).print).toBe('fix the bug')
  })

  it('parses the value flags', () => {
    const a = ok(['-p', 'x', '--output-format', 'json', '--model', 'groq/openai/gpt-oss-120b', '--mode=plan', '--cwd', '/tmp', '--max-steps', '7'])
    expect(a).toMatchObject({ outputFormat: 'json', model: 'groq/openai/gpt-oss-120b', mode: 'plan', cwd: '/tmp', maxSteps: 7 })
  })

  it('parses -c, -r, --version and --help', () => {
    expect(ok(['-c']).continue).toBe(true)
    expect(ok(['--continue']).continue).toBe(true)
    expect(ok(['-r', 'abc']).resume).toBe('abc')
    expect(ok(['--resume=abc']).resume).toBe('abc')
    expect(ok(['--version']).version).toBe(true)
    expect(ok(['-h']).help).toBe(true)
  })

  it('rejects unknown flags with a hint', () => {
    expect(err(['--bogus'])).toMatch(/unknown option "--bogus".*--help/)
    expect(err(['-x'])).toMatch(/unknown option "-x"/)
  })

  it('rejects bad values and combinations', () => {
    expect(err(['-p', 'x', '--output-format', 'xml'])).toMatch(/--output-format must be one of/)
    expect(err(['--mode', 'yolo'])).toMatch(/--mode must be one of/)
    expect(err(['--max-steps', '0'])).toMatch(/positive whole number/)
    expect(err(['--max-steps', 'abc'])).toMatch(/positive whole number/)
    expect(err(['--model'])).toMatch(/needs a value/)
    expect(err(['--model', '--mode'])).toMatch(/needs a value/)
    expect(err(['--output-format', 'json'])).toMatch(/only works with -p/)
    expect(err(['-c', '-r', 'abc'])).toMatch(/either --continue or --resume/)
    expect(err(['--continue=1'])).toMatch(/takes no value/)
  })
})
