import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { makeT, resolveLang, type Lang, type Vars } from '@harness/core/i18n'
import { CATALOGS, type MessageKey } from '../shared/i18n/catalog'

/** Main-process strings (menus, dialogs, notifications) in the app's language. */
let lang: Lang = 'en'
let t = makeT<MessageKey>('en', CATALOGS)

/** `setting` is `appearance.language`; `system` follows the OS's preferred languages. */
export function setMainLanguage(setting: string): void {
  let system: string[] = []
  try {
    system = app.getPreferredSystemLanguages()
  } catch {
    /* before ready on some platforms: fall back to the app locale */
  }
  if (system.length === 0) system = [app.getLocale()]
  const next = resolveLang(setting, system)
  if (next === lang) return
  lang = next
  t = makeT<MessageKey>(lang, CATALOGS)
}

export function mainLanguage(): Lang {
  return lang
}

export function tm(key: MessageKey, vars?: Vars): string {
  return t(key, vars)
}

const REPO_URL = 'https://github.com/Parzival-Samanyolu/xari-bulbul'

/**
 * macOS: the app menu with translated labels. Roles keep the system behaviour and shortcuts
 * (⌘Q, ⌘H, ⌘W, the Edit keys, zoom, full screen) of Electron's default menu, which this replaces.
 * Windows/Linux packaged builds have no menu (its accelerators take keys the terminal and composer
 * need); development builds keep Electron's default there.
 */
export function buildAppMenu(): void {
  if (process.platform !== 'darwin') {
    if (app.isPackaged) Menu.setApplicationMenu(null)
    return
  }
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: tm('main.menu.about') },
        sep,
        { role: 'services', label: tm('main.menu.services') },
        sep,
        { role: 'hide', label: tm('main.menu.hide') },
        { role: 'hideOthers', label: tm('main.menu.hideOthers') },
        { role: 'unhide', label: tm('main.menu.showAll') },
        sep,
        { role: 'quit', label: tm('main.menu.quit') },
      ],
    },
    {
      label: tm('main.menu.file'),
      submenu: [{ role: 'close', label: tm('main.menu.closeWindow') }],
    },
    {
      label: tm('main.menu.edit'),
      submenu: [
        { role: 'undo', label: tm('main.menu.undo') },
        { role: 'redo', label: tm('main.menu.redo') },
        sep,
        { role: 'cut', label: tm('main.menu.cut') },
        { role: 'copy', label: tm('main.menu.copy') },
        { role: 'paste', label: tm('main.menu.paste') },
        { role: 'pasteAndMatchStyle', label: tm('main.menu.pasteAndMatchStyle') },
        { role: 'delete', label: tm('main.menu.delete') },
        { role: 'selectAll', label: tm('main.menu.selectAll') },
        sep,
        {
          label: tm('main.menu.speech'),
          submenu: [
            { role: 'startSpeaking', label: tm('main.menu.startSpeaking') },
            { role: 'stopSpeaking', label: tm('main.menu.stopSpeaking') },
          ],
        },
      ],
    },
    {
      label: tm('main.menu.view'),
      submenu: [
        { role: 'reload', label: tm('main.menu.reload') },
        { role: 'forceReload', label: tm('main.menu.forceReload') },
        { role: 'toggleDevTools', label: tm('main.menu.devTools') },
        sep,
        { role: 'resetZoom', label: tm('main.menu.actualSize') },
        { role: 'zoomIn', label: tm('main.menu.zoomIn') },
        { role: 'zoomOut', label: tm('main.menu.zoomOut') },
        sep,
        { role: 'togglefullscreen', label: tm('main.menu.fullScreen') },
      ],
    },
    {
      // `window` makes it the macOS Window menu, which lists the open windows.
      role: 'window',
      label: tm('main.menu.window'),
      submenu: [
        { role: 'minimize', label: tm('main.menu.minimize') },
        { role: 'zoom', label: tm('main.menu.zoom') },
        sep,
        { role: 'front', label: tm('main.menu.front') },
      ],
    },
    {
      role: 'help',
      label: tm('main.menu.help'),
      submenu: [{ label: tm('main.menu.github'), click: () => void shell.openExternal(REPO_URL) }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
