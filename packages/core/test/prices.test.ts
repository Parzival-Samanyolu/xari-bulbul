import { describe, expect, it } from 'vitest'
import { anthropicPricing } from '../src/providers/anthropic.js'
import { isOpenAiApi, openaiCost, openaiPricing } from '../src/providers/prices.js'
import { UsageTracker } from '../src/usage/tracker.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('model prices', () => {
  it('prices OpenAI models per token, dated snapshots included', () => {
    expect(openaiPricing('gpt-6-astra')).toEqual({ prompt: 10 / 1e6, completion: 50 / 1e6 })
    expect(openaiPricing('gpt-6.1-terra-2026-10-26')).toEqual({ prompt: 1 / 1e6, completion: 5 / 1e6 })
    expect(openaiPricing('gpt-unknown')).toBeUndefined()
  })

  it('bills cached input at the cached rate', () => {
    // 1M prompt tokens, 800K of them cached, 100K output: 0.2M×$10 + 0.8M×$1 + 0.1M×$50
    expect(openaiCost('gpt-6-astra', { promptTokens: 1_000_000, cachedTokens: 800_000, completionTokens: 100_000 })).toBeCloseTo(7.8)
    expect(openaiCost('gpt-6-astra', { promptTokens: 1_000_000, completionTokens: 0, priceFactor: 0.5 })).toBeCloseTo(5)
    expect(openaiCost('nope', { promptTokens: 1, completionTokens: 1 })).toBeUndefined()
  })

  it('recognizes OpenAI’s API host only', () => {
    expect(isOpenAiApi('https://api.openai.com/v1')).toBe(true)
    expect(isOpenAiApi('https://openrouter.ai/api/v1')).toBe(false)
    expect(isOpenAiApi('not a url')).toBe(false)
  })

  it('gives Claude models picker prices', () => {
    expect(anthropicPricing('claude-sonnet-5-5')).toEqual({ prompt: 2 / 1e6, completion: 10 / 1e6 })
    expect(anthropicPricing('claude-unknown')).toBeUndefined()
  })

  it('sums plan usage at API prices apart from spend, pricing old records from their tokens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'))
    const usage = new UsageTracker(path.join(dir, 'usage.jsonl'))
    const base = { ts: Date.now(), sessionId: 's', promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0, cost: null }
    usage.record({ ...base, providerId: 'chatgpt', modelId: 'gpt-6.1-terra', apiCost: 1 })
    usage.record({ ...base, providerId: 'chatgpt', modelId: 'gpt-6.1-terra' }) // written before apiCost existed
    const s = usage.summary('s')
    expect(s.session.apiCost).toBeCloseTo(2)
    expect(s.session.cost).toBe(0)
    expect(s.session.costPartial).toBe(true)
  })
})
