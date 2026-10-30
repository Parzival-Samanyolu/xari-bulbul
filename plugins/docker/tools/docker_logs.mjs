import { checkName, docker } from '../lib/docker.mjs'

export default {
  name: 'docker_logs',
  description: "Show the latest log lines of a Docker container (its stdout and stderr). Use docker_ps to find the container's name.",
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Container name or id.' },
      tail: { type: 'number', description: 'How many lines from the end (default 200, at most 5000).' },
      since: { type: 'string', description: 'Only lines newer than this: a duration like 10m or 2h, or a timestamp.' },
      timestamps: { type: 'boolean', description: 'Prefix each line with its time.' },
    },
    required: ['container'],
  },
  kind: 'read',
  readOnly: true,
  subject: (input) => String(input?.container ?? ''),
  async execute(input, ctx) {
    const bad = checkName(input?.container, 'container')
    if (bad) return { content: bad, isError: true }
    const tail = Math.min(Math.max(Math.floor(Number(input.tail) || 200), 1), 5000)
    const args = ['logs', '--tail', String(tail)]
    if (input.since != null && input.since !== '') {
      if (typeof input.since !== 'string' || !/^[0-9A-Za-z:.+-]{1,40}$/.test(input.since)) return { content: `Not a valid \`since\`: ${input.since}`, isError: true }
      args.push('--since', input.since)
    }
    if (input.timestamps === true) args.push('--timestamps')
    args.push(input.container.trim())
    return docker(args, ctx)
  },
}
