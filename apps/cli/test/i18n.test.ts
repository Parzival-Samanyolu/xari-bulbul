import { describe, expect, it } from 'vitest'
import { LANGS, placeholders, type Message } from '@harness/core/i18n'
import { parseArgs, usage } from '../src/args.js'
import { CATALOGS, cliLanguage, tFor } from '../src/i18n/index.js'
import { ago, modeLabel } from '../src/ui/store.js'
import { toolLabel } from '../src/ui/App.js'

const en = CATALOGS.en as Record<string, Message>
const texts = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m).filter((s): s is string => typeof s === 'string'))

describe('CLI catalogue', () => {
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

      it('is a plural wherever English is one, and only there', () => {
        for (const [key, msg] of Object.entries(cat)) expect(typeof msg, `${lang} ${key}`).toBe(typeof en[key])
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

describe('cliLanguage', () => {
  it('takes the desktop setting first', () => {
    expect(cliLanguage('tr', { XARI_LANG: 'ru', LANG: 'az_AZ.UTF-8' }, 'en-US')).toBe('tr')
  })

  it('with `system`, takes XARI_LANG, then the locale, then Intl', () => {
    expect(cliLanguage('system', { XARI_LANG: 'ru', LANG: 'az_AZ.UTF-8' }, 'en-US')).toBe('ru')
    expect(cliLanguage('system', { LANG: 'az_AZ.UTF-8' }, 'en-US')).toBe('az')
    expect(cliLanguage('system', { LC_ALL: 'tr_TR.UTF-8', LANG: 'az_AZ.UTF-8' }, 'en-US')).toBe('tr')
    expect(cliLanguage(undefined, {}, 'ru-RU')).toBe('ru')
  })

  it('skips what it does not support and falls back to English', () => {
    expect(cliLanguage('system', { XARI_LANG: 'fr', LANG: 'C.UTF-8' }, 'tr-TR')).toBe('tr')
    expect(cliLanguage('system', { LANG: 'de_DE.UTF-8' }, 'de-DE')).toBe('en')
  })
})

describe('translated text', () => {
  it('translates --help and usage errors, keeping the flags', () => {
    const az = tFor('az')
    const help = usage(az)
    expect(help).toContain('İstifadə:')
    expect(help).toContain('--output-format <f>')
    expect(usage()).toContain('Usage:')
    const r = parseArgs(['--bogus'], tFor('ru'))
    expect(r.ok === false && r.error).toBe('неизвестный параметр «--bogus». Список: «xari --help».')
  })

  it('names modes, tools and times in the language', () => {
    expect(modeLabel('acceptEdits', tFor('ru'))).toBe('Автоправки')
    expect(modeLabel('auto')).toBe('Full auto')
    expect(toolLabel('bash', tFor('tr'))).toBe('Komut')
    expect(toolLabel('read_file')).toBe('Read')
    expect(toolLabel('mcp__github__search')).toBe('github · search')
    expect(ago(Date.now() - 5 * 86_400_000, tFor('ru'))).toBe('5 дней назад')
  })
})
