import fs from 'node:fs'
import path from 'node:path'
import type { FileAttachment, ImageAttachment } from '../types.js'

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export type Loaded = { kind: 'file'; file: FileAttachment } | { kind: 'image'; image: ImageAttachment }

/** Reads a file the user attached. Text is inlined; images are base64. Anything else is rejected with a clear reason. */
export function loadAttachment(p: string): Loaded {
  const name = path.basename(p)
  const stat = fs.statSync(p)
  if (stat.isDirectory()) throw new Error(`"${name}" is a folder. Attach files, or ask the agent to look in the folder.`)
  const mediaType = IMAGE_TYPES[path.extname(p).toLowerCase()]
  if (mediaType) {
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`"${name}" is ${mb(stat.size)}; images can be up to ${mb(MAX_IMAGE_BYTES)}.`)
    return { kind: 'image', image: { name, mediaType, data: fs.readFileSync(p).toString('base64') } }
  }
  if (stat.size > MAX_TEXT_BYTES) {
    throw new Error(`"${name}" is ${mb(stat.size)}; text files can be up to ${MAX_TEXT_BYTES / 1024} KB. Ask the agent to read it instead, which handles large files.`)
  }
  const buf = fs.readFileSync(p)
  if (isBinary(buf)) throw new Error(`"${name}" isn't a text file. Attach text or code files, or PNG, JPEG, GIF or WebP images.`)
  return { kind: 'file', file: { name, path: p, text: buf.toString('utf8') } }
}

/** A pasted image (no file on disk). */
export function imageFromData(name: string, mediaType: string, data: string): ImageAttachment {
  if (!Object.values(IMAGE_TYPES).includes(mediaType)) throw new Error(`Pasted ${mediaType} isn't supported. Use PNG, JPEG, GIF or WebP.`)
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) throw new Error(`The pasted image is larger than ${mb(MAX_IMAGE_BYTES)}.`)
  return { name, mediaType, data }
}

function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8000)
  return head.includes(0)
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
