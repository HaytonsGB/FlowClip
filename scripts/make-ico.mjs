/**
 * Builds a multi-size Windows .ico from resources/logo.png.
 *
 * Written by hand rather than via an image library because generated ICOs are
 * routinely rejected by Explorer when the directory entries are subtly wrong.
 * The container is simple: a header, one 16-byte entry per size, then the PNG
 * payloads, which Vista and later accept directly.
 *
 *   node scripts/make-ico.mjs [outputPath]
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'resources', 'logo.png')
const ffmpeg = join(root, 'resources', 'bin', 'ffmpeg.exe')
const outPath = process.argv[2] ?? join(root, 'build', 'icon.ico')
const tmp = join(root, 'build', 'ico-tmp')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

function main() {
  if (!existsSync(source)) throw new Error(`missing ${source}`)
  if (!existsSync(ffmpeg)) throw new Error('ffmpeg not found — run npm run setup:ffmpeg')

  mkdirSync(tmp, { recursive: true })
  mkdirSync(dirname(outPath), { recursive: true })

  const images = SIZES.map((size) => {
    const png = join(tmp, `${size}.png`)
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-vf', `scale=${size}:${size}:flags=lanczos`,
      png
    ])
    return { size, data: readFileSync(png) }
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  // Offsets follow the header and the full directory.
  let offset = 6 + images.length * 16

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16)
    // 256 is stored as 0; the field is a single byte.
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette size
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }

  writeFileSync(
    outPath,
    Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
  )
  rmSync(tmp, { recursive: true, force: true })

  console.log(`wrote ${outPath}`)
  console.log(`  sizes: ${SIZES.join(', ')}`)
}

main()
