import type { Lang, Message } from '@harness/core/i18n'
import az from './az'
import en from './en'
import ru from './ru'
import tr from './tr'

/** Every UI message key; English is the source of truth. */
export type MessageKey = keyof typeof en
export type Catalog = Record<MessageKey, Message>

/** Per-language messages. Each `<lang>/<area>.ts` must have exactly the keys of `en/<area>.ts` (a type error otherwise). */
export const CATALOGS: Record<Lang, Catalog> = { en, az, tr, ru }
