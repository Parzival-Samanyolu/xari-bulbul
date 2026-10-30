// Bot faces: which shapes, animals and colors exist, and the face a name picks. Pure, so the
// schema, the renderer (`@harness/core/bots`) and tests share it. The SVG drawings live in the renderer.

export const BOT_SHAPES = ['blob', 'round', 'squircle', 'shield', 'drop', 'flower', 'triangle', 'hexagon', 'cloud', 'star', 'ghost'] as const
export type BotShape = (typeof BOT_SHAPES)[number]

export const BOT_PETS = ['cat', 'dog', 'bunny', 'bear', 'fox', 'frog', 'owl', 'panda'] as const
export type BotPet = (typeof BOT_PETS)[number]

export const BOT_AVATAR_KINDS = ['shape', 'pet', 'image', 'emoji'] as const
export type BotAvatarKind = (typeof BOT_AVATAR_KINDS)[number]

/**
 * Face colors. Mid-light tones, so the dark eyes on them stay above 4.5:1; the renderer draws a
 * darker ring of the same hue around each face, so it also stands out on light backgrounds.
 */
export const BOT_COLORS = [
  { id: 'plum', label: 'Plum', value: '#d98bb0' },
  { id: 'rose', label: 'Rose', value: '#ec8f8a' },
  { id: 'apricot', label: 'Apricot', value: '#eda26b' },
  { id: 'honey', label: 'Honey', value: '#d9b45a' },
  { id: 'moss', label: 'Moss', value: '#9cbb6a' },
  { id: 'mint', label: 'Mint', value: '#6cc3a0' },
  { id: 'sky', label: 'Sky', value: '#72b6dc' },
  { id: 'periwinkle', label: 'Periwinkle', value: '#9aa4e8' },
  { id: 'lilac', label: 'Lilac', value: '#bb98e0' },
  { id: 'stone', label: 'Stone', value: '#b3aaa6' },
] as const

export const DEFAULT_BOT_COLOR: string = BOT_COLORS[0].value

/** FNV-1a over the trimmed, lowercased NFC name: the same name always gives the same number. */
export function hashName(name: string): number {
  const s = name.trim().toLowerCase().normalize('NFC')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The shape and color a name picks. Different bits pick each, so names spread over both. */
export function faceForName(name: string): { shape: BotShape; color: string } {
  const h = hashName(name || 'Bot')
  return { shape: BOT_SHAPES[h % BOT_SHAPES.length], color: BOT_COLORS[(h >>> 8) % BOT_COLORS.length].value }
}

/** A random shape and color, for the Randomize button. */
export function randomFace(rand: () => number = Math.random): { shape: BotShape; color: string } {
  return { shape: BOT_SHAPES[Math.floor(rand() * BOT_SHAPES.length)], color: BOT_COLORS[Math.floor(rand() * BOT_COLORS.length)].value }
}
