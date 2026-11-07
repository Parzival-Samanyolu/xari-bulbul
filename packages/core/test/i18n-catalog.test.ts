import { describe, expect, it } from 'vitest'
import { CATALOGS } from '../../../apps/desktop/src/shared/i18n/catalog'
import { LANGS, placeholders, type Message } from '../src/i18n'

const en = CATALOGS.en as Record<string, Message>
const texts = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m).filter((s): s is string => typeof s === 'string'))

describe('desktop catalogue', () => {
  it('has English messages', () => {
    expect(Object.keys(en).length).toBeGreaterThan(0)
  })

  for (const lang of LANGS) {
    describe(lang, () => {
      const cat = CATALOGS[lang] as Record<string, Message>

      it('has the same keys as English', () => {
        expect(Object.keys(cat).sort()).toEqual(Object.keys(en).sort())
      })

      it('has no empty messages', () => {
        for (const [key, msg] of Object.entries(cat)) {
          for (const t of texts(msg)) expect(t.trim(), `${lang} ${key}`).not.toBe('')
        }
      })

      it("keeps English's placeholders", () => {
        for (const [key, msg] of Object.entries(cat)) {
          expect([...placeholders(msg)].sort(), `${lang} ${key}`).toEqual([...placeholders(en[key])].sort())
        }
      })

      it('has every plural form the language needs', () => {
        const cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
        for (const [key, msg] of Object.entries(cat)) {
          if (typeof msg === 'string') continue
          for (const c of cats) expect((msg as Record<string, string | undefined>)[c], `${lang} ${key} ${c}`).toBeTruthy()
        }
      })
    })
  }
})
