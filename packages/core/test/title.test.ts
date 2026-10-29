import { describe, expect, it } from 'vitest'
import { cleanTitle, generateTitle } from '../src/sessions/title.js'
import { MockProvider } from './helpers.js'

describe('chat titles', () => {
  it('asks the model and returns a cleaned title with usage', async () => {
    const p = new MockProvider([
      [
        { type: 'text', delta: '"Fix flaky login ' },
        { type: 'text', delta: 'test."' },
        { type: 'usage', usage: { promptTokens: 50, completionTokens: 6 } },
      ],
    ])
    const r = await generateTitle(p, 'm', 'the login test fails sometimes, can you look')
    expect(r.title).toBe('Fix flaky login test')
    expect(r.usage?.completionTokens).toBe(6)
    expect(p.requests[0].messages.at(-1)?.content).toContain('login test fails')
  })

  it('strips reasoning, labels and markdown', () => {
    expect(cleanTitle('<think>hmm</think>\nTitle: **Add OLED theme**')).toBe('Add OLED theme')
    expect(cleanTitle('Sure.\n\nRename sidebar folders')).toBe('Rename sidebar folders')
    expect(cleanTitle('   ')).toBe('')
    expect(cleanTitle('x'.repeat(80))).toHaveLength(58)
  })
})
