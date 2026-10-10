// electron-builder afterSign hook. Release builds re-sign the macOS app with the project's
// self-signed certificate, so every version has the same signing identity and the
// auto-updater (Squirrel.Mac) accepts the next one. Ad-hoc signatures differ per build.
// CI sets XB_SIGN_IDENTITY / XB_SIGN_KEYCHAIN; local builds stay ad-hoc.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function selfSign(context) {
  const identity = process.env.XB_SIGN_IDENTITY
  if (context.electronPlatformName !== 'darwin' || !identity) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const keychain = process.env.XB_SIGN_KEYCHAIN ? ['--keychain', process.env.XB_SIGN_KEYCHAIN] : []
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, ...keychain, app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • self-signed ${path.basename(app)} in ${path.basename(context.appOutDir)}`)
}
