import { execFileSync } from 'node:child_process'
import os from 'node:os'

/**
 * Apps started from the Dock or a desktop launcher get a minimal PATH, so tools the user
 * installed with Homebrew, nvm, pipx and the like (npx, uvx, …) aren't found by the bash tool
 * or by MCP servers. Ask the user's login shell for its PATH once at startup.
 */
export function loadShellPath(): void {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  try {
    const marker = '__XB_PATH__'
    const out = execFileSync(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    })
    const found = out.split(marker)[1]
    if (found) process.env.PATH = merge(found, process.env.PATH ?? '')
  } catch {
    // Slow or broken shell config: fall back to the usual install locations.
    const home = os.homedir()
    process.env.PATH = merge(['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/.bun/bin`].join(':'), process.env.PATH ?? '')
  }
}

function merge(first: string, rest: string): string {
  return [...new Set([...first.split(':'), ...rest.split(':')].filter(Boolean))].join(':')
}
