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
  providers: { test: call('providers.test') as any },
  models: { list: call('models.list') as any },
  workspace: { pick: call('workspace.pick') as any, set: call('workspace.set') as any },
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
    compact: call('agent.compact') as any,
    respond: call('agent.respond') as any,
  },
  files: { pick: call('files.pick') as any, pathFor: (file: File) => webUtils.getPathForFile(file) },
  usage: { exportCsv: call('usage.exportCsv') as any, clear: call('usage.clear') as any },
  extensions: { reload: call('extensions.reload') as any, openDir: call('extensions.openDir') as any },
  app: {
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
