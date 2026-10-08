#!/usr/bin/env node
// xb — Xarı Bülbül in your terminal.
import { runCli } from './cli.js'

// `xb -p … | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0)
    throw e
  })
}

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`xb: ${(err as Error).stack ?? err}\n`)
    process.exit(1)
  },
)
