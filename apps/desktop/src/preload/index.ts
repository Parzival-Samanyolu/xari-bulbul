import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_EVENT, type HarnessApi, type UiEvent } from '../shared/ipc'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

// Every method maps to an `ipcMain.handle(channel)` in main/ipc.ts. Nothing else from
// Node or Electron is exposed to the page.
const api: HarnessApi = {
  getState: call('getState') as HarnessApi['getState'],
  settings: {
    set: call('settings.set') as any,
    reset: call('settings.reset') as any,
    export: call('settings.export') as any,
    import: call('settings.import') as any,
  },
  keys: { set: call('keys.set') as any },
  providers: { test: call('providers.test') as any, probe: call('providers.probe') as any },
  browser: { clearLogins: call('browser.clearLogins') as any },
  models: { list: call('models.list') as any },
  workspace: { pick: call('workspace.pick') as any, set: call('workspace.set') as any, close: call('workspace.close') as any, reorder: call('workspace.reorder') as any },
  sessions: {
    open: call('sessions.open') as any,
    create: call('sessions.create') as any,
    remove: call('sessions.remove') as any,
    removeAll: call('sessions.removeAll') as any,
  },
  agent: {
    send: call('agent.send') as any,
    stop: call('agent.stop') as any,
    setModel: call('agent.setModel') as any,
    setMode: call('agent.setMode') as any,
    setMoa: call('agent.setMoa') as any,
    compact: call('agent.compact') as any,
    respond: call('agent.respond') as any,
    answer: call('agent.answer') as any,
    retry: call('agent.retry') as any,
    revert: call('agent.revert') as any,
    editMessage: call('agent.editMessage') as any,
  },
  fs: { tree: call('fs.tree') as any, read: call('fs.read') as any },
  session: { diff: call('session.diff') as any },
  // Keystrokes and resizes are fire-and-forget; only open waits for an answer.
  term: {
    open: call('term.open') as any,
    write: (id, data) => ipcRenderer.send('term.write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term.resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('term.kill', id),
  },
  files: { pick: call('files.pick') as any, pathFor: (file: File) => webUtils.getPathForFile(file) },
  usage: { exportCsv: call('usage.exportCsv') as any, clear: call('usage.clear') as any },
  mcp: { restart: call('mcp.restart') as any, setToken: call('mcp.setToken') as any },
  plugins: { list: call('plugins.list') as any, install: call('plugins.install') as any, remove: call('plugins.remove') as any, setEnabled: call('plugins.setEnabled') as any },
  memory: { remove: call('memory.remove') as any, clear: call('memory.clear') as any, undo: call('memory.undo') as any },
  extensions: { reload: call('extensions.reload') as any, openDir: call('extensions.openDir') as any },
  skills: { remove: call('skills.remove') as any },
  schedules: { runNow: call('schedules.runNow') as any, pickFolder: call('schedules.pickFolder') as any },
  imessage: { test: call('imessage.test') as any, check: call('imessage.check') as any, openPrivacy: call('imessage.openPrivacy') as any, pickFolder: call('imessage.pickFolder') as any },
  bots: { pickAvatar: call('bots.pickAvatar') as any, pickFolder: call('bots.pickFolder') as any, open: call('bots.open') as any, newThread: call('bots.newThread') as any },
  voice: {
    prepare: call('voice.prepare') as any,
    transcribe: call('voice.transcribe') as any,
    download: call('voice.download') as any,
    cancelDownload: call('voice.cancelDownload') as any,
    remove: call('voice.remove') as any,
  },
  tts: { synthesize: call('tts.synthesize') as any },
  local: {
    status: call('local.status') as any,
    installRuntime: call('local.installRuntime') as any,
    removeRuntime: call('local.removeRuntime') as any,
    download: call('local.download') as any,
    downloadHf: call('local.downloadHf') as any,
    cancelDownload: call('local.cancelDownload') as any,
    remove: call('local.remove') as any,
    search: call('local.search') as any,
    addFile: call('local.addFile') as any,
    use: call('local.use') as any,
    stop: call('local.stop') as any,
  },
  app: {
    track: call('app.track') as any,
    reportError: call('app.reportError') as any,
    openExternal: call('app.openExternal') as any,
    openPath: call('app.openPath') as any,
    checkForUpdates: call('app.checkForUpdates') as any,
    installUpdate: call('app.installUpdate') as any,
  },
  onEvent(cb) {
    const listener = (_: unknown, e: UiEvent) => cb(e)
    ipcRenderer.on(IPC_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC_EVENT, listener)
  },
}

contextBridge.exposeInMainWorld('harness', api)
