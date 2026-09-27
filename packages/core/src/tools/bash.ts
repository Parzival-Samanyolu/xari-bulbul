import { spawn } from 'node:child_process'
import { z } from 'zod'
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

function killTree(pid: number | undefined) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the workspace directory (bash/zsh on macOS and Linux, PowerShell on Windows). ' +
    'Returns combined stdout/stderr and the exit code. Avoid interactive commands; they will hang until the timeout. ' +
    'Prefer read_file/grep/glob over cat/grep/find.',
  input: z.object({
    command: z.string().describe('The command to run'),
    timeout_sec: z.number().int().min(1).max(3600).optional().describe('Override the default timeout'),
  }),
  kind: 'exec',
  readOnly: false,
  subject: (i) => i.command,
  execute(input, ctx) {
    const shell = shellFor(ctx.shell)
    const timeoutMs = (input.timeout_sec ?? ctx.bashTimeoutSec) * 1000
    return new Promise((resolve) => {
      const child = spawn(shell.cmd, shell.args(input.command), {
        cwd: ctx.cwd,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
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
