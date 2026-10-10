import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UiEvent, UpdateStatus } from '../shared/ipc'

const { autoUpdater } = electronUpdater

let send: (e: UiEvent) => void = () => {}

/** Auto-update from GitHub Releases (configured by `publish` in electron-builder.yml). */
export function initUpdater(sender: (e: UiEvent) => void, enabled: boolean) {
  send = sender
  if (!updatesConfigured()) return
  const manual = !canInstallUpdates()
  autoUpdater.autoDownload = !manual
  let latest = ''
  autoUpdater.on('checking-for-update', () => send({ type: 'update', status: { state: 'checking' } }))
  autoUpdater.on('update-not-available', () => send({ type: 'update', status: { state: 'none' } }))
  autoUpdater.on('update-available', (i) => {
    latest = i.version
    send({ type: 'update', status: manual ? manualStatus(i.version) : { state: 'available', version: i.version } })
  })
  autoUpdater.on('download-progress', (p) => send({ type: 'update', status: { state: 'downloading', percent: Math.round(p.percent) } }))
  autoUpdater.on('update-downloaded', (i) => send({ type: 'update', status: { state: 'ready', version: i.version } }))
  autoUpdater.on('error', (e) => {
    // macOS refuses an update signed by a different identity ("code failed to satisfy specified code requirement(s)").
    const signing = /code requirement|signature|codesign/i.test(e.message)
    send({ type: 'update', status: signing && latest ? manualStatus(latest) : { state: 'error', message: e.message } })
  })
  if (enabled) autoUpdater.checkForUpdates().catch(() => {})
}

/**
 * macOS installs an update only if it's signed by the same identity as the running app.
 * An ad-hoc signature is tied to one build, so ad-hoc builds can only point at the download.
 */
function canInstallUpdates(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    const appPath = path.resolve(process.execPath, '../../..')
    const out = execFileSync('/usr/bin/codesign', ['-d', '-r-', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.includes('designated =>') && !/designated => cdhash/.test(out)
  } catch {
    return false // unsigned
  }
}

function manualStatus(version: string): UpdateStatus {
  const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
  const owner = /owner:\s*(\S+)/.exec(yml)?.[1]
  const repo = /repo:\s*(\S+)/.exec(yml)?.[1]
  const url = owner && repo ? `https://github.com/${owner}/${repo}/releases/tag/v${version}` : 'https://github.com'
  return { state: 'manual', version, url }
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
