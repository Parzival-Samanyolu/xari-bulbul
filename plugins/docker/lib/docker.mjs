import path from 'node:path'
import { clip, failure, findBinary, run } from './exec.mjs'

export const MISSING = 'Install Docker Desktop (or Docker Engine), make sure `docker` is on PATH or set DOCKER_PATH, and restart the app.'

/** The docker CLI: DOCKER_PATH, `docker` on PATH, then where Docker Desktop puts it. */
export function findDocker() {
  const candidates =
    process.platform === 'darwin'
      ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '~/.docker/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker', '~/.orbstack/bin/docker']
      : process.platform === 'win32'
        ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
        : ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']
  return findBinary('docker', candidates, 'DOCKER_PATH')
}

/** Container, image, volume and network names and ids; never something that reads as an option. */
export function checkName(value, what) {
  if (typeof value !== 'string' || !value.trim()) return `\`${what}\` is required.`
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,254}$/.test(value.trim())) return `Not a valid ${what}: ${value}`
  return null
}

/** Runs `docker args` and turns the result into a tool result. */
export async function docker(args, ctx, { timeoutMs = 60_000, cwd, bin = findDocker() } = {}) {
  if (!bin) return { content: `Docker was not found. ${MISSING}`, isError: true }
  const r = await run(bin, args, { cwd: cwd ?? ctx.cwd, timeoutMs, signal: ctx.signal })
  const failed = failure(r, 'Docker', MISSING)
  if (failed) return failed
  const out = clip(r.out.trim(), ctx.toolOutputMaxChars || 30_000)
  if (r.code === 0) return { content: out || '(no output)' }
  const hint = /Cannot connect to the Docker daemon|docker daemon is not running|error during connect/i.test(r.out)
    ? '\n\nThe Docker engine isn\u2019t running. Start Docker Desktop (or the docker service) and try again.'
    : ''
  return { content: `${path.basename(bin).replace(/\.exe$/i, '')} ${args[0]} exited with code ${r.code}.\n\n${out}${hint}`, isError: true }
}
