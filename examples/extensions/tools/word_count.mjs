// Example custom tool. Copy to ~/.harness/tools/ (or <project>/.harness/tools/) and click
// Settings → Tools & Extensions → Reload. The model can then call `word_count`.
import fs from 'node:fs/promises'
import path from 'node:path'

export default {
  name: 'word_count',
  description: 'Count lines, words and characters in a file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path relative to the project' } },
    required: ['path'],
  },
  readOnly: true, // read-only tools never ask for permission
  kind: 'read',
  subject: (input) => input.path,
  async execute(input, ctx) {
    const text = await fs.readFile(path.resolve(ctx.cwd, input.path), 'utf8')
    const lines = text.split('\n').length
    const words = text.split(/\s+/).filter(Boolean).length
    return `${input.path}: ${lines} lines, ${words} words, ${text.length} characters`
  },
}
