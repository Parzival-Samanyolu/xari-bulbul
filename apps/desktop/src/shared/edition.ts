// Which app this build is. One codebase, two apps: set XARI_EDITION=qaqash when building Qaqaş.
// Main, preload and renderer all get the same value from electron.vite.config.ts (`__EDITION__`).

declare const __EDITION__: string

export type EditionId = 'xari' | 'qaqash'

export interface Edition {
  id: EditionId
  /** Shown in windows, menus and notifications. Also names the data folder, so it never changes for an edition. */
  name: string
  /** For places that must be ASCII (sign-in app names, file names). */
  asciiName: string
  /** What each edition turns on. */
  features: {
    /** Folders, coding chats and the Sessions tab. */
    coding: boolean
    /** Bots, lobbies and the Bots tab. */
    bots: boolean
    /** WhatsApp and iMessage. */
    gateways: boolean
    /** Mail accounts and notes for automations. */
    mail: boolean
  }
  /** Settings tabs and sections this edition leaves out (ids from settings/tree.tsx). */
  hiddenSettings: string[]
  /** The auto-update feed: `latest` for Xarı Bülbül, its own for Qaqaş, so one release can carry both. */
  updateChannel: string
}

const EDITIONS: Record<EditionId, Edition> = {
  xari: {
    id: 'xari',
    name: 'Xarı Bülbül',
    asciiName: 'Xari Bulbul',
    features: { coding: true, bots: false, gateways: false, mail: false },
    hiddenSettings: ['bots', 'gateways.imessage', 'gateways.whatsapp', 'automations.mail', 'automations.notes'],
    updateChannel: 'latest',
  },
  qaqash: {
    id: 'qaqash',
    name: 'Qaqaş',
    asciiName: 'Qaqash',
    features: { coding: false, bots: true, gateways: true, mail: true },
    hiddenSettings: ['hooks', 'advanced.terminal', 'tools.extensions', 'workspace', 'agent.instructions'],
    updateChannel: 'qaqash',
  },
}

const id = (typeof __EDITION__ === 'string' ? __EDITION__ : 'xari') as EditionId

export const EDITION: Edition = EDITIONS[id] ?? EDITIONS.xari
