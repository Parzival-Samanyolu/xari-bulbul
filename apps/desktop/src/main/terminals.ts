// Terminals for the bottom panel: real PTYs (node-pty) running the user's shell in a chat's folder.
import fs from 'node:fs'
import path from 'node:path'
import type { IPty } from 'node-pty'
import type { UiEvent } from '../shared/ipc'

type NodePty = typeof import('node-pty')

let pty: NodePty | null = null

/**
 * Loads node-pty on first use, so a missing or broken native build only breaks the terminal.
 * Its macOS/Linux `spawn-helper` ships without the execute bit in the npm package; set it here
 * (dev installs) as well as at packaging time (scripts/after-pack.cjs).
 */
function loadPty(): NodePty {
  if (pty) return pty
  const mod = require('node-pty') as NodePty
  if (process.platform !== 'win32') {
    const root = path.dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked')
    for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
      const helper = path.join(root, dir, 'spawn-helper')
      try {
        if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755)
      } catch {
        // Read-only install: packaging already set the bit.
      }
    }
  }
  pty = mod
  return mod
}

/** The user's interactive shell: $SHELL (as a login shell on macOS, like Terminal.app), PowerShell (or cmd.exe) on Windows. */
function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // Windows PowerShell ships with every supported Windows; fall back to cmd.exe if it was removed.
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(ps)) return { file: ps, args: ['-NoLogo'] }
    return { file: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', args: [] }
  }
  const file = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return { file, args: process.platform === 'darwin' ? ['-l'] : [] }
}

interface Term {
  pty: IPty
  cwd: string
  buffer: string
  timer: NodeJS.Timeout | null
}

export class Terminals {
  private terms = new Map<string, Term>()
  private next = 0

  constructor(private readonly send: (e: UiEvent) => void) {}

  /** Starts a shell in `cwd`; output arrives as `term_data` events, the end as `term_exit`. */
  open(cwd: string, cols: number, rows: number): string {
    const { spawn } = loadPty()
    const { file, args } = shellCommand()
    const id = `t${++this.next}`
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'XariBulbul' } as Record<string, string>
    // Electron's own variables shouldn't leak into commands run in the terminal.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const p = spawn(file, args, { name: 'xterm-256color', cols: clamp(cols, 2, 1000), rows: clamp(rows, 1, 500), cwd, env })
    const term: Term = { pty: p, cwd, buffer: '', timer: null }
    this.terms.set(id, term)
    // Batch output so a flood (e.g. `cat` of a big file) doesn't send one IPC message per chunk.
    p.onData((data) => {
      term.buffer += data
      term.timer ??= setTimeout(() => this.flush(id), 8)
    })
    p.onExit(({ exitCode }) => {
      this.flush(id)
      this.terms.delete(id)
      this.send({ type: 'term_exit', id, code: exitCode })
    })
    return id
  }

  private flush(id: string) {
    const t = this.terms.get(id)
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    t.timer = null
    if (!t.buffer) return
    const data = t.buffer
    t.buffer = ''
    this.send({ type: 'term_data', id, data })
  }

  write(id: string, data: string) {
    this.terms.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    try {
      this.terms.get(id)?.pty.resize(clamp(cols, 2, 1000), clamp(rows, 1, 500))
    } catch {
      // The process may have just exited.
    }
  }

  kill(id: string) {
    const t = this.terms.get(id)
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    this.terms.delete(id)
    try {
      t.pty.kill()
    } catch {
      // Already gone.
    }
    this.send({ type: 'term_exit', id, code: null })
  }

  /** Ends the terminals running in `cwd` (its folder was closed). */
  killFolder(cwd: string) {
    for (const [id, t] of this.terms) if (t.cwd === cwd) this.kill(id)
  }

  /** Ends every terminal (on quit). */
  dispose() {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number(n) || lo)))
