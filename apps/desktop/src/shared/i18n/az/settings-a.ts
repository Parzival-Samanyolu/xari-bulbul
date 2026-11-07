import type { Message } from '@harness/core/i18n'
import type en from '../en/settings-a'

export default {
  'settings.general.language': 'Dil',
  'settings.general.languageSystem': 'Sistem ({lang})',
  'settings.general.languageHint': 'Tətbiqdəki menyuların, düymələrin və bildirişlərin dili.',
} satisfies Record<keyof typeof en, Message>
