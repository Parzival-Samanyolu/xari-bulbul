import os from 'node:os'
import path from 'node:path'
import { findBinary, versionedDirs } from './exec.mjs'

export const MISSING =
  'Install Blender from blender.org, put `blender` on PATH, or set BLENDER_PATH to the Blender program and restart the app.'

/** The Blender program: BLENDER_PATH, `blender` on PATH, then the usual install places. */
export function findBlender() {
  const candidates = []
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender', '~/Applications/Blender.app/Contents/MacOS/Blender')
  } else if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      // `Blender Foundation\Blender 4.2\blender.exe`; the newest version wins.
      for (const dir of versionedDirs(path.join(root, 'Blender Foundation'), 'Blender').reverse()) candidates.push(path.join(dir, 'blender.exe'))
    }
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender', '~/.local/share/flatpak/exports/bin/org.blender.Blender')
  }
  return findBinary('blender', candidates.map((c) => c.replace(/^~/, os.homedir())), 'BLENDER_PATH')
}

/** An absolute .blend path, or an error message. */
export function blendPath(file, cwd) {
  if (file == null || file === '') return { path: null }
  if (typeof file !== 'string') return { error: '`file` must be a path to a .blend file.' }
  const abs = path.resolve(cwd, file.replace(/^~(?=$|[\\/])/, os.homedir()))
  if (!/\.blend\d*$/i.test(abs)) return { error: `Not a .blend file: ${abs}` }
  return { path: abs }
}
