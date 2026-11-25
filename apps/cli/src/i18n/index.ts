// The terminal app's interface language and messages. Same engine (@harness/core/i18n) and the
// same setting as the desktop app, so both speak the language chosen in Settings › General.
import { makeT, resolveLang, type Lang, type Message, type Vars } from '@harness/core/i18n'
import az from './az.js'
import en from './en.js'
import ru from './ru.js'
import tr from './tr.js'

export type { Lang } from '@harness/core/i18n'

/** Every CLI message key; English is the source of truth. */
export type MessageKey = keyof typeof en
export type Catalog = Record<MessageKey, Message>
export type T = (key: MessageKey, vars?: Vars) => string

/** Per-language messages. Each `<lang>.ts` must have exactly the keys of `en.ts` (a type error otherwise). */
export const CATALOGS: Record<Lang, Catalog> = { en, az, tr, ru }

/**
 * The interface language: the desktop's `appearance.language` when it names one, else
 * `XARI_LANG`, else the system locale (LC_ALL, LC_MESSAGES, LANG, then Intl's default).
 * Unsupported values are skipped; English when nothing matches.
 */
export function cliLanguage(setting: string | undefined, env: NodeJS.ProcessEnv, intlLocale: string = defaultLocale()): Lang {
  if (setting && setting !== 'system') return resolveLang(setting, [])
  // POSIX order: the first of LC_ALL, LC_MESSAGES and LANG that is set is the one in effect.
  const posix = env.LC_ALL || env.LC_MESSAGES || env.LANG
  const locales = [env.XARI_LANG, posix, intlLocale].filter((s): s is string => !!s)
  return resolveLang('system', locales)
}

function defaultLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return ''
  }
}

const ts = new Map<Lang, T>()
/** `t(key, vars)` for one language, falling back to English. */
export function tFor(lang: Lang): T {
  let t = ts.get(lang)
  if (!t) ts.set(lang, (t = makeT<MessageKey>(lang, CATALOGS)))
  return t
}

/** English, for code that runs before the language is known and for tests. */
export const tEn: T = tFor('en')

/** Whether `key` is a message (for keys built at run time, like `tool.<name>`). */
export const hasMessage = (key: string): key is MessageKey => Object.prototype.hasOwnProperty.call(en, key)
