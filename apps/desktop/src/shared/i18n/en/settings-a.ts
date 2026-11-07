import type { Message } from '@harness/core/i18n'

export default {
  'settings.general.language': 'Language',
  'settings.general.languageSystem': 'System ({lang})',
  'settings.general.languageHint': 'The language of menus, buttons and messages in the app.',
} as const satisfies Record<string, Message>
