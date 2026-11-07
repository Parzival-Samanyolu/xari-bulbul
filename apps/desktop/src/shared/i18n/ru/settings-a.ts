import type { Message } from '@harness/core/i18n'
import type en from '../en/settings-a'

export default {
  'settings.general.language': 'Язык',
  'settings.general.languageSystem': 'Системный ({lang})',
  'settings.general.languageHint': 'Язык меню, кнопок и сообщений в приложении.',
} satisfies Record<keyof typeof en, Message>
