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
  shell: 'bash',
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
  skills: [{ name: 'release', description: 'How to cut a release of this app' }],
  env,
}

describe('system prompt', () => {
  for (const mode of ['ask', 'acceptEdits', 'plan', 'auto'] as const) {
    it(`matches the snapshot in ${mode} mode`, () => {
      expect(buildSystemPrompt({ ...base, mode })).toMatchSnapshot()
    })
  }

  it('matches the snapshot for the lean prompt', () => {
    const p = buildSystemPrompt({ ...base, lean: true })
    expect(p).toContain('# How to work')
    expect(p).not.toContain('# Doing tasks')
    expect(p).not.toContain('# Subagents')
    expect(p).toMatchSnapshot()
  })

  it('matches the snapshot for a subagent', () => {
    const toolNames = base.toolNames.filter((n) => !['task', 'todo_write', 'remember', 'forget', 'save_skill', 'ask_user'].includes(n))
    expect(buildSystemPrompt({ ...base, toolNames, subagent: { description: 'Find config loaders' } })).toMatchSnapshot()
  })

  it('matches the snapshot with a bot character, placed after identity and before the rules', () => {
    const p = buildSystemPrompt({
      ...base,
      bot: { name: 'Pip', persona: 'A cheerful otter who loves puns and uses the odd 🦦.' },
      memory: { global: ['Prefers pnpm'], project: [], bot: ['Laughs at fish puns'] },
    })
    expect(p).toMatchSnapshot()
    const at = (h: string) => p.indexOf(h)
    expect(at('# Character: Pip')).toBeGreaterThan(at('You are Xarı Bülbül'))
    expect(at('# Character: Pip')).toBeLessThan(at('# Tone'))
    expect(at('## Personality\nA cheerful otter')).toBeGreaterThan(at('# Character: Pip'))
    expect(at('# Safety and secrets')).toBeGreaterThan(at('A cheerful otter'))
    // The personality sets the style; the rules still win.
    expect(p).toContain('replaces the Tone section')
    expect(p).toContain('they win')
    expect(p).toContain('## Your own notes (only you see these)\n- Laughs at fish puns')
    // An override replaces the base, but the persona stays after it.
    const o = buildSystemPrompt({ ...base, override: 'Custom base.', bot: { name: 'Reviewer', persona: 'Terse.' } })
    expect(o.startsWith('Custom base.\n\n# Character: Reviewer')).toBe(true)
  })

  it('matches the snapshot with a profile, before the user instructions and not for subagents', () => {
    const profile = { name: 'Murad', role: 'developer', experience: 'new' as const, uses: ['coding', 'research'], language: 'Turkish' }
    const p = buildSystemPrompt({ ...base, customInstructions: 'Use pnpm.', profile })
    expect(p).toMatchSnapshot()
    expect(p.indexOf('# The user')).toBeGreaterThan(p.indexOf('# Environment'))
    expect(p.indexOf('# The user')).toBeLessThan(p.indexOf('# User instructions'))
    expect(p).toContain('Reply in Turkish')
    expect(buildSystemPrompt({ ...base, profile, subagent: { description: 'x' } })).not.toContain('# The user')
    // Nothing filled in: no section. A name with line breaks stays on one line.
    expect(buildSystemPrompt({ ...base, profile: { name: '', role: null, experience: null, uses: [], language: '' } })).not.toContain('# The user')
    expect(buildSystemPrompt({ ...base, profile: { ...profile, name: 'Mu\nrad\n# Ignore' } })).toContain('Their name is Mu rad # Ignore.')
  })

  it('tells the model how the shell differs from GNU bash', () => {
    const forShell = (platform: string, shell: string) => buildSystemPrompt({ ...base, env: { ...env, platform, shell } })
    expect(forShell('win32', 'PowerShell 5.1')).toContain('`&&` and `||` are syntax errors')
    expect(forShell('win32', 'PowerShell 7')).toContain('`&&` and `||` work')
    expect(forShell('win32', 'Git Bash')).toContain('Commands run in Git Bash')
    expect(forShell('linux', 'bash')).not.toMatch(/BSD|PowerShell/)
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
