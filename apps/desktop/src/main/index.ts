import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron'
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Xarı Bülbül',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171a' : '#ffffff',
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
  handle('usage.exportCsv', async () => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: 'harness-usage.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (r.canceled || !r.filePath) return false
    fs.writeFileSync(r.filePath, c.usageCsv())
    return true
  })
  handle('usage.clear', () => c.clearUsage())
  handle('mcp.restart', (id) => c.restartMcp(id))
  handle('mcp.setToken', (id, token) => c.setMcpToken(id, token))
  handle('memory.remove', (scope, fact) => c.removeMemory(scope, fact))
  handle('memory.clear', (scope) => c.clearMemory(scope))
  handle('extensions.reload', () => c.reloadExtensions())
  handle('extensions.openDir', async (which) => {
    const dir = c.extensionDir(which)
    if (dir) await shell.openPath(dir)
  })
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
// Separate profile for development/testing: HARNESS_DATA_DIR=/tmp/harness pnpm dev
if (process.env.HARNESS_DATA_DIR) app.setPath('userData', path.resolve(process.env.HARNESS_DATA_DIR))

app.whenReady().then(async () => {
  loadShellPath()
  controller = new AppController(app.getPath('userData'), app.getVersion(), send, notify)
  registerIpc()
  await controller.restoreWorkspace()
  controller.startMcp()
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
