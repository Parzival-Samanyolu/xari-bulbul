// electron-builder afterPack hook (runs before signing). node-pty's `spawn-helper` (macOS/Linux)
// is published without the execute bit, and without it every terminal fails with
// "posix_spawnp failed". Set it on the unpacked copy inside the app.
const fs = require('node:fs')
const path = require('node:path')

function walk(dir, found) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, found)
    else if (e.name === 'spawn-helper') found.push(p)
  }
  return found
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const pty = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  if (!fs.existsSync(pty)) throw new Error(`node-pty is missing from the packaged app (${pty})`)
  for (const helper of walk(pty, [])) {
    fs.chmodSync(helper, 0o755)
    console.log(`  • made ${path.relative(resources, helper)} executable`)
  }
}
