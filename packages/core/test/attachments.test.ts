import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { imageFromData, loadAttachment } from '../src/attachments/load.js'
import { estimateTokens } from '../src/context/compact.js'
import { toWireMessage } from '../src/providers/openai-compat.js'
import { tmpDir } from './helpers.js'

describe('attachments', () => {
  it('loads text files, images, and rejects binaries and huge files', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(dir, 'pic.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2]))
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(300 * 1024))
    expect(loadAttachment(path.join(dir, 'a.ts'))).toMatchObject({ kind: 'file', file: { name: 'a.ts', text: 'export const a = 1\n' } })
    expect(loadAttachment(path.join(dir, 'pic.PNG'))).toMatchObject({ kind: 'image', image: { mediaType: 'image/png', data: 'iVBORwABAg==' } })
    expect(() => loadAttachment(path.join(dir, 'blob.bin'))).toThrow(/isn't a text file/)
    expect(() => loadAttachment(path.join(dir, 'big.txt'))).toThrow(/up to 256 KB/)
    expect(() => loadAttachment(dir)).toThrow(/is a folder/)
    expect(() => imageFromData('x.tiff', 'image/tiff', 'AAAA')).toThrow(/isn't supported/)
  })

  it('sends files as text and images as content parts', () => {
    const plain = toWireMessage({ role: 'user', content: 'look', files: [{ name: 'a.ts', path: '/p/a.ts', text: 'code' }] })
    expect(plain).toEqual({ role: 'user', content: 'look\n\n<file name="/p/a.ts">\ncode\n</file>' })
    const vision = toWireMessage({ role: 'user', content: 'what is this', images: [{ name: 'x.png', mediaType: 'image/png', data: 'AAAA' }] })
    expect(vision.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
    expect(estimateTokens([{ role: 'user', content: '', images: [{ name: 'x', mediaType: 'image/png', data: '' }] }])).toBe(1000)
  })
})
