// The desktop app's identity. Main, preload and renderer all read it from here.

export interface Edition {
  id: 'xari'
  /** Shown in windows, menus and notifications. Display only: the data folder is `dataDirName`. */
  name: string
  /** Folder under appData that holds settings and chats. Never rename it: existing users would lose their data. */
  dataDirName: string
  /** For places that must be ASCII (sign-in app names, file names). */
  asciiName: string
  /** What the app turns on. */
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
  /** Settings tabs and sections left out (ids from settings/tree.tsx). */
  hiddenSettings: string[]
  /** The auto-update feed. */
  updateChannel: string
}

export const EDITION: Edition = {
  id: 'xari',
  name: 'Xarı',
  dataDirName: 'Xarı Bülbül', // the app's former name
  asciiName: 'Xari Bulbul',
  features: { coding: true, bots: true, gateways: true, mail: true },
  hiddenSettings: [],
  updateChannel: 'latest',
}
