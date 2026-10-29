import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkpointChanges, MAX_DIFF_BYTES } from '../src/sessions/changes.js'
import { listDir, readPreview, rootFor } from '../src/host/files.js'
import { tmpDir } from './helpers.js'

describe('checkpointChanges', () => {
  it('diffs each file from before its first turn against the working tree', () => {
    const dir = tmpDir()
    const a = path.join(dir, 'src', 'a.ts')
    const b = path.join(dir, 'b.txt')
    fs.mkdirSync(path.dirname(a))
    fs.writeFileSync(a, 'one\nTWO\nthree\nfour\n')
    fs.writeFileSync(b, 'new file\n')
    const changes = checkpointChanges(
      [
        // Out of order on purpose: the earliest turn's content is the baseline.
        { at: 6, files: { [a]: 'one\ntwo-ish\nthree\n' } },
        { at: 2, files: { [a]: 'one\ntwo\nthree\n', [b]: null } },
      ],
      dir,
    )
    expect(changes.map((c) => [c.rel, c.status, c.turns])).toEqual([
      ['b.txt', 'added', [2]],
      ['src/a.ts', 'modified', [2, 6]],
    ])
    const ca = changes[1]
    expect(ca.added).toBe(2)
    expect(ca.removed).toBe(1)
    expect(ca.patch).toContain('-two\n')
    expect(ca.patch).toContain('+TWO\n')
    expect(changes[0].patch).toContain('+new file')
  })

  it('reports deleted files and leaves out files that are back to how they were', () => {
    const dir = tmpDir()
    const gone = path.join(dir, 'gone.md')
    const same = path.join(dir, 'same.md')
    fs.writeFileSync(same, 'unchanged\n')
    const changes = checkpointChanges([{ at: 0, files: { [gone]: 'bye\n', [same]: 'unchanged\n' } }], dir)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ rel: 'gone.md', status: 'deleted', removed: 1, added: 0 })
  })

  it('skips the diff for binary and very large files', () => {
    const big = 'x'.repeat(MAX_DIFF_BYTES + 1)
    const disk: Record<string, string | null> = { '/p/bin': 'a\0b', '/p/big': big + 'y' }
    const changes = checkpointChanges([{ at: 0, files: { '/p/bin': 'a\0c', '/p/big': big } }], '/p', (f) => disk[f] ?? null)
    expect(changes.map((c) => [c.rel, c.note, c.patch])).toEqual([
      ['big', 'Too large to show', ''],
      ['bin', 'Binary file', ''],
    ])
  })

  it('keeps absolute paths for files outside the folder', () => {
    const changes = checkpointChanges([{ at: 0, files: { '/elsewhere/x': 'a' } }], '/p', () => 'b')
    expect(changes[0].rel).toBe('/elsewhere/x')
  })
})

describe('Files panel helpers', () => {
  it('lists folders first, skipping .gitignore matches and dependency folders', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n*.log\n')
    for (const d of ['src', 'dist', 'node_modules', '.git']) fs.mkdirSync(path.join(dir, d))
    for (const f of ['b.ts', 'a.ts', 'debug.log', 'src/x.ts']) fs.writeFileSync(path.join(dir, f), '')
    const { entries, hidden } = await listDir(dir, dir)
    expect(entries.map((e) => [e.name, e.dir])).toEqual([
      ['src', true],
      ['.gitignore', false],
      ['a.ts', false],
      ['b.ts', false],
    ])
    expect(hidden).toBe(0)
    expect((await listDir(dir, path.join(dir, 'src'))).entries.map((e) => e.name)).toEqual(['x.ts'])
  })

  it('caps the entries per directory', async () => {
    const dir = tmpDir()
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}`), '')
    const { entries, hidden } = await listDir(dir, dir, 5)
    expect(entries).toHaveLength(5)
    expect(hidden).toBe(7)
  })

  it('refuses paths outside the open folders, including through symlinks', () => {
    const root = tmpDir()
    const outside = tmpDir()
    fs.writeFileSync(path.join(outside, 'secret'), 's')
    fs.symlinkSync(outside, path.join(root, 'link'))
    expect(rootFor([root], path.join(root, 'a', 'b'))).toBe(root)
    expect(rootFor([root], root)).toBe(root)
    expect(rootFor([root], path.join(root, '..', 'x'))).toBeNull()
    expect(rootFor([root], path.join(root, 'link', 'secret'))).toBeNull()
    expect(rootFor([outside, root], path.join(outside, 'secret'))).toBe(outside)
  })

  it('previews text, truncates long files and flags binary ones', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 't.txt'), 'hello world')
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([1, 0, 2]))
    expect(await readPreview(path.join(dir, 't.txt'))).toMatchObject({ text: 'hello world', truncated: false, binary: false, size: 11 })
    expect(await readPreview(path.join(dir, 't.txt'), 5)).toMatchObject({ text: 'hello', truncated: true })
    expect(await readPreview(path.join(dir, 'b.bin'))).toMatchObject({ text: '', binary: true })
    await expect(readPreview(dir)).rejects.toThrow('Not a file')
  })
})
