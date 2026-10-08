import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, loadProjectInstructions, type SystemPromptInput } from '../src/context/system-prompt.js'
import { displayName, matchesQuery, perMillion, pickerSections, pushRecent, sortModels } from '../src/providers/catalog.js'
import { builtinTools } from '../src/tools/index.js'
import type { ModelInfo } from '../src/types.js'
import { tmpDir } from './helpers.js'

const env = {
  date: '2026-10-08',
  platform: 'darwin',
  osRelease: '25.0.0',
  shell: 'zsh',
  git: { branch: 'main', status: [' M src/app.ts', '?? notes.md'], truncated: 0 },
}

const base: SystemPromptInput = {
  cwd: '/work/proj',
  mode: 'ask',
  model: 'openrouter/free',
  contextLength: 200_000,
  instructionFiles: ['AGENTS.md', 'HARNESS.md', 'CLAUDE.md'],
  customInstructions: '',
  override: '',
  toolNames: builtinTools().map((t) => t.name),
  memory: { global: ['Prefers pnpm'], project: [] },
  env,
}

describe('system prompt', () => {
  for (const mode of ['ask', 'acceptEdits', 'plan', 'auto'] as const) {
    it(`matches the snapshot in ${mode} mode`, () => {
      expect(buildSystemPrompt({ ...base, mode })).toMatchSnapshot()
    })
  }

  it('matches the snapshot for a subagent', () => {
    const toolNames = base.toolNames.filter((n) => !['task', 'todo_write', 'remember', 'forget'].includes(n))
    expect(buildSystemPrompt({ ...base, toolNames, subagent: { description: 'Find config loaders' } })).toMatchSnapshot()
  })

  it('names itself Xarı Bülbül and never another product', () => {
    const p = buildSystemPrompt(base)
    expect(p).toMatch(/^You are Xarı Bülbül/)
    expect(p).not.toMatch(/Claude Code|Codex|Cursor|ChatGPT/)
  })

  it('drops git rules outside a repository and replaces the base with an override', () => {
    expect(buildSystemPrompt({ ...base, env: { ...env, git: undefined } })).not.toContain('# Git\n')
    const o = buildSystemPrompt({ ...base, override: 'Custom base.' })
    expect(o.startsWith('Custom base.\n\n')).toBe(true)
    expect(o).not.toContain('# Tone')
    expect(o).toContain('# Environment')
  })

  it('reads project instructions nearest first, up to the repository root', () => {
    const root = tmpDir()
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, 'pkg', 'app'), { recursive: true })
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rules')
    fs.writeFileSync(path.join(root, 'pkg', 'app', 'CLAUDE.md'), 'app rules')
    const got = loadProjectInstructions(path.join(root, 'pkg', 'app'), ['AGENTS.md', 'CLAUDE.md'])
    expect(got).toEqual([
      { file: 'CLAUDE.md', content: 'app rules' },
      { file: path.join('..', '..', 'AGENTS.md'), content: 'root rules' },
    ])
    const p = buildSystemPrompt({ ...base, cwd: path.join(root, 'pkg', 'app') })
    expect(p.indexOf('app rules')).toBeLessThan(p.indexOf('root rules'))
  })
})

describe('model catalog', () => {
  const m = (id: string, o: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, providerId: 'or', free: false, supportsTools: true, ...o })
  const models = {
    or: [
      m('a/free', { free: true, created: 3, pricing: { prompt: 0, completion: 0 }, contextLength: 8000 }),
      m('b/paid', { created: 5, pricing: { prompt: 1e-6, completion: 2e-6 }, contextLength: 200000 }),
      m('c/free', { free: true, created: 1, pricing: { prompt: 0, completion: 0 }, supportsTools: false }),
    ],
    local: [m('llama', { providerId: 'local' })],
  }

  it('opens on free tool-capable models, current and favorites first', () => {
    const s = pickerSections({
      models,
      providers: [{ id: 'or', name: 'OpenRouter' }, { id: 'local', name: 'Ollama' }],
      current: { providerId: 'or', modelId: 'b/paid' },
      favorites: [{ providerId: 'local', modelId: 'llama' }],
      recent: [],
      query: '',
      filters: { freeOnly: true, toolsOnly: true },
      sort: 'newest',
    })
    expect(s.map((x) => [x.title, x.models.map((y) => y.id)])).toEqual([
      ['Current', ['b/paid']],
      ['Favorites', ['llama']],
      ['OpenRouter', ['a/free']],
      ['Ollama', []],
    ])
  })

  it('sorts, searches, names and prices', () => {
    expect(sortModels(models.or, 'context').map((x) => x.id)[0]).toBe('b/paid')
    expect(sortModels(models.or, 'newest').map((x) => x.id)).toEqual(['b/paid', 'a/free', 'c/free'])
    expect(matchesQuery(models.or[0], 'free a/')).toBe(true)
    expect(matchesQuery(models.or[1], 'free')).toBe(false)
    expect(displayName(m('x', { name: 'Qwen: Qwen3 27B (free)' }))).toBe('Qwen3 27B')
    expect(perMillion(3e-7)).toBe('$0.3/M')
    expect(perMillion(1.5e-5)).toBe('$15/M')
    const r = pushRecent([{ providerId: 'a', modelId: '1' }, { providerId: 'a', modelId: '2' }], { providerId: 'a', modelId: '2' })
    expect(r.map((x) => x.modelId)).toEqual(['2', '1'])
  })
})
