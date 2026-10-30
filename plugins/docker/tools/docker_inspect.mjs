import { checkName, docker } from '../lib/docker.mjs'

export default {
  name: 'docker_inspect',
  description:
    'Show the full configuration and state of a Docker container, image, volume or network as JSON: environment, mounts, ports, networks, health checks, exit code and restart count.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Name or id of a container, image, volume or network.' },
      type: { type: 'string', enum: ['container', 'image', 'volume', 'network'], description: 'What the target is, when a name is ambiguous.' },
    },
    required: ['target'],
  },
  kind: 'read',
  readOnly: true,
  subject: (input) => String(input?.target ?? ''),
  async execute(input, ctx) {
    const bad = checkName(input?.target, 'target')
    if (bad) return { content: bad, isError: true }
    const args = ['inspect']
    if (input.type != null) {
      if (!['container', 'image', 'volume', 'network'].includes(input.type)) return { content: `Not a valid type: ${input.type}`, isError: true }
      args.push('--type', input.type)
    }
    args.push(input.target.trim())
    return docker(args, ctx)
  },
}
