// Skills from public GitHub repos: a reviewed catalog (pinned commits, sha256 per file) plus a
// search over GitHub for anything else. Both install into the user skills folder
// (`~/.harness/skills/<id>/`), which the extension loader already reads.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter, skillSlug } from '../extensions/loader.js'
import { checkPluginPath, refuseSymlinks } from '../plugins/install.js'

export interface SkillFile {
  /** Relative to the skill folder, with `/` separators. */
  path: string
  /** Checked on install when set (catalog entries); computed on download otherwise. */
  sha256?: string
  size?: number
}

/** Where a skill lives: a folder with a SKILL.md in a GitHub repo at a fixed commit. */
export interface SkillSource {
  repo: string
  /** The skill folder in the repo; '' when SKILL.md is at the top. */
  path: string
  /** Full commit sha. */
  pin: string
}

export interface CatalogSkill extends SkillSource {
  /** Also the folder name it installs under. */
  id: string
  name: string
  description: string
  /** SPDX id. */
  license: string
  files: SkillFile[]
  /** Has files the agent might run (Python, shell, JS…). */
  scripts: boolean
  tokens: SkillTokens
}

/** A skill found in a repo by `listRepoSkills`: not reviewed, files not pinned to checksums yet. */
export interface FoundSkill extends SkillSource {
  id: string
  name: string
  description: string
  /** The repo's license (SPDX id), or '' when GitHub knows none. */
  license: string
  files: SkillFile[]
  scripts: boolean
  bytes: number
  tokens: SkillTokens
}

/** One entry of `<dataDir>/skills.json`. */
export interface InstalledSkill extends SkillSource {
  id: string
  /** Came from the reviewed catalog (checksums known in advance). */
  reviewed: boolean
  license: string
  installedAt: number
  files: SkillFile[]
}

export interface RepoHit {
  repo: string
  description: string
  stars: number
  license: string
  url: string
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MAX_FILES = 100
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_SKILL_BYTES = 10 * 1024 * 1024
const SCRIPT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i
const API = 'https://api.github.com'

export const skillsFile = (dataDir: string) => path.join(dataDir, 'skills.json')

export function readInstalledSkills(dataDir: string): InstalledSkill[] {
  try {
    const raw = JSON.parse(fs.readFileSync(skillsFile(dataDir), 'utf8'))
    const list: unknown[] = Array.isArray(raw?.skills) ? raw.skills : []
    return list.filter((s): s is InstalledSkill => !!s && typeof (s as InstalledSkill).id === 'string' && ID.test((s as InstalledSkill).id))
  } catch {
    return []
  }
}

export function writeInstalledSkills(dataDir: string, list: InstalledSkill[]): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const target = skillsFile(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ skills: list }, null, 2))
  fs.renameSync(tmp, target)
}

export const hasScripts = (files: SkillFile[]) => files.some((f) => SCRIPT.test(f.path))

/** Rough token cost of a skill: `listed` is its line in every request's system prompt, `loaded` what the skill tool adds when the agent loads it. */
export interface SkillTokens {
  listed: number
  loaded: number
}

/** About 4 characters (or UTF-8 bytes) a token for English prose. */
export function skillTokens(name: string, description: string, skillMdBytes: number): SkillTokens {
  return { listed: Math.ceil(`- ${name}: ${description}\n`.length / 4), loaded: Math.ceil(skillMdBytes / 4) }
}

/** Raw download URL of one file of a skill at its pinned commit. */
export function skillFileUrl(s: SkillSource, file: string): string {
  return `https://raw.githubusercontent.com/${s.repo}/${s.pin}/${s.path ? `${s.path}/` : ''}${file}`
}

/** The skill folder on GitHub at its pinned commit. */
export function skillTreeUrl(s: SkillSource): string {
  return `https://github.com/${s.repo}/tree/${s.pin}${s.path ? `/${s.path}` : ''}`
}

const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

function checkSource(s: SkillSource) {
  if (!REPO.test(s.repo)) throw new Error(`"${s.repo}" isn't a GitHub repo (owner/name).`)
  if (!/^[0-9a-f]{40}$/.test(s.pin)) throw new Error('The skill has no commit pin.')
  if (s.path) for (const part of s.path.split('/')) if (!part || part === '.' || part === '..') throw new Error(`Refused skill path "${s.path}".`)
}

export interface SkillInstallOptions {
  /** `~/.harness/skills`. */
  skillsDir: string
  /** Replace an existing folder with this id (an update). Otherwise an existing folder is an error. */
  replace?: boolean
  fetch?: typeof fetch
  signal?: AbortSignal
}

/**
 * Downloads every file of a skill at its pinned commit into `<skillsDir>/<id>/`. Files with a
 * sha256 must match it. Nothing is written until every file is downloaded, and a failure leaves
 * an older install as it was. Returns the files with their sha256.
 */
export async function installSkill(s: SkillSource & { id: string; files: SkillFile[] }, opts: SkillInstallOptions): Promise<SkillFile[]> {
  checkSource(s)
  if (!ID.test(s.id)) throw new Error(`Invalid skill id "${s.id}".`)
  if (!s.files.length || s.files.length > MAX_FILES) throw new Error(`A skill can have 1–${MAX_FILES} files; this one has ${s.files.length}.`)
  const seen = new Set<string>()
  for (const f of s.files) {
    checkPluginPath(f.path)
    if (seen.has(f.path.toLowerCase())) throw new Error(`Skill file "${f.path}" is listed twice.`)
    seen.add(f.path.toLowerCase())
    if (f.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`Skill file "${f.path}" has a bad sha256.`)
  }
  if (!seen.has('skill.md')) throw new Error('The folder has no SKILL.md.')
  const dir = path.join(opts.skillsDir, s.id)
  if (!opts.replace && fs.existsSync(dir)) throw new Error(`A skill folder named "${s.id}" already exists.`)

  const doFetch = opts.fetch ?? fetch
  const data = new Map<string, Uint8Array>()
  let total = 0
  for (const f of s.files) {
    let res = await doFetch(skillFileUrl(s, f.path), { signal: opts.signal, redirect: 'error' })
    // raw.githubusercontent.com sometimes answers 5xx for a moment.
    for (let i = 0; i < 2 && res.status >= 500; i++) {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      res = await doFetch(skillFileUrl(s, f.path), { signal: opts.signal, redirect: 'error' })
    }
    if (!res.ok) throw new Error(`Couldn't download ${f.path} (HTTP ${res.status}).`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${f.path} is larger than 5 MB.`)
    total += bytes.byteLength
    if (total > MAX_SKILL_BYTES) throw new Error('The skill is larger than 10 MB.')
    if (f.sha256 && sha256(bytes) !== f.sha256) throw new Error(`Checksum mismatch for ${f.path}. Nothing was installed.`)
    data.set(f.path, bytes)
  }
  const manifest = parseFrontmatter(Buffer.from(data.get(s.files.find((f) => f.path.toLowerCase() === 'skill.md')!.path)!).toString('utf8'))
  if (!manifest.fields.description && !manifest.body.trim()) throw new Error('SKILL.md is empty.')

  fs.mkdirSync(opts.skillsDir, { recursive: true })
  refuseSymlinks(opts.skillsDir, dir)
  const staging = fs.mkdtempSync(path.join(opts.skillsDir, `.${s.id}-`))
  try {
    for (const [rel, bytes] of data) {
      const abs = path.join(staging, ...rel.split('/'))
      if (path.relative(staging, abs).startsWith('..')) throw new Error(`Refused skill file "${rel}".`)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, bytes, { flag: 'wx' })
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw e
  }
  return s.files.map((f) => ({ path: f.path, sha256: sha256(data.get(f.path)!), size: data.get(f.path)!.byteLength }))
}

async function getJson<T>(url: string, doFetch: typeof fetch, signal?: AbortSignal): Promise<T> {
  const res = await doFetch(url, { signal, headers: { Accept: 'application/vnd.github+json' } })
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting searches from this network. Try again in a few minutes.')
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`)
  return (await res.json()) as T
}

/** `owner/name` from `owner/name`, a github.com URL, or a URL to a folder in it. */
export function parseRepoRef(input: string): { repo: string; path: string } | null {
  const s = input.trim().replace(/\.git$/, '')
  const url = s.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+\/[^/\s]+)(?:\/tree\/[^/\s]+\/(.+?))?\/?$/)
  if (url) return REPO.test(url[1]) ? { repo: url[1], path: url[2] ?? '' } : null
  return REPO.test(s) ? { repo: s, path: '' } : null
}

/** Public GitHub repos tagged as agent/Claude skills that match `query`, most stars first. */
export async function searchSkillRepos(query: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<RepoHit[]> {
  const doFetch = opts.fetch ?? fetch
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 100)
  type Res = { items?: { full_name: string; description: string | null; stargazers_count: number; html_url: string; license: { spdx_id?: string } | null }[] }
  const out = new Map<string, RepoHit>()
  for (const topic of ['agent-skills', 'claude-skills']) {
    const r = await getJson<Res>(`${API}/search/repositories?q=${encodeURIComponent(`${q} topic:${topic}`.trim())}&sort=stars&per_page=20`, doFetch, opts.signal)
    for (const i of r.items ?? []) {
      out.set(i.full_name, { repo: i.full_name, description: i.description ?? '', stars: i.stargazers_count, license: spdx(i.license), url: i.html_url })
    }
  }
  return [...out.values()].sort((a, b) => b.stars - a.stars)
}

const spdx = (l: { spdx_id?: string } | null | undefined) => (l?.spdx_id && l.spdx_id !== 'NOASSERTION' ? l.spdx_id : '')

/**
 * Every skill folder (one with a SKILL.md) in a repo at its current default-branch commit, or
 * only those below `under`. Reads each SKILL.md for its name and description.
 */
export async function listRepoSkills(repo: string, opts: { under?: string; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<FoundSkill[]> {
  if (!REPO.test(repo)) throw new Error(`"${repo}" isn't a GitHub repo (owner/name).`)
  const doFetch = opts.fetch ?? fetch
  const info = await getJson<{ default_branch: string; license: { spdx_id?: string } | null }>(`${API}/repos/${repo}`, doFetch, opts.signal)
  const commit = await getJson<{ sha: string }>(`${API}/repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`, doFetch, opts.signal)
  const tree = await getJson<{ tree: { path: string; type: string; size?: number }[] }>(`${API}/repos/${repo}/git/trees/${commit.sha}?recursive=1`, doFetch, opts.signal)
  const blobs = tree.tree.filter((e) => e.type === 'blob')
  const under = (opts.under ?? '').replace(/^\/+|\/+$/g, '')
  const dirs = blobs
    .filter((e) => /(^|\/)SKILL\.md$/.test(e.path))
    .map((e) => path.posix.dirname(e.path).replace(/^\.$/, ''))
    .filter((d) => !under || d === under || d.startsWith(`${under}/`))
  const found: FoundSkill[] = []
  for (const d of dirs.slice(0, 60)) {
    const prefix = d ? `${d}/` : ''
    // A nested skill folder belongs to itself, not to the folder above it.
    const nested = dirs.filter((x) => x !== d && (d === '' || x.startsWith(prefix)))
    const files = blobs
      .filter((e) => e.path.startsWith(prefix) && !nested.some((n) => e.path.startsWith(`${n}/`)))
      .map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }))
      .filter((f) => !f.path.split('/').some((p) => p.startsWith('.')))
    const bytes = files.reduce((n, f) => n + f.size, 0)
    if (files.length > MAX_FILES || bytes > MAX_SKILL_BYTES) continue
    if (files.some((f) => { try { checkPluginPath(f.path); return false } catch { return true } })) continue
    const src = { repo, path: d, pin: commit.sha }
    const res = await doFetch(skillFileUrl(src, 'SKILL.md'), { signal: opts.signal })
    if (!res.ok) continue
    const { fields, body } = parseFrontmatter(await res.text())
    const name = fields.name || path.posix.basename(d) || repo.split('/')[1]
    const id = skillSlug(name)
    if (!id) continue
    const description = fields.description || body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200)
    const md = files.find((f) => f.path === 'SKILL.md')?.size ?? 0
    found.push({ ...src, id, name, description, license: spdx(info.license), files, scripts: hasScripts(files), bytes, tokens: skillTokens(name, description, md) })
  }
  return found
}
