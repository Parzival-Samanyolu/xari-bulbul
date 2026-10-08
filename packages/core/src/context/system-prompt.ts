import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PermissionMode } from '../types.js'
import { SECTIONS, type PromptContext, type PromptEnvironment } from './prompt/sections.js'

export type { PromptEnvironment } from './prompt/sections.js'

const MAX_FILE_CHARS = 40_000
const MAX_TOTAL_CHARS = 80_000

/** The folders from `cwd` up to the repository root (the one containing `.git`), nearest first. */
function instructionDirs(cwd: string): string[] {
  const dirs: string[] = []
  const home = os.homedir()
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir)
    if (fs.existsSync(path.join(dir, '.git'))) return dirs
    const parent = path.dirname(dir)
    // Outside a repository, only the working directory itself counts.
    if (parent === dir || dir === home) return dirs.slice(0, 1)
  }
}

/**
 * Project instruction files (AGENTS.md, HARNESS.md, CLAUDE.md by default), nearest first:
 * the working directory, then each parent up to the repository root.
 */
export function loadProjectInstructions(cwd: string, files: string[]): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = []
  let total = 0
  for (const dir of instructionDirs(cwd)) {
    for (const name of files) {
      const p = path.join(dir, name)
      try {
        const content = fs.readFileSync(p, 'utf8').trim().slice(0, MAX_FILE_CHARS)
        if (!content || total + content.length > MAX_TOTAL_CHARS) continue
        total += content.length
        out.push({ file: path.relative(cwd, p) || name, content })
      } catch {
        /* not present */
      }
    }
  }
  return out
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000 })
  return r.status === 0 ? r.stdout : null
}

/** Date, OS, shell and git state, captured once per turn. */
export function gatherEnvironment(cwd: string, opts: { git?: boolean } = {}): PromptEnvironment {
  const env: PromptEnvironment = {
    date: new Date().toISOString().slice(0, 10),
    platform: process.platform,
    osRelease: os.release(),
    shell: process.platform === 'win32' ? 'PowerShell' : path.basename(process.env.SHELL || 'bash'),
  }
  if (opts.git !== false) {
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch !== null) {
      const status = (git(cwd, ['status', '--short']) ?? '').split('\n').filter(Boolean)
      env.git = { branch: branch.trim(), status: status.slice(0, 30), truncated: Math.max(0, status.length - 30) }
    }
  }
  return env
}

export interface SystemPromptInput {
  cwd: string
  mode: PermissionMode
  model: string
  instructionFiles: string[]
  customInstructions: string
  override: string
  toolNames: string[]
  /** Saved memories; undefined when memory is off. */
  memory?: { global: string[]; project: string[] }
  /** Set when this prompt is for a subagent working on a delegated task. */
  subagent?: { description: string }
  /** The model's context window, when known. */
  contextLength?: number
  /** Captured environment; gathered (without git) when absent. */
  env?: PromptEnvironment
}

/** Joins the sections that apply. A non-empty `override` replaces the base sections (identity … git). */
export function buildSystemPrompt(i: SystemPromptInput): string {
  const ctx: PromptContext = {
    cwd: i.cwd,
    mode: i.mode,
    model: i.model,
    contextLength: i.contextLength,
    toolNames: i.toolNames,
    env: i.env ?? gatherEnvironment(i.cwd, { git: false }),
    subagent: i.subagent,
    instructions: loadProjectInstructions(i.cwd, i.instructionFiles),
    memory: i.memory,
    customInstructions: i.customInstructions,
  }
  const override = i.override.trim()
  const out: string[] = []
  let overridden = false
  for (const s of SECTIONS) {
    if (override && s.base) {
      if (!overridden) out.push(override)
      overridden = true
      continue
    }
    if (s.when && !s.when(ctx)) continue
    out.push(s.render(ctx))
  }
  return out.join('\n\n')
}
