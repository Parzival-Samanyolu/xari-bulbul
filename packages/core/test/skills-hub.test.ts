import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensions } from '../src/extensions/loader.js'
import { SKILL_CATALOG } from '../src/skills/catalog.js'
import {
  installSkill,
  listRepoSkills,
  parseRepoRef,
  readInstalledSkills,
  searchSkillRepos,
  skillFileUrl,
  writeInstalledSkills,
  type InstalledSkill,
} from '../src/skills/hub.js'

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const PIN = 'b'.repeat(40)
const SKILL = '---\nname: tidy-tests\ndescription: Clean up flaky tests\n---\n\nRun the suite twice.\n'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-hub-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A fetch that serves `routes` (exact URLs) and 404s the rest; records what was asked. */
function server(routes: Record<string, string | object>) {
  const asked: string[] = []
  const f = (async (url: string | URL) => {
    const u = String(url)
    asked.push(u)
    const body = routes[u]
    if (body === undefined) return new Response('no', { status: 404 })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { f, asked }
}

const src = { repo: 'acme/skills', path: 'skills/tidy-tests', pin: PIN }
const raw = (file: string) => skillFileUrl(src, file)

describe('installSkill', () => {
  it('installs into <skillsDir>/<id> where the loader finds it, with checksums', async () => {
    const { f } = server({ [raw('SKILL.md')]: SKILL, [raw('scripts/run.sh')]: 'echo hi\n' })
    const skillsDir = path.join(tmp, 'home', 'skills')
    const files = await installSkill(
      { ...src, id: 'tidy-tests', files: [{ path: 'SKILL.md', sha256: sha(SKILL) }, { path: 'scripts/run.sh' }] },
      { skillsDir, fetch: f },
    )
    expect(files).toEqual([
      { path: 'SKILL.md', sha256: sha(SKILL), size: SKILL.length },
      { path: 'scripts/run.sh', sha256: sha('echo hi\n'), size: 8 },
    ])
    expect(fs.readFileSync(path.join(skillsDir, 'tidy-tests', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
    const ext = await loadExtensions(path.join(tmp, 'project'), { user: true, project: false, userDir: path.join(tmp, 'home'), claudeDir: path.join(tmp, 'none') })
    expect(ext.skills.map((s) => s.name)).toEqual(['tidy-tests'])
  })

  it('writes nothing when a checksum is wrong', async () => {
    const { f } = server({ [raw('SKILL.md')]: SKILL })
    const skillsDir = path.join(tmp, 'skills')
    await expect(installSkill({ ...src, id: 'tidy-tests', files: [{ path: 'SKILL.md', sha256: sha('other') }] }, { skillsDir, fetch: f })).rejects.toThrow(/Checksum mismatch/)
    expect(fs.existsSync(path.join(skillsDir, 'tidy-tests'))).toBe(false)
  })

  it("doesn't overwrite an existing folder unless asked to", async () => {
    const { f } = server({ [raw('SKILL.md')]: SKILL })
    const skillsDir = path.join(tmp, 'skills')
    fs.mkdirSync(path.join(skillsDir, 'tidy-tests'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'tidy-tests', 'SKILL.md'), 'mine')
    const s = { ...src, id: 'tidy-tests', files: [{ path: 'SKILL.md' }] }
    await expect(installSkill(s, { skillsDir, fetch: f })).rejects.toThrow(/already exists/)
    await installSkill(s, { skillsDir, fetch: f, replace: true })
    expect(fs.readFileSync(path.join(skillsDir, 'tidy-tests', 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('refuses paths that leave the folder, missing SKILL.md, and unpinned commits', async () => {
    const { f } = server({})
    const opts = { skillsDir: path.join(tmp, 'skills'), fetch: f }
    await expect(installSkill({ ...src, id: 'x', files: [{ path: 'SKILL.md' }, { path: '../evil.sh' }] }, opts)).rejects.toThrow(/leaves the plugin folder/)
    await expect(installSkill({ ...src, id: 'x', files: [{ path: 'README.md' }] }, opts)).rejects.toThrow(/no SKILL.md/)
    await expect(installSkill({ ...src, pin: 'main', id: 'x', files: [{ path: 'SKILL.md' }] }, opts)).rejects.toThrow(/commit pin/)
    await expect(installSkill({ ...src, id: '../x', files: [{ path: 'SKILL.md' }] }, opts)).rejects.toThrow(/Invalid skill id/)
  })
})

describe('listRepoSkills', () => {
  it('finds each skill folder at the default branch commit, with its own files only', async () => {
    const api = 'https://api.github.com/repos/acme/skills'
    const at = (p: string, file: string) => skillFileUrl({ repo: 'acme/skills', path: p, pin: PIN }, file)
    const { f } = server({
      [api]: { default_branch: 'main', license: { spdx_id: 'MIT' } },
      [`${api}/commits/main`]: { sha: PIN },
      [`${api}/git/trees/${PIN}?recursive=1`]: {
        tree: [
          { path: 'README.md', type: 'blob', size: 10 },
          { path: 'skills/tidy-tests/SKILL.md', type: 'blob', size: 60 },
          { path: 'skills/tidy-tests/scripts/run.py', type: 'blob', size: 5 },
          { path: 'skills/tidy-tests/.DS_Store', type: 'blob', size: 5 },
          { path: 'skills/tidy-tests/inner/SKILL.md', type: 'blob', size: 40 },
          { path: 'skills/docs/SKILL.md', type: 'blob', size: 30 },
          { path: 'skills/docs', type: 'tree' },
        ],
      },
      [at('skills/tidy-tests', 'SKILL.md')]: SKILL,
      [at('skills/tidy-tests/inner', 'SKILL.md')]: '---\nname: Inner One\ndescription: nested\n---\n',
      [at('skills/docs', 'SKILL.md')]: '# Write docs\n\nKeep them short.',
    })
    const found = await listRepoSkills('acme/skills', { fetch: f })
    const byId = Object.fromEntries(found.map((s) => [s.id, s]))
    expect(Object.keys(byId).sort()).toEqual(['docs', 'inner-one', 'tidy-tests'])
    expect(byId['tidy-tests']).toMatchObject({ pin: PIN, path: 'skills/tidy-tests', license: 'MIT', scripts: true, description: 'Clean up flaky tests', tokens: { listed: 9, loaded: 15 } })
    expect(byId['tidy-tests'].files.map((x) => x.path)).toEqual(['SKILL.md', 'scripts/run.py'])
    expect(byId.docs).toMatchObject({ name: 'docs', description: 'Write docs', scripts: false })

    const only = await listRepoSkills('acme/skills', { fetch: f, under: 'skills/docs' })
    expect(only.map((s) => s.id)).toEqual(['docs'])
  })
})

describe('searchSkillRepos', () => {
  it('searches both skill topics and merges by stars', async () => {
    const q = (topic: string) => `https://api.github.com/search/repositories?q=${encodeURIComponent(`git topic:${topic}`)}&sort=stars&per_page=20`
    const item = (name: string, stars: number) => ({ full_name: name, description: 'd', stargazers_count: stars, html_url: `https://github.com/${name}`, license: { spdx_id: 'MIT' } })
    const { f } = server({
      [q('agent-skills')]: { items: [item('a/one', 5), item('b/two', 50)] },
      [q('claude-skills')]: { items: [item('a/one', 5), item('c/three', 20)] },
    })
    expect((await searchSkillRepos('  git ', { fetch: f })).map((r) => r.repo)).toEqual(['b/two', 'c/three', 'a/one'])
  })

  it('says so when GitHub rate-limits', async () => {
    const f = (async () => new Response('slow down', { status: 403 })) as unknown as typeof fetch
    await expect(searchSkillRepos('git', { fetch: f })).rejects.toThrow(/rate-limiting/)
  })
})

describe('parseRepoRef', () => {
  it('reads owner/name and github.com URLs, including folder links', () => {
    expect(parseRepoRef('acme/skills')).toEqual({ repo: 'acme/skills', path: '' })
    expect(parseRepoRef('https://github.com/acme/skills.git')).toEqual({ repo: 'acme/skills', path: '' })
    expect(parseRepoRef('github.com/acme/skills/tree/main/skills/docs/')).toEqual({ repo: 'acme/skills', path: 'skills/docs' })
    expect(parseRepoRef('just words')).toBeNull()
  })
})

describe('skills.json', () => {
  it('round-trips and drops bad entries', () => {
    const rec: InstalledSkill = { ...src, id: 'tidy-tests', reviewed: false, license: 'MIT', installedAt: 1, files: [{ path: 'SKILL.md', sha256: sha(SKILL) }] }
    writeInstalledSkills(tmp, [rec, { ...rec, id: '../bad' }])
    expect(readInstalledSkills(tmp)).toEqual([rec])
    expect(readInstalledSkills(path.join(tmp, 'missing'))).toEqual([])
  })
})

describe('SKILL_CATALOG', () => {
  it('pins every entry and has unique ids', () => {
    const ids = new Set<string>()
    for (const s of SKILL_CATALOG) {
      expect(s.pin).toMatch(/^[0-9a-f]{40}$/)
      expect(s.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(ids.has(s.id)).toBe(false)
      ids.add(s.id)
      expect(s.files.some((f) => f.path === 'SKILL.md')).toBe(true)
      for (const f of s.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(s.license).toBeTruthy()
      expect(s.tokens.listed).toBeGreaterThan(0)
      expect(s.tokens.loaded).toBeGreaterThan(0)
    }
  })
})
