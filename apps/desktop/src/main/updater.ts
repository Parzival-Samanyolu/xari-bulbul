import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UiEvent } from '../shared/ipc'

const { autoUpdater } = electronUpdater

let send: (e: UiEvent) => void = () => {}

/** Auto-update from GitHub Releases (configured by `publish` in electron-builder.yml). */
export function initUpdater(sender: (e: UiEvent) => void, enabled: boolean) {
  send = sender
  if (!updatesConfigured()) return
  autoUpdater.autoDownload = true
  autoUpdater.on('checking-for-update', () => send({ type: 'update', status: { state: 'checking' } }))
  autoUpdater.on('update-not-available', () => send({ type: 'update', status: { state: 'none' } }))
  autoUpdater.on('update-available', (i) => send({ type: 'update', status: { state: 'available', version: i.version } }))
  autoUpdater.on('download-progress', (p) => send({ type: 'update', status: { state: 'downloading', percent: Math.round(p.percent) } }))
  autoUpdater.on('update-downloaded', (i) => send({ type: 'update', status: { state: 'ready', version: i.version } }))
  autoUpdater.on('error', (e) => send({ type: 'update', status: { state: 'error', message: e.message } }))
  if (enabled) autoUpdater.checkForUpdates().catch(() => {})
}

/** electron-builder writes app-update.yml only when the build knows its GitHub repo. */
function updatesConfigured(): boolean {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))
}

export async function checkForUpdates() {
  if (!updatesConfigured()) {
    send({ type: 'update', status: { state: 'error', message: app.isPackaged ? 'This build has no update source (built without a GitHub repo).' : 'Updates only work in the installed app.' } })
    return
  }
  await autoUpdater.checkForUpdates().catch((e) => send({ type: 'update', status: { state: 'error', message: e.message } }))
}

export function installUpdate() {
  if (updatesConfigured()) autoUpdater.quitAndInstall()
}
