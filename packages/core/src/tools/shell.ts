// Picks the shell the `bash` tool runs commands in. Models write bash, so the default is
// bash wherever one exists: /bin/bash on macOS and Linux, Git Bash on Windows. Without Git
// Bash, Windows falls back to PowerShell 7, then Windows PowerShell 5.1; the system prompt
// then tells the model which one it is, since 5.1 rejects `&&`.
import fs from 'node:fs'
import path from 'node:path'

export interface Shell {
  cmd: string
  args: (command: string) => string[]
  /** Shown to the model in the Environment section, e.g. "bash", "Git Bash", "PowerShell 5.1". */
  name: string
}

export interface ShellProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (file: string) => boolean
}

const realProbe = (): ShellProbe => ({
  platform: process.platform,
  env: process.env,
  exists: (f) => {
    try {
      return fs.statSync(f).isFile()
    } catch {
      return false
    }
  },
})

// PowerShell writes in the OEM code page by default, which garbles non-ASCII output, and
// draws progress bars that arrive as CLIXML noise on stderr.
const PS_PRELUDE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';"

function powershell(cmd: string, name: string): Shell {
  return { cmd, name, args: (c) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PRELUDE + c] }
}

function posix(cmd: string, name: string): Shell {
  return { cmd, name, args: (c) => ['-c', c] }
}

function pathDirs(p: ShellProbe): string[] {
  const raw = p.env.PATH ?? p.env.Path ?? ''
  return raw.split(p.platform === 'win32' ? ';' : ':').filter(Boolean)
}

function onPath(p: ShellProbe, exe: string): string | null {
  const join = p.platform === 'win32' ? path.win32.join : path.posix.join
  for (const dir of pathDirs(p)) {
    const f = join(dir, exe)
    if (p.exists(f)) return f
  }
  return null
}

/** Git for Windows' bash.exe, from the usual install folders or next to git.exe on PATH. Never WSL's System32\bash.exe. */
export function findGitBash(p: ShellProbe): string | null {
  const j = path.win32.join
  const roots = [p.env.ProgramFiles, p.env.ProgramW6432, p.env['ProgramFiles(x86)']]
    .filter((r): r is string => !!r)
    .map((r) => j(r, 'Git'))
  if (p.env.LOCALAPPDATA) roots.push(j(p.env.LOCALAPPDATA, 'Programs', 'Git'))
  if (p.env.USERPROFILE) roots.push(j(p.env.USERPROFILE, 'scoop', 'apps', 'git', 'current'))
  // git.exe lives in <root>\cmd or <root>\bin.
  for (const dir of pathDirs(p)) {
    if (p.exists(j(dir, 'git.exe'))) roots.push(path.win32.dirname(dir))
  }
  for (const root of roots) {
    const f = j(root, 'bin', 'bash.exe')
    if (p.exists(f)) return f
  }
  return null
}

function fromSetting(setting: string, p: ShellProbe): Shell {
  const base = path.win32.basename(setting).replace(/\.exe$/i, '').toLowerCase()
  if (base === 'powershell') return powershell(setting, 'PowerShell 5.1')
  if (base === 'pwsh') return powershell(setting, 'PowerShell 7')
  if (base === 'cmd') return { cmd: setting, name: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] }
  if (p.platform === 'win32' && base === 'bash' && /[\\/]git[\\/]/i.test(setting)) return posix(setting, 'Git Bash')
  if (p.platform === 'win32' && (setting.toLowerCase() === 'git bash' || base === 'git-bash')) {
    const gb = findGitBash(p)
    if (gb) return posix(gb, 'Git Bash')
  }
  return posix(setting, base)
}

const cache = new Map<string, Shell>()

/** The shell for the Shell setting; empty means the platform default described above. */
export function resolveShell(setting = '', probe?: ShellProbe): Shell {
  if (!probe && cache.has(setting)) return cache.get(setting)!
  const p = probe ?? realProbe()
  let shell: Shell
  if (setting.trim()) shell = fromSetting(setting.trim(), p)
  else if (p.platform === 'win32') {
    const gb = findGitBash(p)
    const pwsh = gb ? null : onPath(p, 'pwsh.exe')
    shell = gb ? posix(gb, 'Git Bash') : pwsh ? powershell(pwsh, 'PowerShell 7') : powershell('powershell.exe', 'PowerShell 5.1')
  } else if (p.exists('/bin/bash')) shell = posix('/bin/bash', 'bash')
  else {
    const sh = p.env.SHELL || '/bin/sh'
    shell = posix(sh, path.posix.basename(sh))
  }
  if (!probe) cache.set(setting, shell)
  return shell
}
