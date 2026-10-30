import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpServerSchema, type McpServerConfig } from '../settings/schema.js'
import { pluginFileUrl, type CatalogPlugin, type PluginFile } from './catalog.js'

export type PluginScope = 'user' | 'project'

/** One entry of `<dataDir>/plugins.json`. */
export interface InstalledPlugin {
  id: string
  /** The commit the files came from. */
  pin: string
  scope: PluginScope
  /** The project folder, for scope `project`. */
  cwd?: string
  installedAt: number
  enabled: boolean
  /** What was installed, so the loader can tell if the files were changed afterwards. */
  files: PluginFile[]
}

/** A plugin folder the extension loader should load. */
export interface PluginRoot {
  id: string
  dir: string
  source: 'user' | 'project'
  /** Checked before any code loads; a changed or missing file keeps the plugin from loading. */
  files: PluginFile[]
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_FILE_BYTES = 5 * 1024 * 1024

export const pluginsFile = (dataDir: string) => path.join(dataDir, 'plugins.json')

export function readInstalled(dataDir: string): InstalledPlugin[] {
  try {
    const raw = JSON.parse(fs.readFileSync(pluginsFile(dataDir), 'utf8'))
    const list: unknown[] = Array.isArray(raw?.plugins) ? raw.plugins : []
    return list.filter(
      (p): p is InstalledPlugin =>
        !!p && typeof (p as InstalledPlugin).id === 'string' && ID.test((p as InstalledPlugin).id) && Array.isArray((p as InstalledPlugin).files),
    )
  } catch {
    return []
  }
}

export function writeInstalled(dataDir: string, list: InstalledPlugin[]): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const target = pluginsFile(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ plugins: list }, null, 2))
  fs.renameSync(tmp, target)
}

/** `<root>/plugins/<id>`, where root is `~/.harness` or `<project>/.harness`. */
export function pluginDir(root: string, id: string): string {
  if (!ID.test(id)) throw new Error(`Invalid plugin id "${id}"`)
  return path.join(root, 'plugins', id)
}

/** A file path from a catalog entry, refused unless it stays inside the plugin folder. */
export function checkPluginPath(p: string): string {
  if (typeof p !== 'string' || !p || p.length > 200) throw new Error('Refused a plugin file with an empty or overlong path.')
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`Refused plugin file "${p}": absolute paths aren't allowed.`)
  const parts = p.split('/')
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`Refused plugin file "${p}": the path leaves the plugin folder.`)
  if (!parts.every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s))) throw new Error(`Refused plugin file "${p}": unexpected characters in the path.`)
  return p
}

/** Throws if `target` or any folder between `base` (itself trusted) and it is a symbolic link. */
function refuseSymlinks(base: string, target: string) {
  const rel = path.relative(base, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${target} is outside ${base}.`)
  let cur = base
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part)
    let st: fs.Stats
    try {
      st = fs.lstatSync(cur)
    } catch {
      return // nothing below a missing folder can be a link yet
    }
    if (st.isSymbolicLink()) throw new Error(`Refused to install: ${cur} is a symbolic link.`)
  }
}

const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

export interface InstallOptions {
  /** `~/.harness` or `<project>/.harness`. */
  root: string
  /** No symbolic links are allowed below this folder: the project folder for a project install. Defaults to `root`. */
  linkBase?: string
  fetch?: typeof fetch
  signal?: AbortSignal
}

/**
 * Downloads every file of a catalog plugin at its pinned commit, checks each against its sha256,
 * and puts them in `<root>/plugins/<id>/`, replacing an older install. Nothing is written until
 * every file checks out, and a failure leaves the old install as it was.
 */
export async function installPlugin(entry: CatalogPlugin, opts: InstallOptions): Promise<PluginFile[]> {
  const doFetch = opts.fetch ?? fetch
  const dir = pluginDir(opts.root, entry.id)
  if (!/^[0-9a-f]{40}$/.test(entry.pin)) throw new Error(`Plugin ${entry.id} has no reviewed commit pin.`)
  const seen = new Set<string>()
  for (const f of entry.files) {
    checkPluginPath(f.path)
    if (seen.has(f.path.toLowerCase())) throw new Error(`Plugin file "${f.path}" is listed twice.`)
    seen.add(f.path.toLowerCase())
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`Plugin file "${f.path}" has no sha256.`)
  }
  if (!seen.has('plugin.json')) throw new Error(`Plugin ${entry.id} has no plugin.json.`)

  const data = new Map<string, Uint8Array>()
  for (const f of entry.files) {
    const url = pluginFileUrl(entry, f.path)
    const res = await doFetch(url, { signal: opts.signal, redirect: 'error' })
    if (!res.ok) throw new Error(`Couldn't download ${f.path} (HTTP ${res.status}).`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${f.path} is larger than expected.`)
    const got = sha256(bytes)
    if (got !== f.sha256) throw new Error(`Checksum mismatch for ${f.path}: expected ${f.sha256}, got ${got}. Nothing was installed.`)
    data.set(f.path, bytes)
  }
  let manifest: { id?: unknown }
  try {
    manifest = JSON.parse(Buffer.from(data.get('plugin.json')!).toString('utf8'))
  } catch {
    throw new Error(`Plugin ${entry.id} has an unreadable plugin.json.`)
  }
  if (manifest.id !== entry.id) throw new Error(`plugin.json names "${String(manifest.id)}", not "${entry.id}".`)

  const base = opts.linkBase ?? opts.root
  refuseSymlinks(base, dir)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  refuseSymlinks(base, path.dirname(dir))
  const staging = fs.mkdtempSync(path.join(path.dirname(dir), `.${entry.id}-`))
  try {
    for (const [rel, bytes] of data) {
      const abs = path.join(staging, ...rel.split('/'))
      if (path.relative(staging, abs).startsWith('..')) throw new Error(`Refused plugin file "${rel}".`)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, bytes, { flag: 'wx' })
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw e
  }
  return entry.files.map((f) => ({ path: f.path, sha256: f.sha256 }))
}

/** Deletes an installed plugin's folder. */
export function uninstallPlugin(root: string, id: string, linkBase = root): void {
  const dir = pluginDir(root, id)
  refuseSymlinks(linkBase, dir)
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Files that are missing or differ from what was installed. */
export function changedPluginFiles(dir: string, files: PluginFile[]): string[] {
  const bad: string[] = []
  for (const f of files) {
    try {
      const abs = path.join(dir, ...checkPluginPath(f.path).split('/'))
      if (fs.lstatSync(abs).isSymbolicLink() || sha256(fs.readFileSync(abs)) !== f.sha256) bad.push(f.path)
    } catch {
      bad.push(f.path)
    }
  }
  return bad
}

/** The `.harness` folder a plugin installs under. */
export function pluginRoot(scope: PluginScope, opts: { userDir: string; cwd?: string | null }): string {
  if (scope === 'user') return opts.userDir
  if (!opts.cwd) throw new Error('Open a project folder to install a plugin for this project.')
  return path.join(opts.cwd, '.harness')
}

/** Turned-on plugins that apply in `cwd`: every all-projects install, plus this project's. */
export function activePlugins(list: InstalledPlugin[], cwd: string | null, userDir: string): PluginRoot[] {
  const here = cwd?.normalize('NFC')
  return list
    .filter((p) => p.enabled && (p.scope === 'user' || (!!here && p.cwd?.normalize('NFC') === here)))
    .map((p) => ({ id: p.id, dir: pluginDir(pluginRoot(p.scope, { userDir, cwd: p.cwd }), p.id), source: p.scope, files: p.files }))
}

/**
 * MCP servers from a plugin's `mcp.json` (`{ "servers": [{ name, transport, command, args, … }] }`),
 * tagged with the plugin so uninstalling removes them. `${PLUGIN_DIR}` in a command or argument
 * becomes the install folder.
 */
export function pluginMcpServers(dir: string, pluginId: string): McpServerConfig[] {
  let raw: { servers?: unknown }
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'))
  } catch {
    return []
  }
  const sub = (s: string) => s.replaceAll('${PLUGIN_DIR}', dir)
  const out: McpServerConfig[] = []
  for (const s of Array.isArray(raw.servers) ? raw.servers : []) {
    const name = String((s as { name?: unknown })?.name ?? '').replace(/[^A-Za-z0-9_-]/g, '')
    if (!name) continue
    const parsed = McpServerSchema.safeParse({ ...(s as object), id: `${pluginId}-${name}`, name, plugin: pluginId })
    if (!parsed.success) continue
    const server = parsed.data
    out.push(server.transport === 'stdio' ? { ...server, command: sub(server.command), args: server.args.map(sub) } : server)
  }
  return out
}

/** `servers` with the plugin's old servers replaced by `next`; a server that was turned off stays off. */
export function mergePluginServers(servers: McpServerConfig[], pluginId: string, next: McpServerConfig[]): McpServerConfig[] {
  const old = new Map(servers.filter((s) => s.plugin === pluginId).map((s) => [s.id, s]))
  const kept = servers.filter((s) => s.plugin !== pluginId && !next.some((n) => n.id === s.id))
  return [...kept, ...next.map((s) => ({ ...s, enabled: old.get(s.id)?.enabled ?? s.enabled }))]
}

export interface DetectEnv {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  /** Defaults to a stat; tests pass a stub. */
  exists?: (p: string) => boolean
}

/** Which catalog plugins' apps are on this computer: plugin id → the path that matched. Stat only, nothing runs. */
export function detectPlugins(catalog: CatalogPlugin[], o: DetectEnv = {}): Record<string, string> {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  const home = o.home ?? os.homedir()
  const exists = o.exists ?? ((p: string) => fs.existsSync(p))
  const P = platform === 'win32' ? path.win32 : path.posix
  const envGet = (name: string) => {
    if (platform !== 'win32') return env[name]
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : undefined
  }
  const expand = (p: string): string | null => {
    let missing = false
    const out = p.replace(/%([^%]+)%/g, (_, v: string) => envGet(v) ?? ((missing = true), '')).replace(/^~(?=$|[\\/])/, home)
    return missing ? null : out
  }
  const pathDirs = (envGet('PATH') ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const found: Record<string, string> = {}
  for (const plugin of catalog) {
    const d = plugin.detect
    if (!d) continue
    const places = ((platform === 'darwin' || platform === 'win32' || platform === 'linux' ? d[platform] : undefined) ?? []).map(expand)
    let hit = places.find((p): p is string => !!p && exists(p))
    for (const bin of hit ? [] : (d.bin ?? [])) {
      for (const dir of pathDirs) {
        hit = exts.map((e) => P.join(dir, bin + e)).find(exists)
        if (hit) break
      }
      if (hit) break
    }
    if (hit) found[plugin.id] = hit
  }
  return found
}
