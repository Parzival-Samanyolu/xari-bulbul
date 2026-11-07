import { beforeAll, describe, expect, it } from 'vitest'
import type { Lang } from '../src/i18n'

// The settings tree lives in the desktop renderer (TSX, outside this package's type check), so it
// is imported by a computed path and typed here. `lib/api` reads `window.harness` on import.
interface SearchHit {
  tabId: string
  sectionId: string
  rows: string[]
  label: string
}
interface Tree {
  fold(s: string): string
  searchSettings(query: string, lang: Lang, limit?: number): SearchHit[]
}
const TREE = new URL('../../../apps/desktop/src/renderer/src/components/settings/tree.tsx', import.meta.url).href
let tree: Tree

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window ??= { harness: {} }
  tree = (await import(/* @vite-ignore */ TREE)) as Tree
})

const labels = (q: string, lang: Lang) => tree.searchSettings(q, lang, 50).map((h) => h.label)

describe('settings search fold', () => {
  it('maps Azerbaijani ə to e and Turkish dotted and dotless i to i', () => {
    expect(tree.fold('Şifrə')).toBe('sifre')
    expect(tree.fold('Əmrlər')).toBe('emrler')
    expect(tree.fold('İzinler Kullanım')).toBe('izinler kullanim')
  })
})

describe('settings search', () => {
  it('finds an Azerbaijani label typed without ə', () => {
    expect(labels('slash emrleri', 'az')).toContain('Slash əmrləri')
  })

  it('finds Turkish labels typed without İ or ı', () => {
    expect(labels('izinler', 'tr')).toContain('İzinler')
    expect(labels('kullanim', 'tr')).toContain('Kullanım ve bütçeler')
  })

  it('finds a Russian label', () => {
    const hits = tree.searchSettings('Язык', 'ru', 50)
    const row = hits.find((h) => h.label === 'Язык' && h.sectionId === 'appearance')
    expect(row?.rows).toEqual(expect.arrayContaining(['Язык', 'Language']))
  })

  it('finds a translated section by its English name', () => {
    const hit = tree.searchSettings('slash commands', 'ru', 50).find((h) => h.sectionId === 'tools.skills' && h.rows.length)
    expect(hit?.label).toBe('Слэш-команды')
    // The page's Section sets data-row to the English title, which search tries after the translated one.
    expect(hit?.rows).toContain('Slash commands')
  })
})
