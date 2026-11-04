import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/host/redact.js'

describe('redactSecrets', () => {
  it('removes provider keys by prefix', () => {
    const out = redactSecrets('OpenRouter 401: invalid key sk-or-v1-abcdef0123456789abcdef and ghp_ABCDEFGHIJKLMNOP1234')
    expect(out).not.toContain('abcdef0123456789')
    expect(out).not.toContain('ABCDEFGHIJKLMNOP1234')
    expect(out).toContain('OpenRouter 401: invalid key sk-')
  })

  it('removes bearer tokens, key=value pairs and query credentials', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-ghi_jkl123')).not.toContain('abc.def-ghi_jkl123')
    expect(redactSecrets('{"api_key": "hunter2hunter2"}')).toBe('{"api_key": "[redacted]"}')
    expect(redactSecrets('password=letmein!')).toBe('password=[redacted]')
    expect(redactSecrets('GET https://x.test/v1/models?key=AbC123xyz&alt=json')).toBe('GET https://x.test/v1/models?key=[redacted]&alt=json')
  })

  it('removes long opaque tokens and JWTs', () => {
    expect(redactSecrets('token a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8 used')).toBe('token [redacted] used')
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('[redacted]')
  })

  it('keeps ordinary messages, paths and model ids', () => {
    const msg = 'Couldn’t reach Ollama at http://127.0.0.1:11434 (ECONNREFUSED) for qwen/qwen3-coder-30b-a3b-instruct in /Users/me/projects/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8.md'
    expect(redactSecrets(msg)).toBe(msg)
  })
})
