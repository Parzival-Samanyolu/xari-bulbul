// Plugins the app offers to install: bundles of extension tools, commands, skills and MCP servers
// that live in this repo under `plugins/<id>/`. Each entry pins a reviewed commit and the sha256 of
// every file, so an install gets exactly the reviewed bytes. Changing a pin means shipping a new app.

/** This repo on GitHub, where `plugins/<id>/` is downloaded from. */
export const PLUGIN_REPO = 'Parzival-Samanyolu/xari-bulbul'

export interface PluginFile {
  /** Relative to the plugin folder, with `/` separators. */
  path: string
  sha256: string
}

/** Where an installed app shows up, per OS. Paths may start with `~` or use `%ProgramFiles%`-style variables. */
export interface PluginDetect {
  darwin?: string[]
  win32?: string[]
  linux?: string[]
  /** Programs looked up on PATH on every OS. */
  bin?: string[]
}

export interface PluginIncludes {
  tools: string[]
  commands: string[]
  skills: string[]
  mcpServers: string[]
}

export interface CatalogPlugin {
  id: string
  name: string
  /** One line for the install dialog. */
  description: string
  version: string
  repo: string
  /** The plugin's folder in the repo. */
  path: string
  /** Full commit sha the files were reviewed at. */
  pin: string
  files: PluginFile[]
  includes: PluginIncludes
  detect?: PluginDetect
}

const PIN = '0a6fa5b12ec4e8a5f5046500fe86ad1ba9752fa6'

export const PLUGIN_CATALOG: CatalogPlugin[] = [
  {
    id: 'blender',
    name: 'Blender',
    description: 'Run Python scripts in Blender to edit scenes, set up materials and render, and read what a .blend file holds.',
    version: '1.0.0',
    repo: PLUGIN_REPO,
    path: 'plugins/blender',
    pin: PIN,
    files: [
      { path: 'lib/blender.mjs', sha256: '7b8b254470d38a1637052eb37b75a15a27b307bfcf57b55f775818cf809ef12f' },
      { path: 'lib/exec.mjs', sha256: '2c43f26d78674fd62659ebac220706be3b30a5f96383ff9c6e5c404e74de4677' },
      { path: 'plugin.json', sha256: '22fd7818f60a420a482ba7ad7aed18067343e78c2740432bac1ed03e4c3e417d' },
      { path: 'skills/blender-python/SKILL.md', sha256: '31d211ec5bfbd52d447c52025c89517f0ff7fa80e93345743fcc7de6b19687d9' },
      { path: 'tools/blender_info.mjs', sha256: '82bda0f1ac48ede42734eba22e8a5e364e38724c551664a0f61421bc6e030785' },
      { path: 'tools/blender_run.mjs', sha256: 'f4d9c6331d959144f72d6eb236327548b0ce616d66d01a672f282ec747127133' },
    ],
    includes: { tools: ['blender_run', 'blender_info'], commands: [], skills: ['blender-python'], mcpServers: [] },
    detect: {
      darwin: ['/Applications/Blender.app', '~/Applications/Blender.app'],
      win32: ['%ProgramFiles%\\Blender Foundation', '%ProgramFiles(x86)%\\Blender Foundation'],
      linux: ['/snap/bin/blender', '/var/lib/flatpak/app/org.blender.Blender', '~/.local/share/flatpak/app/org.blender.Blender'],
      bin: ['blender'],
    },
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'List containers, read their logs and configuration, and start or stop Compose projects.',
    version: '1.0.0',
    repo: PLUGIN_REPO,
    path: 'plugins/docker',
    pin: PIN,
    files: [
      { path: 'lib/docker.mjs', sha256: 'ff17fe1f2522a2e705869cfc66e4f5dcd8f58d2761ffb5599f6a6f169bf2247f' },
      { path: 'lib/exec.mjs', sha256: '2c43f26d78674fd62659ebac220706be3b30a5f96383ff9c6e5c404e74de4677' },
      { path: 'plugin.json', sha256: '02659be42652ea8d23ae3980b162a66ccf46aa1470fa928b5e105166f9db28ad' },
      { path: 'skills/docker/SKILL.md', sha256: '312c373caefe82a855c8c98c7e888013e633d331af467e11730842a38de2f386' },
      { path: 'tools/docker_compose.mjs', sha256: '18e50cac28a8fa043159ce2f80fb75fd8e413a9fbbd66704ceef92564f19a77b' },
      { path: 'tools/docker_inspect.mjs', sha256: 'f81a1160da5baeeace206ab60e2bec53bcda578c90adaea3e405b6c1f8a67bd2' },
      { path: 'tools/docker_logs.mjs', sha256: '64ca2a9e3542bf7a1445376913a7cbc4358c93599bcf6303f6f8b6a394c72bb9' },
      { path: 'tools/docker_ps.mjs', sha256: 'ee1e470917f8141d0b49c89897a50a7b295a86a32546b6cc6647ff89660522ed' },
    ],
    includes: { tools: ['docker_ps', 'docker_logs', 'docker_inspect', 'docker_compose'], commands: [], skills: ['docker'], mcpServers: [] },
    detect: {
      darwin: ['/Applications/Docker.app', '~/Applications/Docker.app'],
      win32: ['%ProgramFiles%\\Docker\\Docker'],
      bin: ['docker'],
    },
  },
]

/** Where one of a plugin's files is downloaded from. */
export function pluginFileUrl(p: Pick<CatalogPlugin, 'repo' | 'pin' | 'path'>, file: string): string {
  return `https://raw.githubusercontent.com/${p.repo}/${p.pin}/${p.path}/${file}`
}

/** The plugin's folder on GitHub at the pinned commit. */
export function pluginTreeUrl(p: Pick<CatalogPlugin, 'repo' | 'pin' | 'path'>): string {
  return `https://github.com/${p.repo}/tree/${p.pin}/${p.path}`
}
