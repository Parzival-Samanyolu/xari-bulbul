import type { Settings } from '../../../shared/ipc'

// Keyboard shortcuts the user can rebind (Settings › Keyboard shortcuts). Combos are stored as
// "Mod+Alt+B": Mod is ⌘ on macOS and Ctrl elsewhere; the key comes from the physical key, so
// Option on a Mac (which changes the typed character) still matches.

export type ShortcutId = 'modelPicker' | 'settings' | 'newChat' | 'terminal' | 'filesPanel'

export const SHORTCUTS: { id: ShortcutId; label: string; help: string; combo: string }[] = [
  { id: 'modelPicker', label: 'Switch model', help: 'Opens the model switcher. In Settings the same keys search settings.', combo: 'Mod+K' },
  { id: 'settings', label: 'Open Settings', help: 'Opens and closes this window.', combo: 'Mod+,' },
  { id: 'newChat', label: 'New chat', help: 'Starts a chat in the current folder.', combo: 'Mod+N' },
  { id: 'terminal', label: 'Terminal panel', help: 'Shows or hides the terminal at the bottom.', combo: 'Mod+J' },
  { id: 'filesPanel', label: 'Files and changes panel', help: 'Shows or hides the panel on the right.', combo: 'Mod+Alt+B' },
]

/** Shortcuts that can't be changed, listed for reference. */
export const FIXED_SHORTCUTS: { label: string; combo: string }[] = [
  { label: 'Open the nth chat in the folder', combo: 'Mod+1…9' },
  { label: 'Change permission mode (in the message box)', combo: 'Shift+Tab' },
  { label: 'Send when Enter adds a newline', combo: 'Mod+Enter' },
  { label: 'Add or remove a favorite (in the model switcher)', combo: 'Mod+D' },
  { label: 'Stop the agent, or deny an approval', combo: 'Escape' },
]

/** Combos the system or the app already uses, which can't be assigned. */
const RESERVED = new Set(['Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Q', 'Mod+W', 'Mod+D', 'Mod+Enter', 'Shift+Tab', ...'123456789'.split('').map((d) => `Mod+${d}`)])

const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space',
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS'])

export const isMac = (platform: string | undefined) => platform === 'darwin'

/** The combo a key press makes, or null for a bare modifier. */
export function comboFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac: boolean): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : (CODE_KEYS[e.code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key))
  const parts: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  if (mac && e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function shortcutFor(settings: Settings, id: ShortcutId): string {
  return settings.shortcuts[id] || SHORTCUTS.find((s) => s.id === id)!.combo
}

export function matchesShortcut(e: KeyboardEvent, settings: Settings, id: ShortcutId, mac: boolean): boolean {
  return comboFromEvent(e, mac) === shortcutFor(settings, id)
}

/** "Mod+Alt+B" → "⌥⌘B" on macOS, "Ctrl+Alt+B" elsewhere. */
export function formatCombo(combo: string, mac: boolean): string {
  const parts = combo.split('+').map((p, i, all) => (p === '' && i === all.length - 1 ? '+' : p)).filter(Boolean)
  if (!mac) return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p === 'Escape' ? 'Esc' : p)).join('+')
  const sym: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↵', Escape: 'Esc', Tab: '⇥' }
  // macOS order: Control, Option, Shift, Command.
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod']
  const mods = parts.filter((p) => order.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const rest = parts.filter((p) => !order.includes(p))
  return [...mods, ...rest].map((p) => sym[p] ?? p).join('')
}

/** Why a combo can't be used for `id`, or null when it can. */
export function comboProblem(combo: string, id: ShortcutId, settings: Settings): string | null {
  const parts = combo.split('+')
  const key = parts.at(-1) ?? ''
  if (!parts.some((p) => p === 'Mod' || p === 'Ctrl' || p === 'Alt') && !/^F\d{1,2}$/.test(key)) return 'Include ⌘/Ctrl or Alt, so typing isn’t taken over.'
  if (RESERVED.has(combo)) return 'That one is already used by the system or the app.'
  const other = SHORTCUTS.find((s) => s.id !== id && shortcutFor(settings, s.id) === combo)
  return other ? `Already used by “${other.label}”.` : null
}
