// Which app this build is. One codebase, two apps: set XARI_EDITION=qaqash when building Qaqaş.
// Main, preload and renderer all get the same value from electron.vite.config.ts (`__EDITION__`).

declare const __EDITION__: string

export type EditionId = 'xari' | 'qaqash'

export interface Edition {
  id: EditionId
  /** Shown in windows, menus and notifications. Display only: the data folder is `dataDirName`. */
  name: string
  /** Folder under appData that holds this edition's settings and chats. Never rename it: existing users would lose their data. */
  dataDirName: string
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
  /** The auto-update feed: `latest` for Xarı, its own for Qaqaş, so one release can carry both. */
  updateChannel: string
}

const EDITIONS: Record<EditionId, Edition> = {
  xari: {
    id: 'xari',
    name: 'Xarı',
    dataDirName: 'Xarı Bülbül', // the app's former name
    asciiName: 'Xari Bulbul',
    features: { coding: true, bots: false, gateways: false, mail: false },
    hiddenSettings: ['bots', 'gateways.imessage', 'gateways.whatsapp', 'automations.mail', 'automations.notes'],
    updateChannel: 'latest',
  },
  qaqash: {
    id: 'qaqash',
    name: 'Qaqaş',
    dataDirName: 'Qaqaş',
    asciiName: 'Qaqash',
    features: { coding: false, bots: true, gateways: true, mail: true },
    hiddenSettings: ['hooks', 'advanced.terminal', 'tools.extensions', 'workspace', 'agent.instructions'],
    updateChannel: 'qaqash',
  },
}

const id = (typeof __EDITION__ === 'string' ? __EDITION__ : 'xari') as EditionId

/** The folder an edition keeps its data in, for code that reads another edition's folder. */
export const dataDirNameOf = (e: EditionId): string => EDITIONS[e].dataDirName

export const EDITION: Edition = EDITIONS[id] ?? EDITIONS.xari
