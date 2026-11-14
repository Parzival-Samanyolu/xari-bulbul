// Builds src/skills/catalog.ts from the reviewed list below: pins each repo at its current
// default-branch commit, downloads every file of each skill and records its sha256.
//
//   cd packages/core && GITHUB_TOKEN=$(gh auth token) npx tsx scripts/skill-catalog.ts
//
// Review what changed (`git diff src/skills/catalog.ts`, and the skills themselves on GitHub)
// before committing: the catalog is what the app installs without asking twice.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installSkill, listRepoSkills, skillTokens, type CatalogSkill } from '../src/skills/hub.js'

/** Repo, the folders to take (each a skill folder, or a folder of skills), and the license to show. */
interface Pick {
  repo: string
  skills: string[]
  /** SPDX id; required, because GitHub's guess can be wrong or missing for skill repos. */
  license: string
}

export const PICKS: Pick[] = [
  {
    repo: 'anthropics/skills',
    // The Office skills moved to Apache-2.0 on 2026-11-06 (commit 2c5958ec); pin after that.
    skills: ['skills/docx', 'skills/pdf', 'skills/pptx', 'skills/xlsx', 'skills/frontend-design', 'skills/mcp-builder', 'skills/skill-creator', 'skills/webapp-testing', 'skills/theme-factory'],
    license: 'Apache-2.0',
  },
  {
    repo: 'obra/superpowers',
    skills: [
      'skills/systematic-debugging',
      'skills/test-driven-development',
      'skills/brainstorming',
      'skills/writing-plans',
      'skills/executing-plans',
      'skills/verification-before-completion',
      'skills/requesting-code-review',
      'skills/receiving-code-review',
      'skills/using-git-worktrees',
      'skills/writing-skills',
      'skills/finishing-a-development-branch',
    ],
    license: 'MIT',
  },
  {
    repo: 'addyosmani/agent-skills',
    skills: [
      'skills/code-review-and-quality',
      'skills/debugging-and-error-recovery',
      'skills/git-workflow-and-versioning',
      'skills/security-and-hardening',
      'skills/api-and-interface-design',
      'skills/performance-optimization',
      'skills/spec-driven-development',
      'skills/documentation-and-adrs',
      'skills/code-simplification',
    ],
    license: 'MIT',
  },
  {
    repo: 'mattpocock/skills',
    skills: ['skills/engineering/tdd', 'skills/engineering/code-review', 'skills/engineering/improve-codebase-architecture', 'skills/engineering/pr', 'skills/misc/setup-pre-commit', 'skills/productivity/grill-me', 'skills/productivity/handoff'],
    license: 'MIT',
  },
  {
    repo: 'vercel-labs/agent-skills',
    // MIT as declared in the README and each SKILL.md (the repo has no LICENSE file).
    skills: ['skills/react-best-practices', 'skills/composition-patterns', 'skills/web-design-guidelines', 'skills/react-native-skills', 'skills/react-view-transitions'],
    license: 'MIT',
  },
  { repo: 'supabase/agent-skills', skills: ['skills/supabase-postgres-best-practices'], license: 'MIT' },
  {
    repo: 'huggingface/skills',
    skills: ['skills/hf-cli', 'skills/huggingface-datasets', 'skills/huggingface-gradio', 'skills/transformers-js', 'skills/huggingface-papers', 'skills/huggingface-tool-builder'],
    license: 'Apache-2.0',
  },
  { repo: 'emilkowalski/skills', skills: ['skills/emil-design-eng', 'skills/animation-performance'], license: 'MIT' },
  { repo: 'blader/humanizer', skills: [''], license: 'MIT' },
]

const token = process.env.GITHUB_TOKEN
const authed: typeof fetch = (url, init) =>
  fetch(url, String(url).startsWith('https://api.github.com') && token ? { ...init, headers: { ...(init?.headers as object), Authorization: `Bearer ${token}` } } : init)

const out: CatalogSkill[] = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'))
try {
  for (const pick of PICKS) {
    for (const want of pick.skills) {
      const found = (await listRepoSkills(pick.repo, { under: want, fetch: authed })).filter((s) => s.path === want)
      if (!found.length) throw new Error(`${pick.repo}: no skill at ${want}`)
      for (const s of found) {
        if (out.some((o) => o.id === s.id)) {
          console.warn(`skip ${pick.repo}/${s.path}: id "${s.id}" is taken`)
          continue
        }
        const files = await installSkill(s, { skillsDir: tmp, fetch: authed })
        const description = s.description.replace(/\s+/g, ' ').trim()
        const md = files.find((f) => f.path === 'SKILL.md')?.size ?? 0
        out.push({ id: s.id, name: s.name, description, repo: s.repo, path: s.path, pin: s.pin, license: pick.license, files: files.map(({ path, sha256 }) => ({ path, sha256 })), scripts: s.scripts, tokens: skillTokens(s.name, description, md) })
        console.log(`${s.id.padEnd(32)} ${pick.repo}/${s.path} (${files.length} files)`)
      }
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

const target = path.join(import.meta.dirname, '../src/skills/catalog.ts')
const head = fs.readFileSync(target, 'utf8').split('export const SKILL_CATALOG')[0]
fs.writeFileSync(target, `${head}export const SKILL_CATALOG: CatalogSkill[] = ${JSON.stringify(out, null, 2)}\n`)
console.log(`${out.length} skills → ${path.relative(process.cwd(), target)}`)
