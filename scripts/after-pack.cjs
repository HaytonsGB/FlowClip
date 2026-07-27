/**
 * Stamps the icon and version metadata into FlowClip.exe after packing.
 *
 * electron-builder normally does this itself, but on Windows that path pulls
 * down the winCodeSign toolchain, whose archive contains macOS symlinks that
 * cannot be extracted without Developer Mode or elevation. Signing stays off;
 * we just drive rcedit — the same tool electron-builder would have used —
 * directly, which needs no toolchain download.
 *
 * Runs before NSIS packages the directory, so the installer, Start menu entry
 * and desktop shortcut all inherit the icon.
 */
const { execFileSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const root = join(__dirname, '..')
  const exe = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const icon = join(root, 'build', 'icon.ico')
  const rcedit = join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')

  for (const [label, path] of [
    ['executable', exe],
    ['icon', icon],
    ['rcedit', rcedit]
  ]) {
    if (!existsSync(path)) {
      console.warn(`  • afterPack: ${label} not found at ${path} — skipping icon stamp`)
      return
    }
  }

  const version = context.packager.appInfo.version

  execFileSync(rcedit, [
    exe,
    '--set-icon', icon,
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', 'FlowClip',
    '--set-version-string', 'FileDescription', 'FlowClip — local viral-clip editor',
    '--set-version-string', 'CompanyName', 'HaytonsGB',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026 HaytonsGB',
    '--set-version-string', 'OriginalFilename', 'FlowClip.exe'
  ])

  console.log(`  • afterPack: stamped icon and v${version} into ${exe}`)
}
