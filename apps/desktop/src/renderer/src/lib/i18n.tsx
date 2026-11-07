import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { formatAgo, formatBytes, formatNumber, makeT, resolveLang, type Lang, type Vars } from '@harness/core/i18n'
import { CATALOGS, type MessageKey } from '../../../shared/i18n/catalog'

interface I18n {
  t: (key: MessageKey, vars?: Vars) => string
  lang: Lang
}

const english: I18n = { t: makeT<MessageKey>('en', CATALOGS), lang: 'en' }
const I18nContext = createContext<I18n>(english)
/** The language 'system' resolves to right now. */
const SystemLangContext = createContext<Lang>('en')

/**
 * The interface language for everything below it. `setting` is `appearance.language`; 'system'
 * picks from `system`, the OS languages main reports in `AppState.systemLanguages`, so main and
 * renderer agree. `navigator.languages` stands in only before the first state arrives.
 */
export function I18nProvider({ setting, system, children }: { setting: string; system?: readonly string[]; children: ReactNode }) {
  const systemKey = (system ?? navigator.languages).join(',')
  const systemLang = useMemo(() => resolveLang('system', systemKey ? systemKey.split(',') : []), [systemKey])
  const lang = setting === 'system' ? systemLang : resolveLang(setting, [])
  const value = useMemo<I18n>(() => (lang === 'en' ? english : { t: makeT<MessageKey>(lang, CATALOGS), lang }), [lang])
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  return (
    <SystemLangContext.Provider value={systemLang}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </SystemLangContext.Provider>
  )
}

/** The language `appearance.language: 'system'` resolves to, for the language picker. */
export function useSystemLang(): Lang {
  return useContext(SystemLangContext)
}

/** `t(key, vars)` in the current language (English for a missing message), and the language itself. */
export function useT(): I18n {
  return useContext(I18nContext)
}

/** Numbers, sizes, short relative times and dates in the current language. */
export function useFormat(): {
  bytes(n: number): string
  ago(ts: number): string
  num(n: number, o?: Intl.NumberFormatOptions): string
  date(ts: number, o?: Intl.DateTimeFormatOptions): string
} {
  const { lang } = useT()
  return useMemo(
    () => ({
      bytes: (n: number) => formatBytes(lang, n),
      ago: (ts: number) => formatAgo(lang, ts),
      num: (n: number, o?: Intl.NumberFormatOptions) => formatNumber(lang, n, o),
      date: (ts: number, o?: Intl.DateTimeFormatOptions) => new Date(ts).toLocaleString(lang, o),
    }),
    [lang],
  )
}
