import { spawn } from 'node:child_process'
import { z } from 'zod'
import { killTree } from './jobs.js'
import { defineTool, truncate } from './types.js'

export function defaultShell(): { cmd: string; args: (command: string) => string[] } {
  if (process.platform === 'win32') {
    return { cmd: 'powershell.exe', args: (c) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', c] }
  }
  return { cmd: process.env.SHELL || '/bin/bash', args: (c) => ['-c', c] }
}

function shellFor(setting: string) {
  if (!setting) return defaultShell()
  const lower = setting.toLowerCase()
  if (lower.includes('powershell') || lower.includes('pwsh'))
    return { cmd: setting, args: (c: string) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', c] }
  if (lower.endsWith('cmd.exe') || lower === 'cmd') return { cmd: setting, args: (c: string) => ['/d', '/s', '/c', c] }
  return { cmd: setting, args: (c: string) => ['-c', c] }
}

export const bashTool = defineTool({
  name: 'bash',
  description: [
    'Run a shell command in the workspace folder and return its combined output and exit code.',
    '- Each call starts a fresh shell in the workspace folder: `cd` does not carry over. Use absolute paths or `cd dir && cmd` in one call.',
    '- Do not use it to read, search or edit files: read_file, grep, glob and edit_file are faster, safer and shown better to the user.',
    '- Avoid interactive commands (editors, pagers, prompts); they hang until the timeout. Pass flags like --yes or CI=1 where needed.',
    '- Quote paths that contain spaces. Chain dependent steps with &&.',
    '- Long-running processes (dev servers, watchers) go in the background with run_in_background; then check them with bash_output and stop them with kill_job.',
    '- The default timeout is set in Settings; raise it with timeout_sec for slow builds or test suites.',
    '- Never run destructive commands (rm -rf, git reset --hard, force push) unless the user asked; they always need the user\'s approval.',
    '- Commit only when the user asks. Never change git config, skip hooks, or force push unless explicitly told to.',
  ].join('\n'),
  input: z.object({
    command: z.string().describe('The command to run'),
    timeout_sec: z.number().int().min(1).max(3600).optional().describe('Override the default timeout'),
    run_in_background: z.boolean().optional().describe('Start the command and return a job id at once; read its output later with bash_output'),
  }),
  kind: 'exec',
  readOnly: false,
  subject: (i) => i.command,
  execute(input, ctx) {
    const shell = shellFor(ctx.shell)
    const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' }
    if (input.run_in_background) {
      if (!ctx.jobs) return Promise.resolve({ content: 'Background jobs are not available here.', isError: true })
      const job = ctx.jobs.start(input.command, { cmd: shell.cmd, args: shell.args(input.command), cwd: ctx.cwd, env })
      return Promise.resolve({ content: `Started in the background as ${job.id}. Check it with bash_output, stop it with kill_job.` })
    }
    const timeoutMs = (input.timeout_sec ?? ctx.bashTimeoutSec) * 1000
    return new Promise((resolve) => {
      const child = spawn(shell.cmd, shell.args(input.command), {
        cwd: ctx.cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let killedFor: 'timeout' | 'abort' | null = null
      const onData = (b: Buffer) => {
        const s = b.toString('utf8')
        // Cap memory: keep at most 4x the output budget, the tail matters most.
        out = (out + s).slice(-ctx.toolOutputMaxChars * 4)
        ctx.progress(s)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      const timer = setTimeout(() => ((killedFor = 'timeout'), killTree(child.pid)), timeoutMs)
      const onAbort = () => ((killedFor = 'abort'), killTree(child.pid))
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      const finish = (code: number | null, err?: Error) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const text = truncate(out.trimEnd(), ctx.toolOutputMaxChars)
        if (err) return resolve({ content: `Failed to start shell: ${err.message}`, isError: true })
        const note =
          killedFor === 'timeout'
            ? `\n[killed after ${timeoutMs / 1000}s timeout]`
            : killedFor === 'abort'
              ? '\n[interrupted by user]'
              : ''
        resolve({
          content: `${text || '(no output)'}${note}\n[exit code: ${code ?? 'killed'}]`,
          isError: code !== 0,
        })
      }
      child.on('error', (e) => finish(null, e))
      child.on('close', (code) => finish(code))
    })
  },
})

export const bashOutputTool = defineTool({
  name: 'bash_output',
  description:
    'Read new output from a background job started with bash run_in_background, plus whether it is still running. ' +
    'Each call returns only what was printed since the previous call. Without job_id, lists all jobs.',
  input: z.object({ job_id: z.string().optional().describe('The id returned when the job started, e.g. "job1"') }),
  kind: 'other',
  readOnly: true,
  subject: (i) => i.job_id ?? 'all jobs',
  async execute(input, ctx) {
    if (!ctx.jobs) return { content: 'Background jobs are not available here.', isError: true }
    if (!input.job_id) {
      const all = ctx.jobs.list()
      if (!all.length) return { content: 'No background jobs.' }
      return { content: all.map((j) => `${j.id}  ${j.done ? `exited ${j.exitCode ?? 'killed'}` : 'running'}  ${j.command}`).join('\n') }
    }
    const job = ctx.jobs.get(input.job_id)
    if (!job) return { content: `No job ${input.job_id}.`, isError: true }
    const out = truncate(ctx.jobs.takeNew(job).trimEnd(), ctx.toolOutputMaxChars)
    const status = job.done ? `[exited with code ${job.exitCode ?? 'killed'}]` : `[running for ${Math.round((Date.now() - job.startedAt) / 1000)}s]`
    return { content: `${out || '(no new output)'}\n${status}` }
  },
})

export const killJobTool = defineTool({
  name: 'kill_job',
  description: 'Stop a background job started with bash run_in_background (the whole process tree is killed).',
  input: z.object({ job_id: z.string() }),
  kind: 'other',
  readOnly: true,
  subject: (i) => i.job_id,
  async execute(input, ctx) {
    if (!ctx.jobs) return { content: 'Background jobs are not available here.', isError: true }
    if (!ctx.jobs.get(input.job_id)) return { content: `No job ${input.job_id}.`, isError: true }
    return { content: ctx.jobs.kill(input.job_id) ? `Stopped ${input.job_id}.` : `${input.job_id} had already finished.` }
  },
})
