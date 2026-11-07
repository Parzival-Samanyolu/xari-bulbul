import { makeT, type Lang, type Message } from '@harness/core/i18n'
import az from './az'
import en from './en'
import ru from './ru'
import tr from './tr'

/** Every UI message key; English is the source of truth. */
export type MessageKey = keyof typeof en
export type Catalog = Record<MessageKey, Message>

/** Per-language messages. Each `<lang>/<area>.ts` must have exactly the keys of `en/<area>.ts` (a type error otherwise). */
export const CATALOGS: Record<Lang, Catalog> = { en, az, tr, ru }

const ts = new Map<Lang, (key: MessageKey) => string>()
const tFor = (lang: Lang) => {
  let t = ts.get(lang)
  if (!t) ts.set(lang, (t = makeT<MessageKey>(lang, CATALOGS)))
  return t
}

/**
 * What settings search matches for these messages: each one in `lang`, plus its English
 * text when that differs, so English words keep finding a setting in every language.
 */
export function searchText(keys: readonly MessageKey[], lang: Lang): string {
  const out: string[] = []
  for (const key of keys) {
    const own = tFor(lang)(key)
    out.push(own)
    if (lang !== 'en') {
      const english = tFor('en')(key)
      if (english !== own) out.push(english)
    }
  }
  return out.join(' ')
}
