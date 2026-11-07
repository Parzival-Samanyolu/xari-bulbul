import { describe, expect, it } from 'vitest'
import { formatAgo, formatBytes, formatMessage, formatNumber, LANGS, LANGUAGE_NAMES, makeT, placeholders, resolveLang } from '../src/i18n'

describe('resolveLang', () => {
  it('follows the system locale for "system"', () => {
    expect(resolveLang('system', ['ru-RU', 'en'])).toBe('ru')
    expect(resolveLang('system', ['de-DE'])).toBe('en')
    expect(resolveLang('system', ['az-Latn-AZ'])).toBe('az')
    expect(resolveLang('system', ['de-DE', 'tr-TR'])).toBe('tr')
    expect(resolveLang(undefined, [])).toBe('en')
  })
  it('uses an explicit language and ignores unknown ones', () => {
    expect(resolveLang('az', ['ru'])).toBe('az')
    expect(resolveLang('xx', [])).toBe('en')
  })
})

describe('formatMessage', () => {
  const files = { one: '{count} файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' }
  it('picks the plural form', () => {
    expect(formatMessage('ru', files, { count: 5 })).toBe('5 файлов')
    expect(formatMessage('ru', files, { count: 2 })).toBe('2 файла')
    expect(formatMessage('ru', files, { count: 21 })).toBe('21 файл')
    expect(formatMessage('en', { one: '{count} file', other: '{count} files' }, { count: 1 })).toBe('1 file')
    expect(formatMessage('en', { one: '{count} file', other: '{count} files' }, { count: 3 })).toBe('3 files')
  })
  it('fills placeholders and leaves unknown ones', () => {
    expect(formatMessage('en', 'Hi {name}', { name: 'Ali' })).toBe('Hi Ali')
    expect(formatMessage('en', 'Hi {x}', { name: 'Ali' })).toBe('Hi {x}')
  })
})

describe('makeT', () => {
  it('falls back to English, then to the key', () => {
    const t = makeT('az', { en: { k: 'Hello' }, az: {} as never, tr: {} as never, ru: {} as never })
    expect(t('k')).toBe('Hello')
    expect(makeT('en', { en: {} as Record<'z', string>, az: {} as never, tr: {} as never, ru: {} as never })('z')).toBe('z')
  })
  it('uses the chosen language with vars', () => {
    const t = makeT('tr', { en: { k: 'Hi {n}' }, az: { k: 'Salam {n}' }, tr: { k: 'Merhaba {n}' }, ru: { k: 'Привет {n}' } })
    expect(t('k', { n: 'Ali' })).toBe('Merhaba Ali')
  })
})

describe('helpers', () => {
  it('lists placeholders once, in order', () => {
    expect(placeholders('A {b} {c} {b}')).toEqual(['b', 'c'])
    expect(placeholders({ one: '{count} x', other: '{count} xs {y}' })).toEqual(['count', 'y'])
  })
  it('formats bytes per locale', () => {
    expect(formatBytes('en', 1536)).toBe('1.5 KB')
    expect(formatBytes('ru', 1536)).toContain('1,5')
    expect(formatBytes('en', 500)).toBe('500 B')
  })
  it('formats short relative times', () => {
    const now = Date.now()
    expect(formatAgo('en', now - 5 * 60_000, now)).toBe('5m')
    expect(formatAgo('en', now - 1000, now)).toBe('now')
    expect(formatAgo('en', now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatAgo('en', now - 2 * 86_400_000, now)).toBe('2d')
    expect(formatAgo('en', now - 14 * 86_400_000, now)).toBe('2w')
    const ru = formatAgo('ru', now - 5 * 60_000, now)
    expect(ru.length).toBeGreaterThan(0)
    expect(ru).toContain('5')
    for (const l of LANGS) expect(formatAgo(l, now, now).length).toBeGreaterThan(0)
  })
  it('formats numbers and names languages', () => {
    expect(formatNumber('en', 1234.5)).toBe('1,234.5')
    expect(LANGUAGE_NAMES.az).toBe('Azərbaycanca')
  })
})
