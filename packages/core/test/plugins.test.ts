import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensions } from '../src/extensions/loader.js'
import { PLUGIN_CATALOG, pluginFileUrl, pluginTreeUrl, type CatalogPlugin } from '../src/plugins/catalog.js'
import {
  activePlugins,
  checkPluginPath,
  detectPlugins,
  installPlugin,
  mergePluginServers,
  pluginDir,
  pluginMcpServers,
  readInstalled,
  uninstallPlugin,
  writeInstalled,
  type InstalledPlugin,
} from '../src/plugins/install.js'
import type { McpServerConfig } from '../src/settings/schema.js'

const REPO_PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins')
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex')
const PIN = 'a'.repeat(40)

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A catalog entry for `files` plus a fetch that serves them from the pinned raw URLs. */
function fixture(files: Record<string, string>, over: Partial<CatalogPlugin> = {}) {
  const entry: CatalogPlugin = {
    id: 'demo',
    name: 'Demo',
    description: 'A test plugin',
    version: '1.0.0',
    repo: 'example/repo',
    path: 'plugins/demo',
    pin: PIN,
    files: Object.entries(files).map(([p, body]) => ({ path: p, sha256: sha(body) })),
    includes: { tools: [], commands: [], skills: [], mcpServers: [] },
    ...over,
  }
  const served = new Map(Object.entries(files).map(([p, body]) => [pluginFileUrl(entry, p), body]))
  const requested: string[] = []
  const fetch = (async (url: string) => {
    requested.push(url)
    const body = served.get(url)
    return body == null ? new Response('missing', { status: 404 }) : new Response(body)
  }) as unknown as typeof globalThis.fetch
  return { entry, fetch, served, requested }
}

const DEMO = {
  'plugin.json': JSON.stringify({ id: 'demo', name: 'Demo', description: 'x', version: '1.0.0', includes: {} }),
  'tools/demo_echo.mjs': `export default { name: 'demo_echo', description: 'Echo', readOnly: true, kind: 'read', async execute(i) { return 'echo:' + i.text } }\n`,
  'commands/demo-review.md': '---\ndescription: Review with the demo\n---\nReview $ARGUMENTS\n',
  'skills/demo-skill/SKILL.md': '---\nname: demo-skill\ndescription: How to demo\n---\nSteps\n',
  'mcp.json': JSON.stringify({ servers: [{ name: 'demo-srv', transport: 'stdio', command: 'node', args: ['${PLUGIN_DIR}/server.mjs'] }] }),
}

describe('plugin catalog', () => {
  it('lists every file in plugins/<id> with matching hashes', () => {
    for (const p of PLUGIN_CATALOG) {
      const dir = path.join(REPO_PLUGINS, p.id)
      const onDisk = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
        .sort()
      expect(p.files.map((f) => f.path).sort(), p.id).toEqual(onDisk)
      for (const f of p.files) expect(sha(fs.readFileSync(path.join(dir, f.path))), `${p.id}/${f.path}`).toBe(f.sha256)
      expect(p.path).toBe(`plugins/${p.id}`)
      expect(p.pin).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it("matches each plugin.json's id and includes", () => {
    for (const p of PLUGIN_CATALOG) {
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_PLUGINS, p.id, 'plugin.json'), 'utf8'))
      expect(manifest.id).toBe(p.id)
      expect(manifest.version).toBe(p.version)
      expect(manifest.includes).toEqual(p.includes)
    }
  })

  it('loads the starter plugins through the extension loader', async () => {
    for (const p of PLUGIN_CATALOG) {
      const dir = path.join(REPO_PLUGINS, p.id)
      const ext = await loadExtensions(tmp, { user: false, project: false, userDir: path.join(tmp, 'none'), claudeDir: path.join(tmp, 'none'), plugins: [{ id: p.id, dir, source: 'user', files: p.files }] })
      expect(ext.errors).toEqual([])
      expect(ext.tools.map((t) => t.name).sort()).toEqual([...p.includes.tools].sort())
      expect(ext.tools.every((t) => t.plugin === p.id)).toBe(true)
      expect(ext.skills.map((s) => s.name)).toEqual(p.includes.skills)
    }
  })

  it('has read-only Docker inspection tools and asking ones for changes', async () => {
    const p = PLUGIN_CATALOG.find((x) => x.id === 'docker')!
    const ext = await loadExtensions(tmp, { user: false, project: false, userDir: tmp, claudeDir: tmp, plugins: [{ id: 'docker', dir: path.join(REPO_PLUGINS, 'docker'), source: 'user', files: p.files }] })
    const ro = Object.fromEntries(ext.tools.map((t) => [t.name, t.readOnly]))
    expect(ro).toEqual({ docker_ps: true, docker_logs: true, docker_inspect: true, docker_compose: false })
    const ctx = { cwd: tmp, signal: new AbortController().signal, toolOutputMaxChars: 1000 } as any
    const logs = ext.tools.find((t) => t.name === 'docker_logs')!
    expect(await logs.execute({ container: '--privileged' }, ctx)).toMatchObject({ isError: true, content: expect.stringMatching(/Not a valid container/) })
    const compose = ext.tools.find((t) => t.name === 'docker_compose')!
    expect(await compose.execute({ action: 'nuke' }, ctx)).toMatchObject({ isError: true })
    const saved = process.env.DOCKER_PATH
    process.env.DOCKER_PATH = path.join(tmp, 'no-docker')
    try {
      expect(await ext.tools.find((t) => t.name === 'docker_ps')!.execute({}, ctx)).toMatchObject({ isError: true, content: expect.stringMatching(/Docker was not found/) })
    } finally {
      if (saved == null) delete process.env.DOCKER_PATH
      else process.env.DOCKER_PATH = saved
    }
  })

  it('links to the pinned files on GitHub', () => {
    const p = PLUGIN_CATALOG[0]
    expect(pluginFileUrl(p, 'plugin.json')).toBe(`https://raw.githubusercontent.com/${p.repo}/${p.pin}/plugins/${p.id}/plugin.json`)
    expect(pluginTreeUrl(p)).toBe(`https://github.com/${p.repo}/tree/${p.pin}/plugins/${p.id}`)
  })
})

describe('installing plugins', () => {
  it('installs a fixture whose tools, commands, skills and MCP servers load', async () => {
    const { entry, fetch } = fixture(DEMO)
    const project = path.join(tmp, 'proj')
    fs.mkdirSync(project)
    const root = path.join(project, '.harness')
    const files = await installPlugin(entry, { root, fetch, linkBase: project })
    const dir = pluginDir(root, 'demo')
    expect(fs.readFileSync(path.join(dir, 'tools/demo_echo.mjs'), 'utf8')).toBe(DEMO['tools/demo_echo.mjs'])

    const record: InstalledPlugin = { id: 'demo', pin: PIN, scope: 'project', cwd: project, installedAt: 1, enabled: true, files }
    writeInstalled(tmp, [record])
    expect(readInstalled(tmp)).toEqual([record])
    const plugins = activePlugins(readInstalled(tmp), project, path.join(tmp, 'user'))
    expect(plugins).toEqual([{ id: 'demo', dir, source: 'project', files }])

    // Project tool code is off, but the installed plugin's still loads.
    const ext = await loadExtensions(project, { user: false, project: false, userDir: path.join(tmp, 'user'), claudeDir: path.join(tmp, 'none'), plugins })
    expect(ext.errors).toEqual([])
    const tool = ext.tools.find((t) => t.name === 'demo_echo')!
    expect(tool.plugin).toBe('demo')
    expect((await tool.execute({ text: 'hi' }, {} as any)).content).toBe('echo:hi')
    expect(ext.commands.find((c) => c.name === 'demo-review')).toMatchObject({ plugin: 'demo', source: 'project' })
    expect(ext.skills.find((s) => s.name === 'demo-skill')).toMatchObject({ plugin: 'demo' })

    const servers = pluginMcpServers(dir, 'demo')
    expect(servers).toEqual([
      { id: 'demo-demo-srv', name: 'demo-srv', enabled: true, plugin: 'demo', transport: 'stdio', command: 'node', args: [`${dir}/server.mjs`], env: {} },
    ])
    const mine: McpServerConfig = { id: 'gh', name: 'gh', enabled: true, transport: 'http', url: 'https://example.com/mcp', headers: {} }
    expect(mergePluginServers([mine], 'demo', servers).map((s) => s.id)).toEqual(['gh', 'demo-demo-srv'])
  })

  it("doesn't load a plugin that is turned off or belongs to another project", () => {
    const rec = (over: Partial<InstalledPlugin>): InstalledPlugin => ({ id: 'demo', pin: PIN, scope: 'user', installedAt: 1, enabled: true, files: [], ...over })
    expect(activePlugins([rec({ enabled: false })], '/p', '/u')).toEqual([])
    expect(activePlugins([rec({ scope: 'project', cwd: '/other' })], '/p', '/u')).toEqual([])
    expect(activePlugins([rec({})], null, '/u').map((p) => p.dir)).toEqual([path.join('/u', 'plugins', 'demo')])
  })

  it('refuses a checksum mismatch and writes nothing', async () => {
    const { entry, fetch, served } = fixture(DEMO)
    served.set(pluginFileUrl(entry, 'tools/demo_echo.mjs'), `export default { name: 'demo_echo', execute() { return 'evil' } }`)
    const root = path.join(tmp, 'user')
    await expect(installPlugin(entry, { root, fetch })).rejects.toThrow(/Checksum mismatch for tools\/demo_echo\.mjs/)
    expect(fs.existsSync(path.join(root, 'plugins'))).toBe(false)
  })

  it('keeps the old install when an update fails', async () => {
    const root = path.join(tmp, 'user')
    const first = fixture(DEMO)
    await installPlugin(first.entry, { root, fetch: first.fetch })
    const next = fixture({ ...DEMO, 'tools/demo_echo.mjs': 'changed' }, { pin: 'b'.repeat(40) })
    next.served.delete(pluginFileUrl(next.entry, 'skills/demo-skill/SKILL.md'))
    await expect(installPlugin(next.entry, { root, fetch: next.fetch })).rejects.toThrow(/HTTP 404/)
    expect(fs.readFileSync(path.join(root, 'plugins/demo/tools/demo_echo.mjs'), 'utf8')).toBe(DEMO['tools/demo_echo.mjs'])
    expect(fs.readdirSync(path.join(root, 'plugins'))).toEqual(['demo'])
  })

  it.each(['../evil.mjs', 'tools/../../evil.mjs', '/etc/passwd', 'C:/x.mjs', 'tools\\..\\x.mjs', 'tools//x.mjs', './x', ''])('refuses the path %j', async (bad) => {
    expect(() => checkPluginPath(bad)).toThrow(/Refused/)
    const { entry, fetch } = fixture(DEMO)
    entry.files.push({ path: bad, sha256: sha('x') })
    await expect(installPlugin(entry, { root: path.join(tmp, 'user'), fetch })).rejects.toThrow(/Refused/)
    expect(fs.existsSync(path.join(tmp, 'user'))).toBe(false)
  })

  it('refuses to install through a symbolic link', async () => {
    const project = path.join(tmp, 'proj')
    const elsewhere = path.join(tmp, 'elsewhere')
    fs.mkdirSync(project)
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(project, '.harness'), 'dir')
    const { entry, fetch } = fixture(DEMO)
    await expect(installPlugin(entry, { root: path.join(project, '.harness'), linkBase: project, fetch })).rejects.toThrow(/symbolic link/)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('refuses a plugin.json that names another plugin', async () => {
    const { entry, fetch } = fixture({ ...DEMO, 'plugin.json': JSON.stringify({ id: 'other' }) })
    await expect(installPlugin(entry, { root: path.join(tmp, 'user'), fetch })).rejects.toThrow(/names "other"/)
  })

  it("doesn't load a plugin whose files changed after install", async () => {
    const { entry, fetch } = fixture(DEMO)
    const root = path.join(tmp, 'user')
    const files = await installPlugin(entry, { root, fetch })
    const dir = pluginDir(root, 'demo')
    fs.writeFileSync(path.join(dir, 'tools/demo_echo.mjs'), `export default { name: 'demo_echo', description: '', execute() { return 'changed' } }`)
    fs.writeFileSync(path.join(dir, 'tools/extra.mjs'), `export default { name: 'extra', description: '', execute() { return 'x' } }`)
    const ext = await loadExtensions(tmp, { user: false, project: false, userDir: path.join(tmp, 'none'), claudeDir: tmp, plugins: [{ id: 'demo', dir, source: 'user', files }] })
    expect(ext.tools).toEqual([])
    expect(ext.errors[0].error).toMatch(/files changed after it was installed \(tools\/demo_echo\.mjs\)/)

    // Restoring the file loads it again, but never an unlisted extra tool.
    fs.writeFileSync(path.join(dir, 'tools/demo_echo.mjs'), DEMO['tools/demo_echo.mjs'])
    const again = await loadExtensions(tmp, { user: false, project: false, userDir: path.join(tmp, 'none'), claudeDir: tmp, plugins: [{ id: 'demo', dir, source: 'user', files }] })
    expect(again.tools.map((t) => t.name)).toEqual(['demo_echo'])
  })

  it('uninstalls everything', async () => {
    const { entry, fetch } = fixture(DEMO)
    const root = path.join(tmp, 'user')
    await installPlugin(entry, { root, fetch })
    const servers = pluginMcpServers(pluginDir(root, 'demo'), 'demo')
    uninstallPlugin(root, 'demo')
    expect(fs.existsSync(pluginDir(root, 'demo'))).toBe(false)
    expect(mergePluginServers(servers, 'demo', [])).toEqual([])
    const ext = await loadExtensions(tmp, { user: true, project: false, userDir: root, claudeDir: tmp })
    expect([...ext.tools, ...ext.commands, ...ext.skills]).toEqual([])
  })
})

describe('detecting apps', () => {
  const catalog = PLUGIN_CATALOG
  it('finds Blender.app on macOS without running anything', () => {
    const seen: string[] = []
    const found = detectPlugins(catalog, { platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/me', exists: (p) => (seen.push(p), p === '/Applications/Blender.app') })
    expect(found).toEqual({ blender: '/Applications/Blender.app' })
    expect(seen).toContain('/Users/me/Applications/Docker.app')
  })

  it('finds programs on PATH', () => {
    const found = detectPlugins(catalog, { platform: 'linux', env: { PATH: '/usr/local/bin:/opt/bin' }, home: '/home/me', exists: (p) => p === '/opt/bin/docker' || p === '/home/me/.local/share/flatpak/app/org.blender.Blender' })
    expect(found).toEqual({ docker: '/opt/bin/docker', blender: '/home/me/.local/share/flatpak/app/org.blender.Blender' })
  })

  it('expands Windows variables and finds .exe programs', () => {
    const found = detectPlugins(catalog, {
      platform: 'win32',
      env: { Path: 'C:\\Tools;C:\\Windows', PROGRAMFILES: 'C:\\Program Files' },
      home: 'C:\\Users\\me',
      exists: (p) => p === 'C:\\Program Files\\Blender Foundation' || p === 'C:\\Tools\\docker.exe',
    })
    expect(found).toEqual({ blender: 'C:\\Program Files\\Blender Foundation', docker: 'C:\\Tools\\docker.exe' })
  })

  it('finds nothing when nothing is installed', () => {
    expect(detectPlugins(catalog, { platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/me', exists: () => false })).toEqual({})
  })
})
