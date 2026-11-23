// Placeholder interactive mode: a plain readline loop. The full-screen terminal UI replaces
// this file and keeps the `runInteractive` signature, so main.ts does not change.
import readline from 'node:readline'
import type { PermissionAnswer, Session } from '@harness/core'
import type { Host } from '../host.js'

export interface InteractiveOptions {
  /** Sent as the first message (positional words on the command line). */
  initialPrompt?: string
  /** A new chat, or the one picked by --continue / --resume. */
  session: Session
}

/** Runs the chat until the user quits; resolves with the process exit code. */
export async function runInteractive(host: Host, opts: InteractiveOptions): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve))
  rl.on('close', () => agent.stop())

  const agent = host.createAgent(opts.session, {
    onEvent: (e) => {
      if (e.type === 'text') process.stdout.write(e.delta)
      else if (e.type === 'tool_start') process.stdout.write(`\n• ${e.name} ${e.subject}\n`)
      else if (e.type === 'notice') process.stderr.write(`${e.level}: ${e.text}\n`)
      else if (e.type === 'error') process.stderr.write(`error: ${e.message}\n`)
    },
    askPermission: async (req): Promise<PermissionAnswer> => {
      const a = (await ask(`\nAllow ${req.tool} ${req.subject}? (${req.reason}) [y/N/a=always] `)).trim().toLowerCase()
      return a === 'a' ? { type: 'allowAlways' } : a === 'y' ? { type: 'allow' } : { type: 'deny' }
    },
    askUser: (q) => ask(`\n${q.question} `),
  })

  const turn = async (text: string) => {
    await agent.send(host.expandPrompt(text))
    process.stdout.write('\n')
  }
  try {
    if (opts.initialPrompt) await turn(opts.initialPrompt)
    process.stdout.write('Type a message, or /exit to quit.\n')
    for (;;) {
      const line = await new Promise<string | null>((resolve) => {
        rl.once('close', () => resolve(null))
        rl.question('> ', resolve)
      })
      if (line === null || line.trim() === '/exit') break
      if (line.trim()) await turn(line)
    }
  } finally {
    rl.close()
  }
  return 0
}
