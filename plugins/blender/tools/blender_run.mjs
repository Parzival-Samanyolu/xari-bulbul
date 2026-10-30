import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MISSING, blendPath, findBlender } from '../lib/blender.mjs'
import { clip, failure, run } from '../lib/exec.mjs'

export default {
  name: 'blender_run',
  description:
    'Run a Python (bpy) script in Blender without opening its window: `blender --background [file.blend] --python <script>`. ' +
    'Use it to edit scenes, set up materials, render images or export models. Changes to the .blend are only kept if the script saves them ' +
    '(bpy.ops.wm.save_mainfile()). Returns the output and the paths of any rendered or saved files. Load the blender-python skill first for bpy tips.',
  parameters: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'The Python code to run. `import bpy` at the top.' },
      file: { type: 'string', description: 'A .blend file to open first, relative to the project folder. Leave out to start from the default scene.' },
      timeout_sec: { type: 'number', description: 'Stop Blender after this many seconds (default 300, at most 3600). Renders can take a while.' },
    },
    required: ['script'],
  },
  kind: 'exec',
  readOnly: false,
  subject: (input) => {
    const first = String(input?.script ?? '').split('\n').find((l) => l.trim() && !/^\s*(import|from)\s/.test(l)) ?? ''
    return [input?.file, first.trim().slice(0, 80)].filter(Boolean).join(': ')
  },
  async execute(input, ctx) {
    const script = input?.script
    if (typeof script !== 'string' || !script.trim()) return { content: '`script` is required: the Python code to run.', isError: true }
    const blend = blendPath(input.file, ctx.cwd)
    if (blend.error) return { content: blend.error, isError: true }
    if (blend.path && !fs.existsSync(blend.path)) return { content: `File not found: ${blend.path}`, isError: true }
    const bin = findBlender()
    if (!bin) return { content: `Blender was not found. ${MISSING}`, isError: true }
    const timeout = Math.min(Math.max(Number(input.timeout_sec) || 300, 5), 3600)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-run-'))
    const scriptFile = path.join(tmp, 'script.py')
    fs.writeFileSync(scriptFile, script)
    try {
      const args = ['--background', ...(blend.path ? [blend.path] : []), '--python-exit-code', '1', '--python', scriptFile]
      const r = await run(bin, args, { cwd: ctx.cwd, timeoutMs: timeout * 1000, signal: ctx.signal })
      const failed = failure(r, 'Blender', MISSING)
      if (failed) return failed
      const out = r.out.trim()
      const saved = [...new Set([...out.matchAll(/Saved:? ["']([^"'\n]+)["']/g)].map((m) => m[1]))]
      const parts = [clip(out || '(no output)', ctx.toolOutputMaxChars || 30_000)]
      if (saved.length) parts.push(`Saved files:\n${saved.map((f) => `- ${f}`).join('\n')}`)
      if (r.code !== 0) parts.unshift(`Blender exited with code ${r.code}. The script raised an error or Blender failed; see the output.`)
      return { content: parts.join('\n\n'), isError: r.code !== 0 }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  },
}
