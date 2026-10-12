// Spots shell commands that delete or irreversibly overwrite things, so they can be
// confirmed even in auto mode. A heuristic safety net, not a shell parser: it looks at
// the leading command of each `;` / `&&` / `||` / `|` segment.

import os from 'node:os'
import path from 'node:path'

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'nohup', 'time', 'nice', 'env', 'exec'])
const DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'remove-item', 'ri', 'del', 'erase', 'rd'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const POWERSHELLS = new Set(['powershell', 'pwsh'])

/** Splits a command line into segments, respecting quotes. */
function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
    } else if (c === ';' || c === '|' || c === '\n' || c === '&') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

function words(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

const baseName = (w: string) => w.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
const operands = (args: string[]) => args.filter((a) => !a.startsWith('-') || a === '-')

function describe(targets: string[], verb: string): string {
  const shown = targets.slice(0, 6).join(' ')
  const more = targets.length > 6 ? ` (+${targets.length - 6} more)` : ''
  return shown ? `${verb}: ${shown}${more}` : verb
}

function gitReason(args: string[]): string | null {
  // Skip global options such as `-C path` / `-c key=value`.
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  switch (sub) {
    case 'clean':
      return rest.some((a) => /^-[a-z]*[fn]/i.test(a) || a === '--force') && !rest.includes('-n') && !rest.includes('--dry-run')
        ? 'Runs git clean (deletes untracked files)'
        : null
    case 'reset':
      return rest.includes('--hard') ? 'Runs git reset --hard (discards uncommitted changes)' : null
    case 'push':
      return rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a === '--mirror' || /^\+/.test(a) || a === '--delete' || a === '-d')
        ? 'Force push or remote delete (rewrites remote history)'
        : null
    case 'checkout':
      return rest.includes('--') || rest.includes('.') || rest.includes('-f') ? 'Discards uncommitted changes (git checkout)' : null
    case 'restore':
      return rest.includes('--staged') && !rest.includes('--worktree') ? null : 'Discards uncommitted changes (git restore)'
    case 'branch':
      return rest.includes('-D') || (rest.includes('--delete') && rest.includes('--force'))
        ? describe(operands(rest), 'Deletes branch')
        : null
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? 'Deletes stashed changes' : null
    default:
      return null
  }
}

function segmentReason(segment: string, depth: number): string | null {
  let w = words(segment)
  // Drop env assignments and wrappers (sudo, xargs and their flags).
  for (;;) {
    if (!w.length) return null
    const first = baseName(w[0])
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1)
    else if (WRAPPERS.has(first) || first === 'xargs') {
      w = w.slice(1)
      while (w.length && w[0].startsWith('-')) w = w.slice(1)
    } else break
  }
  const cmd = baseName(w[0])
  const args = w.slice(1)

  if (DELETE.has(cmd)) return describe(operands(args), 'Deletes files')
  if (cmd === 'clear-content' || cmd === 'clc') return describe(operands(args), 'Empties files')
  if ((cmd === 'mv' || cmd === 'move-item' || cmd === 'mi') && args.some((a) => /^-[a-z]*f/i.test(a) || a === '--force')) return describe(operands(args), 'Overwrites files')
  if (cmd === 'find' && args.some((a) => a === '-delete' || ((a === '-exec' || a === '-execdir') && /^(rm|shred|unlink)$/.test(baseName(args[args.indexOf(a) + 1] ?? ''))))) {
    return 'Deletes files found by find'
  }
  if (cmd === 'git') return gitReason(args)
  const inner = nestedCommand(cmd, args)
  if (inner && depth < 2) return destructiveReason(inner, depth + 1)
  return null
}

/** The command passed to `bash -c …`, `cmd /c …` or `powershell -Command …`, if any. */
function nestedCommand(cmd: string, args: string[]): string | null {
  const flag =
    SHELLS.has(cmd) ? (a: string) => a === '-c'
    : cmd === 'cmd' ? (a: string) => /^\/[ck]$/i.test(a)
    : POWERSHELLS.has(cmd) ? (a: string) => /^-(c|command)$/i.test(a)
    : null
  const i = flag ? args.findIndex(flag) : -1
  if (i < 0 || !args[i + 1]) return null
  // sh takes one argument after -c; cmd and PowerShell run the rest of the line.
  return SHELLS.has(cmd) ? args[i + 1] : args.slice(i + 1).join(' ')
}

/** Why a shell command is destructive, or null if it looks safe. */
export function destructiveReason(command: string, depth = 0): string | null {
  const reasons = segments(command)
    .map((s) => segmentReason(s, depth))
    .filter((r): r is string => !!r)
  return reasons.length ? [...new Set(reasons)].join('; ') : null
}

const isWindowsPath = (p: string) => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith('\\\\')

/** PowerShell cmdlets and cmd builtins that write files, and the parameters naming the target. */
const PS_WRITE = new Set(['out-file', 'set-content', 'sc', 'add-content', 'ac', 'new-item', 'ni'])
const PS_COPY = new Set(['copy-item', 'cpi', 'move-item', 'mi', 'copy', 'move', 'xcopy'])
const PS_VALUED = /^-(path|literalpath|filepath|destination|value|encoding|itemtype|name|inputobject|filter|include|exclude)(:.*)?$/i

/** The value of a named parameter (`-Path x` or `-Path:x`), case-insensitive. */
function named(args: string[], names: RegExp): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const m = /^-([a-z]+)(?::(.+))?$/i.exec(args[i])
    if (m && names.test(m[1])) return m[2] ?? args[i + 1]
  }
  return undefined
}

/** Arguments that are neither parameters nor parameter values. */
function positional(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (PS_VALUED.test(args[i])) {
      if (!args[i].includes(':')) i++
    } else if (!/^-[a-z]/i.test(args[i]) && !/^\/[a-z?](:|$)/i.test(args[i])) out.push(args[i])
  }
  return out
}

/** Where writes are harmless even though they are outside the project. */
function scratchPath(p: string): boolean {
  return /^\/dev\//.test(p) || /^\/(private\/)?tmp(\/|$)/.test(p) || /^\/var\/folders\//.test(p)
}

function within(root: string, target: string, P: typeof path.posix): boolean {
  const rel = P.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel))
}

/** Paths a command line may write to, including inside `bash -c` / `cmd /c` / `powershell -Command`. */
function writeTargets(command: string, depth: number): string[] {
  const targets: string[] = []
  for (const seg of segments(command)) {
    // Redirects: `> file`, `>> file`, `2> file`, `&> file`.
    for (const m of seg.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\s*([^\s;|&<>]+)/g)) targets.push(m[1])
    const w = words(seg)
    const cmd = w.length ? baseName(w[0]) : ''
    const args = w.slice(1)
    const ops = operands(args)
    if (cmd === 'tee') targets.push(...ops)
    if ((cmd === 'cp' || cmd === 'mv' || cmd === 'install' || cmd === 'rsync' || cmd === 'ln') && ops.length >= 2) targets.push(ops[ops.length - 1])
    if (PS_WRITE.has(cmd)) {
      const t = named(args, /^(path|literalpath|filepath)$/i) ?? positional(args)[0]
      if (t) targets.push(t)
    }
    if (PS_COPY.has(cmd)) {
      const pos = positional(args)
      const t = named(args, /^destination$/i) ?? (pos.length >= 2 ? pos[pos.length - 1] : undefined)
      if (t) targets.push(t)
    }
    if (cmd === 'robocopy' && ops.length >= 2) targets.push(ops[1])
    const inner = depth < 2 ? nestedCommand(cmd, args) : null
    if (inner) targets.push(...writeTargets(inner, depth + 1))
  }
  return targets
}

/**
 * Why a shell command writes outside `cwd` (redirects, tee, cp/mv/install targets,
 * PowerShell Out-File/Set-Content/Copy-Item and friends), or null.
 * Like destructiveReason, a heuristic: it only sees literal absolute or ~ paths.
 * Paths follow the style of `cwd`, so Windows rules apply to a `C:\\…` project on any OS.
 */
export function outsideWriteReason(command: string, cwd: string, home = os.homedir()): string | null {
  const P = isWindowsPath(cwd) ? path.win32 : path.posix
  const fold = (s: string) => (P === path.win32 ? s.toLowerCase() : s)
  const root = fold(P.resolve(cwd))
  const outside = (raw: string): string | null => {
    let p = raw.replace(/^["']|["']$/g, '')
    if (/^(\$null|nul)$/i.test(p)) return null
    if (p.startsWith('~')) p = home + p.slice(1)
    p = p.replace(/^\$env:(temp|tmp)(?=[\\/]|$)/i, os.tmpdir())
    if (!P.isAbsolute(p)) return null // relative paths: treated as inside (`..` is caught below)
    if (scratchPath(p)) return null // also mapped by Git Bash and MSYS on Windows
    const abs = fold(P.resolve(root, p))
    if (within(root, abs, P) || within(fold(P.resolve(os.tmpdir())), abs, P)) return null
    return raw
  }
  const targets = writeTargets(command, 0)
  const hits = targets
    .map((t) => (/(^|[\\/])\.\.([\\/]|$)/.test(t) && !P.isAbsolute(t.replace(/^["']|["']$/g, '')) ? t : outside(t)))
    .filter((t): t is string => !!t)
  return hits.length ? describe([...new Set(hits)], 'Writes outside the project folder') : null
}
