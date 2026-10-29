import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/context/system-prompt.js'
import { loadExtensions, parseFrontmatter, skillSlug, type Skill } from '../src/extensions/loader.js'
import { Agent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { StreamEvent } from '../src/providers/types.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { saveSkillTool, skillTool } from '../src/tools/skills.js'
import type { SkillAccess } from '../src/tools/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, ctx, tmpDir } from './helpers.js'

function writeSkillFile(root: string, folder: string, content: string): string {
  const dir = path.join(root, 'skills', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
  return dir
}

const skillMd = (name: string, description: string, body = 'Steps.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

describe('skill loader', () => {
  it('reads name and description from frontmatter, quoted or folded', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: "Say \\"hi\\""\n---\nbody').fields).toEqual({ name: 'a', description: 'Say "hi"' })
    const folded = parseFrontmatter("---\ndescription: >\n  Two\n  lines\nother: 'x'\n---\n").fields
    expect(folded).toEqual({ description: 'Two lines', other: 'x' })
  })

  it('loads skills from user, project and claude folders; project beats user beats claude', async () => {
    const cwd = tmpDir()
    const user = tmpDir()
    const claude = tmpDir()
    writeSkillFile(claude, 'deploy', skillMd('deploy', 'claude deploy'))
    writeSkillFile(claude, 'review', skillMd('review', 'claude review'))
    writeSkillFile(user, 'deploy', skillMd('deploy', 'user deploy'))
    writeSkillFile(user, 'release', skillMd('release', 'user release'))
    writeSkillFile(path.join(cwd, '.harness'), 'release', skillMd('release', 'project release'))
    // No frontmatter: the folder name and first line stand in.
    writeSkillFile(user, 'notes', '# Keep notes tidy\nMore.')
    // A folder without SKILL.md is ignored.
    fs.mkdirSync(path.join(user, 'skills', 'empty'), { recursive: true })

    const ext = await loadExtensions(cwd, { user: false, project: false, userDir: user, claudeDir: claude })
    const by = Object.fromEntries(ext.skills.map((s) => [s.name, `${s.source}: ${s.description}`]))
    expect(by).toEqual({
      deploy: 'user: user deploy',
      notes: 'user: Keep notes tidy',
      release: 'project: project release',
      review: 'claude: claude review',
    })
    expect(ext.skills.map((s) => s.name)).toEqual(['deploy', 'notes', 'release', 'review'])
    expect(ext.skills.find((s) => s.name === 'release')!.dir).toBe(path.join(cwd, '.harness', 'skills', 'release'))
    expect(ext.errors).toEqual([])
  })

  it('makes folder-safe slugs', () => {
    expect(skillSlug('Cut a Release!')).toBe('cut-a-release')
    expect(skillSlug('Ünvan_Çek')).toBe('unvan-cek')
    expect(skillSlug('!!!')).toBe('')
  })
})

describe('skill tools', () => {
  function access(over: Partial<SkillAccess> = {}): SkillAccess {
    return { list: [], dirs: { user: path.join(tmpDir(), 'skills'), project: path.join(tmpDir(), 'skills') }, ...over }
  }

  it('skill returns the body and the other files in the folder', async () => {
    const root = tmpDir()
    const dir = writeSkillFile(root, 'deploy', skillMd('deploy', 'Ship it', 'Run ./ship.sh'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.writeFileSync(path.join(dir, 'scripts', 'ship.sh'), 'echo')
    const skill: Skill = { name: 'deploy', description: 'Ship it', dir, file: path.join(dir, 'SKILL.md'), source: 'user' }
    const r = await skillTool.execute({ name: 'Deploy' }, ctx(root, { skills: access({ list: [skill] }) }))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('Run ./ship.sh')
    expect(r.content).not.toContain('description:')
    expect(r.content).toContain('- scripts/ship.sh')
    expect(r.content).not.toContain('- SKILL.md')

    const missing = await skillTool.execute({ name: 'nope' }, ctx(root, { skills: access({ list: [skill] }) }))
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('Available: deploy')
  })

  it('save_skill writes SKILL.md in the chosen scope and reports updates', async () => {
    const a = access()
    const saved: Skill[] = []
    a.added = (s) => saved.push(s)
    const r = await saveSkillTool.execute({ name: 'Run E2E Tests', description: 'How to run\nthe e2e suite', body: '1. pnpm e2e' }, ctx(tmpDir(), { skills: a }))
    expect(r.content).toMatch(/^Saved skill "run-e2e-tests"/)
    const file = path.join(a.dirs.user, 'run-e2e-tests', 'SKILL.md')
    const ext = await loadExtensions(tmpDir(), { user: false, project: false, userDir: path.dirname(a.dirs.user), claudeDir: tmpDir() })
    expect(ext.skills).toEqual([{ name: 'run-e2e-tests', description: 'How to run the e2e suite', dir: path.dirname(file), file, source: 'user' }])
    expect(fs.readFileSync(file, 'utf8')).toContain('1. pnpm e2e')
    expect(saved.map((s) => s.name)).toEqual(['run-e2e-tests'])

    const again = await saveSkillTool.execute({ name: 'run-e2e-tests', description: 'd', body: 'b' }, ctx(tmpDir(), { skills: { ...a, list: saved } }))
    expect(again.content).toMatch(/^Updated/)

    const p = await saveSkillTool.execute({ name: 'local', description: 'd', body: 'b', scope: 'project' }, ctx(tmpDir(), { skills: a }))
    expect(p.isError).toBeFalsy()
    expect(fs.existsSync(path.join(a.dirs.project, 'local', 'SKILL.md'))).toBe(true)
  })

  it('save_skill runs without asking outside plan mode', () => {
    const p = new Permissions({ mode: 'ask', allow: [], deny: [], allowOutsideWorkspace: false }, '/p')
    expect(p.check(saveSkillTool, 'user: x').decision).toBe('allow')
    p.setMode('plan')
    expect(p.check(saveSkillTool, 'user: x').decision).toBe('deny')
  })
})

describe('skills in the prompt and the agent', () => {
  const base = { cwd: '/p', mode: 'ask' as const, model: 'm', instructionFiles: [], customInstructions: '', override: '' }

  it('lists skills only when the skill tool is available', () => {
    const skills = [{ name: 'deploy', description: 'Ship it' }]
    expect(buildSystemPrompt({ ...base, toolNames: ['skill', 'save_skill'], skills })).toContain('- deploy: Ship it')
    expect(buildSystemPrompt({ ...base, toolNames: ['skill'], skills: [] })).not.toContain('# Skills')
    expect(buildSystemPrompt({ ...base, toolNames: [], skills })).not.toContain('# Skills')
    const saveOnly = buildSystemPrompt({ ...base, toolNames: ['skill', 'save_skill'], skills: [] })
    expect(saveOnly).toContain('save_skill')
    expect(saveOnly).not.toContain('load it with the skill tool')
  })

  function agentWith(script: StreamEvent[][], skills: Skill[] | undefined, userSkillsDir: string) {
    const dir = tmpDir()
    const provider = new MockProvider(script)
    const registry = new ProviderRegistry([], () => undefined)
    registry.register(provider)
    const settings = defaultSettings()
    const agent = new Agent({
      session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
      registry,
      tools: builtinTools(),
      settings,
      usage: new UsageTracker(null),
      permissions: new Permissions(settings.permissions, dir),
      skills,
      userSkillsDir,
      askPermission: async () => {
        throw new Error('should not ask')
      },
      onEvent: () => {},
    })
    return { agent, provider }
  }

  it('saves a skill in ask mode without asking, then can load it in the same chat', async () => {
    const user = path.join(tmpDir(), 'skills')
    const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } })
    const { agent, provider } = agentWith(
      [
        [call('1', 'save_skill', { name: 'bump', description: 'Bump versions', body: 'Edit three package.json files.' })],
        [call('2', 'skill', { name: 'bump' })],
        [{ type: 'text', delta: 'Done.' }],
      ],
      [],
      user,
    )
    await agent.send('save that')
    expect(fs.existsSync(path.join(user, 'bump', 'SKILL.md'))).toBe(true)
    const tools = provider.requests[0].tools?.map((t) => t.name)
    expect(tools).toContain('skill')
    expect(tools).toContain('save_skill')
    const loaded = agent.session.messages.find((m) => m.role === 'tool' && m.toolCallId === '2')
    expect(loaded?.content).toContain('Edit three package.json files.')
    // The next request lists the new skill.
    expect(provider.requests[2].messages[0].content).toContain('- bump: Bump versions')
  })

  it('hides the skill tools when skills are off', async () => {
    const { agent, provider } = agentWith([[{ type: 'text', delta: 'hi' }]], undefined, tmpDir())
    await agent.send('hi')
    const tools = provider.requests[0].tools?.map((t) => t.name)
    expect(tools).not.toContain('skill')
    expect(tools).not.toContain('save_skill')
    expect(provider.requests[0].messages[0].content).not.toContain('# Skills')
  })
})
