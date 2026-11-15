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
import { SKILL_CATALOG as PREVIOUS } from '../src/skills/catalog.js'
import { installSkill, listRepoSkills, skillTokens, type CatalogSkill, type SkillCategory, SKILL_CATEGORIES } from '../src/skills/hub.js'

/** Repo, the folders to take (each a skill folder, or a folder of skills), their group, and the license to show. A repo may appear under several groups. */
interface Pick {
  repo: string
  category: SkillCategory
  skills: string[]
  /** SPDX id; required, because GitHub's guess can be wrong or missing for skill repos. */
  license: string
}

// anthropics/skills: the Office skills moved to Apache-2.0 on 2026-11-06 (commit 2c5958ec); pin
// after that. Skills there without their own LICENSE.txt (doc-coauthoring) are left out: the repo
// has no root license. vercel-labs/agent-skills: MIT as declared in the README and each SKILL.md
// (the repo has no LICENSE file).
export const PICKS: Pick[] = [
  // Plan and ship
  {
    repo: 'obra/superpowers',
    category: 'workflow',
    skills: ['skills/brainstorming', 'skills/writing-plans', 'skills/executing-plans', 'skills/using-git-worktrees', 'skills/finishing-a-development-branch'],
    license: 'MIT',
  },
  { repo: 'addyosmani/agent-skills', category: 'workflow', skills: ['skills/spec-driven-development', 'skills/git-workflow-and-versioning'], license: 'MIT' },
  { repo: 'mattpocock/skills', category: 'workflow', skills: ['skills/engineering/pr', 'skills/misc/setup-pre-commit', 'skills/productivity/grill-me', 'skills/productivity/handoff'], license: 'MIT' },
  // Test, debug and review
  {
    repo: 'obra/superpowers',
    category: 'quality',
    skills: ['skills/systematic-debugging', 'skills/test-driven-development', 'skills/verification-before-completion', 'skills/requesting-code-review', 'skills/receiving-code-review'],
    license: 'MIT',
  },
  {
    repo: 'addyosmani/agent-skills',
    category: 'quality',
    skills: [
      'skills/code-review-and-quality',
      'skills/debugging-and-error-recovery',
      'skills/security-and-hardening',
      'skills/api-and-interface-design',
      'skills/performance-optimization',
      'skills/code-simplification',
    ],
    license: 'MIT',
  },
  { repo: 'mattpocock/skills', category: 'quality', skills: ['skills/engineering/tdd', 'skills/engineering/code-review', 'skills/engineering/improve-codebase-architecture'], license: 'MIT' },
  { repo: 'anthropics/skills', category: 'quality', skills: ['skills/webapp-testing'], license: 'Apache-2.0' },
  // Design and UI
  { repo: 'anthropics/skills', category: 'design', skills: ['skills/frontend-design', 'skills/theme-factory', 'skills/canvas-design', 'skills/algorithmic-art', 'skills/web-artifacts-builder'], license: 'Apache-2.0' },
  { repo: 'vercel-labs/agent-skills', category: 'design', skills: ['skills/web-design-guidelines'], license: 'MIT' },
  {
    repo: 'emilkowalski/skills',
    category: 'design',
    skills: ['skills/emil-design-eng', 'skills/animate', 'skills/improve-animations', 'skills/review-animations', 'skills/animation-performance', 'skills/apple-design'],
    license: 'MIT',
  },
  // Frameworks and platforms
  {
    repo: 'vercel-labs/agent-skills',
    category: 'frameworks',
    skills: ['skills/react-best-practices', 'skills/composition-patterns', 'skills/react-native-skills', 'skills/react-view-transitions', 'skills/deploy-to-vercel'],
    license: 'MIT',
  },
  { repo: 'supabase/agent-skills', category: 'frameworks', skills: ['skills/supabase', 'skills/supabase-postgres-best-practices'], license: 'MIT' },
  // AI and machine learning
  { repo: 'anthropics/skills', category: 'ai', skills: ['skills/claude-api', 'skills/mcp-builder'], license: 'Apache-2.0' },
  {
    repo: 'huggingface/skills',
    category: 'ai',
    skills: [
      'skills/hf-cli',
      'skills/huggingface-datasets',
      'skills/huggingface-gradio',
      'skills/huggingface-spaces',
      'skills/huggingface-local-models',
      'skills/huggingface-llm-trainer',
      'skills/trl-training',
      'skills/transformers-js',
      'skills/huggingface-papers',
      'skills/huggingface-tool-builder',
    ],
    license: 'Apache-2.0',
  },
  // Writing
  { repo: 'blader/humanizer', category: 'writing', skills: [''], license: 'MIT' },
  { repo: 'anthropics/skills', category: 'writing', skills: ['skills/internal-comms', 'skills/brand-guidelines'], license: 'Apache-2.0' },
  { repo: 'vercel-labs/agent-skills', category: 'writing', skills: ['skills/writing-guidelines'], license: 'MIT' },
  { repo: 'addyosmani/agent-skills', category: 'writing', skills: ['skills/documentation-and-adrs'], license: 'MIT' },
  { repo: 'mattpocock/skills', category: 'writing', skills: ['skills/productivity/teach'], license: 'MIT' },
  // Office documents
  { repo: 'anthropics/skills', category: 'documents', skills: ['skills/docx', 'skills/pdf', 'skills/pptx', 'skills/xlsx'], license: 'Apache-2.0' },
  // Making skills
  { repo: 'anthropics/skills', category: 'skills', skills: ['skills/skill-creator'], license: 'Apache-2.0' },
  { repo: 'obra/superpowers', category: 'skills', skills: ['skills/writing-skills'], license: 'MIT' },
  { repo: 'mattpocock/skills', category: 'skills', skills: ['skills/productivity/writing-for-agents'], license: 'MIT' },
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
        out.push({ id: s.id, name: s.name, description, category: pick.category, repo: s.repo, path: s.path, pin: s.pin, license: pick.license, files: files.map(({ path, sha256 }) => ({ path, sha256 })), scripts: s.scripts, tokens: skillTokens(s.name, description, md) })
        console.log(`${s.id.padEnd(32)} ${pick.repo}/${s.path} (${files.length} files)`)
      }
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// A skill whose files didn't change keeps its old pin, so installed copies don't show an update.
for (const s of out) {
  const was = PREVIOUS.find((p) => p.id === s.id && p.repo === s.repo && p.path === s.path)
  if (was && JSON.stringify(was.files) === JSON.stringify(s.files)) s.pin = was.pin
}

// Group order in Settings, keeping the order of PICKS within a group.
out.sort((a, b) => SKILL_CATEGORIES.indexOf(a.category) - SKILL_CATEGORIES.indexOf(b.category))

const target = path.join(import.meta.dirname, '../src/skills/catalog.ts')
const head = fs.readFileSync(target, 'utf8').split('export const SKILL_CATALOG')[0]
fs.writeFileSync(target, `${head}export const SKILL_CATALOG: CatalogSkill[] = ${JSON.stringify(out, null, 2)}\n`)
console.log(`${out.length} skills → ${path.relative(process.cwd(), target)}`)
