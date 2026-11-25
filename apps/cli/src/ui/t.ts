// The interface language for the Ink components: App provides the store's `t`, components read it.
import { createContext, useContext } from 'react'
import { tEn, type T } from '../i18n/index.js'

export const TContext = createContext<T>(tEn)

/** Messages in the interface language (English outside a provider, as in tests). */
export const useT = (): T => useContext(TContext)
