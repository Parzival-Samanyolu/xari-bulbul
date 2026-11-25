// Runs the built `xari` CLI for the action: writes a throwaway settings.json, feeds the prompt on stdin,
// captures the answer, sets the outputs and (optionally) posts or updates a PR comment.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKER, buildArgs, buildSettings, commentBody, envKeyName, extractResult, outputEntry } from './lib.mjs'

const env = process.env
const input = (name, fallback = '') => (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? fallback).trim() || fallback
const log = (s) => process.stderr.write(`${s}\n`)

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const cli = path.join(repoRoot, 'apps/cli/dist/xari.mjs')

const provider = input('provider', 'openrouter')
const model = input('model', 'openrouter/free')
const mode = input('mode', 'plan')
const outputFormat = input('output-format', 'text')
const apiKey = env.INPUT_API_KEY ?? ''
const prompt = env.INPUT_PROMPT ?? ''

function setOutputs(result, exitCode) {
  if (!env.GITHUB_OUTPUT) return
  fs.appendFileSync(env.GITHUB_OUTPUT, outputEntry('result', result) + outputEntry('exit-code', String(exitCode)))
}

/** Posts the comment, or edits the one this action wrote earlier on the same PR. */
async function comment(body) {
  const repo = env.GITHUB_REPOSITORY
  const token = env.INPUT_GITHUB_TOKEN || env.GITHUB_TOKEN
  let number
  try {
    number = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.number
  } catch {
    // no event file: not running in Actions
  }
  if (!number || !repo || !token) return log('xari: comment-on-pr needs a pull_request event and a token; skipping the comment')
  const api = env.GITHUB_API_URL || 'https://api.github.com'
  const call = async (method, url, data) => {
    const res = await fetch(`${api}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: data ? JSON.stringify(data) : undefined,
    })
    if (!res.ok) throw new Error(`GitHub ${method} ${url} failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }
  // Page through the PR's comments looking for our marker.
  let existing
  for (let page = 1; !existing; page++) {
    const list = await call('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)
    existing = list.find((c) => c.body?.includes(MARKER))
    if (list.length < 100) break
  }
  if (existing) await call('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body })
  else await call('POST', `/repos/${repo}/issues/${number}/comments`, { body })
}

async function main() {
  if (!prompt.trim()) throw new Error('prompt is required')
  if (!apiKey) throw new Error('api-key is required')
  // Hide the key from the log, in case anything echoes it.
  console.log(`::add-mask::${apiKey}`)
  if (!fs.existsSync(cli)) throw new Error(`the CLI is not built (${cli} is missing)`)

  const dataDir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'xari-data-'))
  const settings = buildSettings({ provider, model, baseUrl: input('base-url') })
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))

  const cwd = path.resolve(env.GITHUB_WORKSPACE || process.cwd(), input('working-directory', '.'))
  const child = spawn(process.execPath, [cli, ...buildArgs({ mode, outputFormat, maxSteps: input('max-steps') })], {
    cwd,
    // Only what the CLI needs; the GitHub token is deliberately left out so the agent can't use it.
    env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, CI: 'true', HARNESS_DATA_DIR: dataDir, [envKeyName(provider)]: apiKey },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stdin.end(prompt)
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => (log(`xari: ${e.message}`), resolve(1)))
    child.on('close', (code) => resolve(code ?? 1))
  })

  const result = extractResult(stdout, outputFormat)
  console.log(result)
  setOutputs(result, exitCode)
  if (input('comment-on-pr') === 'true' && result) {
    try {
      await comment(commentBody(result, { model: `${provider}/${model}`, mode }))
    } catch (e) {
      log(`xari: could not post the comment: ${e.message}`)
    }
  }
  process.exitCode = exitCode
}

main().catch((e) => {
  log(`xari: ${e.message}`)
  setOutputs('', 1)
  process.exitCode = 1
})
