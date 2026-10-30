import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Getting the WhatsApp bridge onto this computer. The app ships only the bridge's own MIT source;
// Baileys and its GPL-3.0 libsignal dependency are downloaded by npm into the data folder when the
// user turns WhatsApp on, and run in a separate `node` process. Never bundle them.

export const NODE_MIN_MAJOR = 20
export const NODE_URL = 'https://nodejs.org/en/download'
export const NEEDS_NODE_TEXT = `Install Node.js ${NODE_MIN_MAJOR}+ to use WhatsApp.`
export const LICENSE_NOTE = 'WhatsApp support downloads the open-source Baileys library (MIT) and its libsignal dependency (GPL-3.0) to your computer when you turn it on.'

/** Files copied from the app's bridge folder into `<dataDir>/whatsapp-bridge/`. */
export const BRIDGE_FILES = ['bridge.mjs', 'package.json', 'package-lock.json', 'README.md']

/** The first executable called `name` on `PATH` (with Windows' extensions), or null. */
export function findOnPath(name: string, envPath = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = isExecutable): string | null {
  const sep = platform === 'win32' ? ';' : ':'
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of envPath.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      if (exists(p)) return p
    }
  }
  return null
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `v22.17.1` → 22; null when it isn't a version. */
export function nodeMajor(version: string | null | undefined): number | null {
  const m = /^v?(\d+)\.\d+/.exec(String(version ?? '').trim())
  return m ? Number(m[1]) : null
}

export interface Tooling {
  node: string | null
  npm: string | null
  /** `node --version`, or null when it couldn't run. */
  nodeVersion: string | null
}

export type InstallPlan =
  | { ok: true; node: string; command: string; args: string[]; cwd: string; shell: boolean }
  | { ok: false; message: string; url: string }

/** What to run to install the bridge's dependencies in `dir`, or why it can't be. */
export function installPlan(t: Tooling, dir: string, platform: NodeJS.Platform = process.platform): InstallPlan {
  const major = nodeMajor(t.nodeVersion)
  if (!t.node || !t.npm || major == null) return { ok: false, message: NEEDS_NODE_TEXT, url: NODE_URL }
  if (major < NODE_MIN_MAJOR) return { ok: false, message: `${NEEDS_NODE_TEXT} This computer has Node.js ${t.nodeVersion}.`, url: NODE_URL }
  return {
    ok: true,
    node: t.node,
    command: t.npm,
    // --loglevel=http prints each download, which is the progress shown in Settings.
    args: ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=http'],
    cwd: dir,
    // npm is a .cmd script on Windows, which Node only starts through a shell.
    shell: platform === 'win32',
  }
}

/** Finds node and npm on PATH and asks node for its version. */
export async function findTooling(envPath = process.env.PATH ?? ''): Promise<Tooling> {
  const node = findOnPath('node', envPath)
  const npm = findOnPath('npm', envPath)
  const nodeVersion = node
    ? await new Promise<string | null>((resolve) =>
        execFile(node, ['--version'], { timeout: 10_000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim())),
      )
    : null
  return { node, npm, nodeVersion }
}

/** A hash of the files that decide what npm installs. */
export function depsHash(dir: string): string {
  const h = crypto.createHash('sha256')
  for (const f of ['package.json', 'package-lock.json']) {
    try {
      h.update(f).update(fs.readFileSync(path.join(dir, f)))
    } catch {
      h.update(`${f}:missing`)
    }
  }
  return h.digest('hex')
}

const STAMP = '.installed'

/**
 * Copies the bridge into `dest` (always, so app updates reach it) and says whether npm still has
 * to run: true when node_modules is missing or the dependencies changed since the last install.
 */
export function prepareBridge(src: string, dest: string): { needsInstall: boolean } {
  if (!fs.existsSync(path.join(src, 'bridge.mjs'))) throw new Error(`The WhatsApp bridge is missing from the app (${src}).`)
  fs.mkdirSync(dest, { recursive: true })
  for (const f of BRIDGE_FILES) {
    const from = path.join(src, f)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, f))
  }
  let stamp = ''
  try {
    stamp = fs.readFileSync(path.join(dest, STAMP), 'utf8').trim()
  } catch {
    /* never installed */
  }
  const installed = fs.existsSync(path.join(dest, 'node_modules', '@whiskeysockets', 'baileys', 'package.json'))
  return { needsInstall: !installed || stamp !== depsHash(dest) }
}

/** Runs npm per `plan`, reporting each output line; records the install when it succeeds. */
export function runInstall(plan: Extract<InstallPlan, { ok: true }>, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      shell: plan.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })
    const tail: string[] = []
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const l = line.trim()
        if (!l) continue
        tail.push(l)
        if (tail.length > 20) tail.shift()
        onLine(l)
      }
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (e) => {
      signal?.removeEventListener('abort', abort)
      reject(new Error(`npm couldn't start: ${e.message}`))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new Error('Install stopped.'))
      if (code !== 0) {
        const why = tail.filter((l) => /err/i.test(l)).slice(-3).join(' ') || tail.slice(-2).join(' ')
        return reject(new Error(`npm install failed (exit ${code})${why ? `: ${why}` : '.'}`))
      }
      try {
        fs.writeFileSync(path.join(plan.cwd, STAMP), depsHash(plan.cwd))
      } catch {
        /* reinstalls next time */
      }
      resolve()
    })
  })
}

/** A short progress line from npm's `--loglevel=http` output. */
export function progressText(line: string, fetched: number): string {
  if (/^npm http fetch/i.test(line)) return `Downloading packages… (${fetched})`
  if (/^added \d+ packages?/i.test(line)) return line
  return ''
}

/** Creates `dir` as owner-only and makes files already in it owner-only (no-op on Windows). */
export function secureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  fs.chmodSync(dir, 0o700)
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    try {
      if (f.isDirectory()) secureDir(p)
      else if (f.isFile()) fs.chmodSync(p, 0o600)
    } catch {
      /* best effort */
    }
  }
}
