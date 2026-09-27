import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bashTool } from '../src/tools/bash.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { readFileTool } from '../src/tools/read-file.js'
import { globTool, grepTool, listDirTool } from '../src/tools/search.js'
import { writeFileTool } from '../src/tools/write-file.js'
import { ctx, tmpDir } from './helpers.js'

describe('file tools', () => {
  it('read_file numbers lines and records the read', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree')
    const c = ctx(dir)
    const r = await readFileTool.execute(readFileTool.parse({ path: 'a.txt', offset: 2, limit: 1 }), c)
    expect(r.content).toContain('2→two')
    expect(r.content).not.toContain('one')
    expect(c.readFiles.has(path.join(dir, 'a.txt'))).toBe(true)
  })

  it('edit_file requires a prior read, a unique match, and returns a diff', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'const x = 1\nconst y = 1\n')
    const c = ctx(dir)
    const edit = (i: object) => editFileTool.execute(editFileTool.parse({ path: 'a.ts', ...i }), c)

    expect((await edit({ old_string: 'x = 1', new_string: 'x = 2' })).isError).toBe(true) // not read yet
    c.readFiles.add(file)
    expect((await edit({ old_string: '= 1', new_string: '= 2' })).content).toMatch(/occurs 2 times/)
    expect((await edit({ old_string: 'nope', new_string: 'x' })).content).toMatch(/not found/)
    const ok = await edit({ old_string: 'const x = 1', new_string: 'const x = 42' })
    expect(ok.isError).toBeFalsy()
    expect(ok.display?.kind).toBe('diff')
    expect(fs.readFileSync(file, 'utf8')).toBe('const x = 42\nconst y = 1\n')
    await edit({ old_string: '= 1', new_string: '= 0', replace_all: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('const x = 42\nconst y = 0\n')
  })

  it('edit_file handles CRLF files when the model sends LF', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'w.txt')
    fs.writeFileSync(file, 'a\r\nb\r\nc\r\n')
    const c = ctx(dir)
    c.readFiles.add(file)
    const r = await editFileTool.execute(editFileTool.parse({ path: 'w.txt', old_string: 'a\nb', new_string: 'a\nB' }), c)
    expect(r.isError).toBeFalsy()
    expect(fs.readFileSync(file, 'utf8')).toBe('a\r\nB\r\nc\r\n')
  })

  it('write_file creates new files but refuses unread overwrites', async () => {
    const dir = tmpDir()
    const c = ctx(dir)
    const w = (content: string) => writeFileTool.execute(writeFileTool.parse({ path: 'sub/n.txt', content }), c)
    expect((await w('hello')).isError).toBeFalsy()
    const c2 = ctx(dir)
    const r = await writeFileTool.execute(writeFileTool.parse({ path: 'sub/n.txt', content: 'x' }), c2)
    expect(r.isError).toBe(true)
  })
})

describe('search tools', () => {
  it('glob, grep and list_dir honor .gitignore', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.mkdirSync(path.join(dir, 'build'))
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n')
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const needle = 1\n')
    fs.writeFileSync(path.join(dir, 'build', 'a.js'), 'needle\n')
    const c = ctx(dir)
    expect((await globTool.execute(globTool.parse({ pattern: '**/*' }), c)).content.split('\n').sort()).toEqual(['.gitignore', 'src/a.ts'])
    const g = await grepTool.execute(grepTool.parse({ pattern: 'needle' }), c)
    expect(g.content).toBe('src/a.ts:1: export const needle = 1')
    const l = await listDirTool.execute(listDirTool.parse({}), c)
    expect(l.content).toContain('src/')
    expect(l.content).not.toContain('build')
  })
})

describe('bash', () => {
  it('runs commands and reports exit codes', async () => {
    const dir = tmpDir()
    const cmd = process.platform === 'win32' ? 'Write-Output hi; exit 3' : 'echo hi; exit 3'
    const r = await bashTool.execute(bashTool.parse({ command: cmd }), ctx(dir))
    expect(r.content).toContain('hi')
    expect(r.content).toContain('[exit code: 3]')
    expect(r.isError).toBe(true)
  }, 30_000) // PowerShell can take several seconds to start on CI machines

  it('kills on timeout', async () => {
    if (process.platform === 'win32') return
    const r = await bashTool.execute(bashTool.parse({ command: 'sleep 5', timeout_sec: 1 }), ctx(tmpDir()))
    expect(r.content).toContain('timeout')
  })
})
