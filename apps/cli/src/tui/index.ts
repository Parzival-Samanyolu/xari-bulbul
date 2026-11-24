// Xarı's interactive terminal: an Ink app (src/ui) on the same engine as the desktop app.
import path from 'node:path'
import React from 'react'
import { render } from 'ink'
import type { Session } from '@harness/core'
import pkg from '../../package.json'
import type { Host } from '../host.js'
import { App } from '../ui/App.js'
import { ChatStore, readHistory } from '../ui/store.js'
import { LineEditor } from './editor.js'

export interface InteractiveOptions {
  /** Sent as the first message (positional words on the command line). */
  initialPrompt?: string
  /** A new chat, or the one picked by --continue / --resume. */
  session: Session
}

/** Runs the chat until the user quits; resolves with the process exit code. */
export async function runInteractive(host: Host, opts: InteractiveOptions): Promise<number> {
  const historyFile = path.join(host.dataDir, 'cli-history.json')
  const store = new ChatStore(host, opts.session, pkg.version)
  const editor = new LineEditor(readHistory(historyFile))
  // Ctrl+C is ours (stop, clear, then quit), not Ink's.
  const app = render(React.createElement(App, { store, editor, historyFile }), { exitOnCtrlC: false })
  if (opts.initialPrompt) void store.submit(opts.initialPrompt)
  await app.waitUntilExit()
  store.dispose()
  if (store.hasMessages) process.stdout.write(`\x1b[2mResume this chat with: xari --resume ${store.sessionId}\x1b[22m\n`)
  return 0
}
