import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkName, docker } from '../lib/docker.mjs'
import { findBinary } from '../lib/exec.mjs'

const ACTIONS = {
  // Detached, so the tool returns once the containers are started.
  up: ['up', '--detach'],
  down: ['down'],
  restart: ['restart'],
  ps: ['ps', '--all'],
}

export default {
  name: 'docker_compose',
  description:
    'Run Docker Compose for a compose file: up (build if needed and start in the background), down (stop and remove the containers; volumes are kept), restart, or ps. ' +
    'Uses `docker compose` (or docker-compose on older setups). Read the logs afterwards with docker_logs.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(ACTIONS) },
      file: { type: 'string', description: 'The compose file, relative to the project folder. Default: the compose.yaml / docker-compose.yml in the project folder.' },
      services: { type: 'array', items: { type: 'string' }, description: 'Only these services (up, restart, ps).' },
    },
    required: ['action'],
  },
  kind: 'exec',
  readOnly: false,
  subject: (input) => `compose ${input?.action ?? ''}${input?.file ? ` ${input.file}` : ''}`,
  async execute(input, ctx) {
    const base = ACTIONS[input?.action]
    if (!base) return { content: `\`action\` must be one of: ${Object.keys(ACTIONS).join(', ')}.`, isError: true }
    const args = ['compose']
    let cwd = ctx.cwd
    if (input.file != null && input.file !== '') {
      if (typeof input.file !== 'string') return { content: '`file` must be a path.', isError: true }
      const file = path.resolve(ctx.cwd, input.file.replace(/^~(?=$|[\\/])/, os.homedir()))
      if (!fs.existsSync(file)) return { content: `File not found: ${file}`, isError: true }
      args.push('--file', file)
      cwd = path.dirname(file)
    }
    args.push(...base)
    const services = input.services ?? []
    if (!Array.isArray(services)) return { content: '`services` must be a list of service names.', isError: true }
    if (services.length && input.action === 'down') return { content: '`services` does not apply to down; it stops the whole project.', isError: true }
    for (const s of services) {
      const bad = checkName(s, 'service')
      if (bad) return { content: bad, isError: true }
      args.push(s.trim())
    }
    // Builds and image pulls during `up` can be slow.
    const opts = { cwd, timeoutMs: input.action === 'up' ? 900_000 : 180_000 }
    const r = await docker(args, ctx, opts)
    // Older setups only have the separate docker-compose program.
    if (r.isError && /is not a docker command|unknown command "compose"|unknown flag: --file/i.test(r.content)) {
      const legacy = findBinary('docker-compose', ['/usr/local/bin/docker-compose', '/usr/bin/docker-compose'])
      if (legacy) return docker(args.slice(1), ctx, { ...opts, bin: legacy })
    }
    return r
  },
}
