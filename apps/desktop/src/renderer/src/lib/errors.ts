import { decodeAppError } from '../../../shared/app-error'
import type { MessageKey } from '../../../shared/i18n/catalog'

const REMOTE = /^Error invoking remote method '[^']+': (Error: )?/

/** A failed call's text without Electron's IPC prefix, and the catalogue key when main sent an app error. */
export function errorInfo(e: unknown): { text: string; key?: MessageKey } {
  return decodeAppError(String((e as Error)?.message ?? e).replace(REMOTE, ''))
}

/** A failed call's text, ready to show. */
export const errorText = (e: unknown): string => errorInfo(e).text
