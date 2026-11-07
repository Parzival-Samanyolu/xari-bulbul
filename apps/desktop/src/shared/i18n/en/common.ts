import type { Message } from '@harness/core/i18n'

/** Words shared by many screens: buttons and states. Area files keep their own sentences. */
export default {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.close': 'Close',
  'common.open': 'Open',
  'common.add': 'Add',
  'common.edit': 'Edit',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.retry': 'Retry',
  'common.stop': 'Stop',
  'common.allow': 'Allow',
  'common.deny': 'Deny',
  'common.back': 'Back',
  'common.done': 'Done',
  'common.reset': 'Reset',
  'common.loading': 'Loading…',
  'common.on': 'On',
  'common.off': 'Off',
  'common.none': 'None',
  'common.default': 'Default',
} as const satisfies Record<string, Message>
