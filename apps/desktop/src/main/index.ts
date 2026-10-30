import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, session, shell, systemPreferences, type WebContents } from 'electron'
import { IPC_EVENT, type UiEvent } from '../shared/ipc'
import { AppController, type BackgroundNotice } from './controller'
import { loadShellPath } from './shell-path'
import { initUpdater, checkForUpdates, installUpdate } from './updater'

let win: BrowserWindow | null = null
let controller: AppController

function send(e: UiEvent) {
  if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, e)
}

/** Tell the user about a chat they aren't looking at; clicking opens it. */
function notify(n: BackgroundNotice) {
  if (!controller?.getSettings().app.notifications || !Notification.isSupported()) return
  const note = new Notification({ title: n.title, body: n.body, silent: false })
  note.on('click', () => {
    if (!win || win.isDestroyed()) createWindow()
    win?.show()
    win?.focus()
    // The chat may have been deleted meanwhile.
    controller.openSession(n.sessionId).then((state) => send({ type: 'state', state }), () => {})
  })
  note.show()
}

/** Shown before the renderer paints; close to the theme's --bg so the window doesn't flash. */
function windowBackground(): string {
  const theme = controller?.getSettings().appearance.theme ?? 'system'
  if (theme === 'oled' || theme === 'contrast') return '#000000'
  if (theme === 'sepia') return '#f6efe1'
  if (theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)) return '#16171a'
  return '#ffffff'
}

/** True when `url` is the app's own page (the dev server, or the bundled index.html). */
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) return u.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    return u.protocol === 'file:' && `${u.origin}${u.pathname}` === pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
  } catch {
    return false
  }
}

const isAppPage = (wc: WebContents | null, url?: string) => !!wc && wc === win?.webContents && isAppUrl(url || wc.getURL())

/**
 * Only the app's own page gets permissions. The microphone (for voice input) is the one media
 * device it may use: requests that include the camera or screen are refused.
 */
function setPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!isAppPage(wc, details.requestingUrl)) return callback(false)
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      return callback(types.length > 0 && types.every((t) => t === 'audio'))
    }
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (!isAppPage(wc, details.requestingUrl)) return false
    if (permission === 'media') return (details as { mediaType?: string }).mediaType !== 'video'
    return true
  })
}

/** On macOS the system asks once for microphone access; elsewhere the OS doesn't gate it here. */
async function microphoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'denied' || status === 'restricted') {
    throw new Error('Microphone access is off. Turn it on for Xarı Bülbül in System Settings → Privacy & Security → Microphone.')
  }
  return systemPreferences.askForMediaAccess('microphone')
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Xarı Bülbül',
    backgroundColor: windowBackground(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })
  win.once('ready-to-show', () => win?.show())

  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

function registerIpc() {
  const c = controller
  handle('getState', () => c.state())
  handle('settings.set', (s) => c.setSettings(s))
  handle('settings.reset', () => c.resetSettings())
  handle('settings.export', async () => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: 'harness-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    fs.writeFileSync(r.filePath, JSON.stringify(c.getSettings(), null, 2))
    return true
  })
  handle('settings.import', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    return c.setSettings(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')))
  })
  handle('keys.set', (id, key) => c.setKey(id, key))
  handle('providers.test', (id) => c.testProvider(id))
  handle('models.list', (id, refresh) => c.listModels(id, refresh))
  handle('workspace.pick', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' })
    if (r.canceled || !r.filePaths[0]) return c.state()
    return c.setWorkspace(r.filePaths[0])
  })
  handle('workspace.set', (p) => c.setWorkspace(p))
  handle('workspace.close', (p) => c.closeWorkspace(p))
  handle('workspace.reorder', (p) => c.reorderWorkspaces(p))
  handle('sessions.open', (id) => c.openSession(id))
  handle('sessions.create', (cwd) => c.createSession(cwd))
  handle('sessions.remove', (id) => c.removeSession(id))
  handle('sessions.removeAll', () => c.removeAllSessions())
  // Fire and forget: progress arrives as events; the promise resolves when the turn ends.
  handle('agent.send', (text, attachments) => c.sendMessage(text, attachments))
  handle('files.pick', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], title: 'Attach files', defaultPath: c.state().workspace ?? undefined })
    if (r.canceled) return []
    return r.filePaths.map((p) => ({ name: path.basename(p), path: p, size: fs.statSync(p).size }))
  })
  handle('agent.stop', () => c.stop())
  handle('agent.setModel', (ref) => c.setModel(ref))
  handle('agent.setMode', (mode) => c.setMode(mode))
  handle('agent.compact', () => c.compact())
  handle('agent.respond', (sessionId, id, answer) => c.respond(sessionId, id, answer))
  handle('agent.answer', (sessionId, id, text) => c.answer(sessionId, id, text))
  handle('agent.retry', () => c.retry())
  handle('agent.revert', (at, file) => c.revert(at, file))
  handle('agent.editMessage', (index, text, revert) => c.editMessage(index, text, revert))
  handle('fs.tree', (dir: string) => c.listDir(dir))
  handle('fs.read', (file: string) => c.readFile(file))
  handle('session.diff', (id: string) => c.sessionDiff(id))
  handle('term.open', (cwd: string, cols: number, rows: number) => c.termOpen(cwd, cols, rows))
  ipcMain.on('term.write', (e, id: string, data: string) => isAppPage(e.sender) && c.termWrite(id, data))
  ipcMain.on('term.resize', (e, id: string, cols: number, rows: number) => isAppPage(e.sender) && c.termResize(id, cols, rows))
  ipcMain.on('term.kill', (e, id: string) => isAppPage(e.sender) && c.termKill(id))
  handle('usage.exportCsv', async () => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: 'harness-usage.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (r.canceled || !r.filePath) return false
    fs.writeFileSync(r.filePath, c.usageCsv())
    return true
  })
  handle('usage.clear', () => c.clearUsage())
  handle('mcp.restart', (id) => c.restartMcp(id))
  handle('mcp.setToken', (id, token) => c.setMcpToken(id, token))
  handle('plugins.list', () => c.listPlugins())
  handle('plugins.install', (id: string, scope: 'user' | 'project') => c.installPlugin(id, scope))
  handle('plugins.remove', (id: string) => c.removePlugin(id))
  handle('plugins.setEnabled', (id: string, on: boolean) => c.setPluginEnabled(id, on))
  handle('memory.remove', (scope, fact) => c.removeMemory(scope, fact))
  handle('memory.clear', (scope) => c.clearMemory(scope))
  handle('memory.undo', (sessionId, added, removed) => c.undoMemory(sessionId, added, removed))
  handle('extensions.reload', () => c.reloadExtensions())
  handle('extensions.openDir', async (which) => {
    const dir = c.extensionDir(which)
    if (dir) await shell.openPath(dir)
  })
  handle('skills.remove', (dir: string) => c.removeSkill(dir))
  handle('schedules.runNow', (id: string) => c.runScheduleNow(id))
  handle('schedules.pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Folder for this schedule', defaultPath: c.state().workspace ?? undefined })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  handle('voice.prepare', () => microphoneAccess())
  handle('voice.transcribe', (audio: Uint8Array, mediaType: string) => c.transcribe(audio, mediaType))
  handle('voice.download', () => c.downloadWhisper())
  handle('voice.cancelDownload', () => c.cancelWhisperDownload())
  handle('voice.remove', (what: string) => c.removeWhisper(what))
  handle('app.openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })
  handle('app.openPath', async (p: string) => {
    await shell.openPath(p)
  })
  handle('app.checkForUpdates', () => checkForUpdates())
  handle('app.installUpdate', () => installUpdate())
}

app.setName('Xarı Bülbül')
// Windows attributes notifications and taskbar grouping to this id (the installer's appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.xaribulbul.app')
// One copy at a time: a second launch focuses the open window instead.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})
// Separate profile for development/testing: HARNESS_DATA_DIR=/tmp/harness pnpm dev
if (process.env.HARNESS_DATA_DIR) app.setPath('userData', path.resolve(process.env.HARNESS_DATA_DIR))

app.whenReady().then(async () => {
  loadShellPath()
  controller = new AppController(app.getPath('userData'), app.getVersion(), send, notify)
  registerIpc()
  setPermissionHandlers()
  await controller.restoreWorkspace()
  controller.startMcp()
  controller.startSchedules()
  createWindow()
  initUpdater(send, controller.getSettings().app.autoUpdate)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop MCP server processes before quitting so none are left running.
let disposed = false
app.on('before-quit', (e) => {
  if (disposed || !controller) return
  e.preventDefault()
  disposed = true
  const done = () => app.quit()
  Promise.race([controller.dispose(), new Promise((r) => setTimeout(r, 2000))]).then(done, done)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
