import { creatureSprite, pixelate, PIXEL_GRID, type Pixels } from '@harness/core/bots'

// Canvas glue for pixel avatars: decode a picture into RGBA, run the pure pixel code from core,
// and encode the sprite as a PNG for main to save.

/** Largest side a picture is decoded at before pixelating; plenty for a 32×32 result. */
const WORK_SIZE = 256

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Drawing is not available here.')
  return { c, ctx }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Couldn't read the generated picture."))
    img.src = src
  })
}

/** A picture (data URL) as RGBA, scaled to fit WORK_SIZE. */
export async function decodePicture(src: string): Promise<Pixels> {
  const img = await loadImage(src)
  const k = Math.min(1, WORK_SIZE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * k))
  const h = Math.max(1, Math.round(img.naturalHeight * k))
  const { ctx } = canvas(w, h)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data: d.data }
}

export interface PixelPng {
  /** PNG file bytes, for `api.bots.saveAvatar`. */
  bytes: Uint8Array
  /** The same PNG as a data URL, for the preview. */
  url: string
}

/** Sprite pixels → PNG at their own size (the UI scales them up with `image-rendering: pixelated`). */
export async function encodePng(p: Pixels): Promise<PixelPng> {
  const { c, ctx } = canvas(p.width, p.height)
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error("Couldn't encode the avatar.")
  return { bytes: new Uint8Array(await blob.arrayBuffer()), url: c.toDataURL('image/png') }
}

/** A generated picture → a 32×32, 16-color sprite with a clear background. */
export async function pixelatePicture(src: string): Promise<PixelPng> {
  return encodePng(pixelate(await decodePicture(src), { grid: PIXEL_GRID, colors: 16 }))
}

/** The keyless creature for a seed. */
export function spritePng(seed: string): Promise<PixelPng> {
  return encodePng(creatureSprite(seed))
}
