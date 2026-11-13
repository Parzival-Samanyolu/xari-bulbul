import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Runs `node test.js` in the task folder; passing means exit code 0. */
export function nodeTest(dir: string, file = 'test.js'): { pass: boolean; detail: string } {
  try {
    execFileSync(process.execPath, [file], { cwd: dir, stdio: 'pipe', timeout: 20_000 })
    return { pass: true, detail: 'tests pass' }
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string }
    return { pass: false, detail: (err.stderr?.toString() || err.message).trim().split('\n').slice(0, 3).join(' ').slice(0, 200) }
  }
}

export const read = (dir: string, f: string) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8')
  } catch {
    return null
  }
}

/** Writes a test the model never saw into the task folder and runs it. */
export function hiddenTest(dir: string, code: string) {
  // The first line of the failure message makes a better `detail` than a stack frame.
  const report = `process.on('uncaughtException', (e) => {\n  console.error(String(e && e.message).split('\\n')[0])\n  process.exit(1)\n})\n`
  fs.writeFileSync(path.join(dir, '.bench-hidden.js'), report + code)
  return nodeTest(dir, '.bench-hidden.js')
}
