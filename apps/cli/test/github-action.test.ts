import { describe, expect, it } from 'vitest'
import { parseSettings } from '@harness/core'
import { MARKER, buildArgs, buildSettings, commentBody, envKeyName, extractResult, outputEntry } from '../../../.github/actions/xari/lib.mjs'
import { parseArgs } from '../src/args.js'

describe('GitHub Action helpers', () => {
  it('names the key variable like the CLI does', () => {
    expect(envKeyName('openrouter')).toBe('OPENROUTER_API_KEY')
    expect(envKeyName('ollama-cloud')).toBe('OLLAMA_CLOUD_API_KEY')
    expect(envKeyName('custom')).toBe('CUSTOM_API_KEY')
  })

  it('writes settings the CLI accepts', () => {
    const s = parseSettings(buildSettings({ provider: 'custom', model: 'm1', baseUrl: 'https://x.test/v1/' }))
    expect(s.models.default).toEqual({ providerId: 'custom', modelId: 'm1' })
    expect(s.providers.find((p) => p.id === 'custom')?.baseUrl).toBe('https://x.test/v1')
    expect(parseSettings(buildSettings({ provider: 'openai', model: 'gpt-5' })).models.default.providerId).toBe('openai')
  })

  it('rejects bad provider setups', () => {
    expect(() => buildSettings({ provider: 'custom', model: 'm' })).toThrow(/base-url/)
    expect(() => buildSettings({ provider: 'nope', model: 'm' })).toThrow(/provider must be/)
    expect(() => buildSettings({ provider: 'openrouter', model: '' })).toThrow(/model/)
  })

  it('builds arguments the CLI parser accepts, prompt via stdin', () => {
    const r = parseArgs(buildArgs({ mode: 'plan', outputFormat: 'json', maxSteps: '5' }))
    expect(r.ok && r.args).toMatchObject({ print: '', outputFormat: 'json', mode: 'plan', maxSteps: 5 })
  })

  it('extracts the result from every output format', () => {
    expect(extractResult(' hi \n', 'text')).toBe('hi')
    expect(extractResult('{"type":"result","result":"done"}', 'json')).toBe('done')
    expect(extractResult('{"type":"text","text":"a"}\n{"type":"result","result":"fin"}\n', 'stream-json')).toBe('fin')
  })

  it('marks, caps and labels the comment', () => {
    const body = commentBody('Looks good', { model: 'openrouter/free', mode: 'plan' })
    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('Looks good')
    expect(body).toContain('`openrouter/free`')
    expect(commentBody('x'.repeat(70000)).length).toBeLessThan(65536)
    expect(commentBody('  ')).toContain('without an answer')
  })

  it('writes multi-line outputs safely', () => {
    expect(outputEntry('result', 'a\nb', 'EOF')).toBe('result<<EOF\na\nb\nEOF\n')
    expect(outputEntry('result', 'EOF', 'EOF')).toContain('EOF_')
  })
})
