/**
 * Downloads a static ffmpeg/ffprobe build into resources/bin so FlowClip works
 * without the user installing anything. Windows-only for now; on other
 * platforms it just tells you to install ffmpeg yourself.
 *
 *   npm run setup:ffmpeg
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { execFileSync } from 'child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'resources', 'bin')
const tmpZip = join(root, 'resources', 'ffmpeg-tmp.zip')
const tmpDir = join(root, 'resources', 'ffmpeg-tmp')

// BtbN's essentials build — small, static, no external DLLs needed.
const URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

async function main() {
  if (process.platform !== 'win32') {
    console.log('Non-Windows platform: please install ffmpeg via your package manager.')
    return
  }

  mkdirSync(binDir, { recursive: true })
  if (existsSync(join(binDir, 'ffmpeg.exe')) && existsSync(join(binDir, 'ffprobe.exe'))) {
    console.log('ffmpeg and ffprobe already present in resources/bin — nothing to do.')
    return
  }

  console.log(`Downloading ffmpeg…\n  ${URL}`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(tmpZip))

  console.log('Extracting…')
  rmSync(tmpDir, { recursive: true, force: true })
  // Expand-Archive ships with Windows; avoids adding an unzip dependency.
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${tmpDir}' -Force`
  ])

  // The zip nests everything under a versioned folder; find the real bin dir.
  const inner = readdirSync(tmpDir).map((d) => join(tmpDir, d, 'bin'))
  const src = inner.find((p) => existsSync(join(p, 'ffmpeg.exe')))
  if (!src) throw new Error('Could not find ffmpeg.exe inside the archive')

  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    renameSync(join(src, exe), join(binDir, exe))
    console.log(`  installed ${exe}`)
  }

  rmSync(tmpZip, { force: true })
  rmSync(tmpDir, { recursive: true, force: true })
  console.log('\nDone — ffmpeg is ready in resources/bin.')
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message)
  process.exitCode = 1
})
