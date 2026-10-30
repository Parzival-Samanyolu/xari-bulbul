import { docker } from '../lib/docker.mjs'

export default {
  name: 'docker_ps',
  description: 'List Docker containers: id, name, image, status, ports. Running ones only unless `all` is true.',
  parameters: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'Include stopped containers.' },
    },
  },
  kind: 'read',
  readOnly: true,
  subject: (input) => (input?.all ? 'all containers' : 'running containers'),
  async execute(input, ctx) {
    const args = ['ps', '--no-trunc', '--format', 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']
    if (input?.all === true) args.splice(1, 0, '--all')
    const r = await docker(args, ctx)
    if (!r.isError && r.content.split('\n').length < 2) return { content: input?.all ? 'No containers.' : 'No running containers. Pass all: true to see stopped ones.' }
    return r
  },
}
