/**
 * Downloads whisper.cpp (BLAS CPU build) into resources/whisper so FlowClip can
 * transcribe locally without a Python runtime.
 *
 * The speech model is NOT fetched here — it is downloaded on first use so the
 * installer stays small. See src/main/whisper.ts.
 *
 *   npm run setup:whisper
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { execFileSync } from 'child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'whisper')
const tmpZip = join(root, 'resources', 'whisper-tmp.zip')

const VERSION = 'v1.9.1'
const URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-blas-bin-x64.zip`

async function main() {
  if (process.platform !== 'win32') {
    console.log('Non-Windows platform: build whisper.cpp yourself and put it in resources/whisper.')
    return
  }

  mkdirSync(outDir, { recursive: true })
  if (readdirSync(outDir).some((f) => f.toLowerCase().endsWith('.exe'))) {
    console.log('whisper.cpp already present in resources/whisper — nothing to do.')
    return
  }

  console.log(`Downloading whisper.cpp ${VERSION}…\n  ${URL}`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(tmpZip))

  console.log('Extracting…')
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${outDir}' -Force`
  ])
  rmSync(tmpZip, { force: true })

  // The archive nests everything under Release/; flatten so lookups are simple.
  const nested = join(outDir, 'Release')
  if (existsSync(nested)) {
    for (const f of readdirSync(nested)) {
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Move-Item -LiteralPath '${join(nested, f)}' -Destination '${join(outDir, f)}' -Force`
      ])
    }
    rmSync(nested, { recursive: true, force: true })
  }

  prune()

  const files = readdirSync(outDir)
  const total = files.reduce((n, f) => n + statSync(join(outDir, f)).size, 0)
  console.log(`\nDone — ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB`)
}

/**
 * The archive ships ~39 files: server, streaming, VAD and test binaries we never
 * invoke, plus OpenBLAS. Measured on this workload, BLAS made no difference
 * (1.60s vs 1.63s on an 11s clip) because the ggml-cpu SIMD kernels already
 * carry it — and libopenblas.dll alone is 49 MB. Keeping only what
 * `whisper-cli` actually loads takes the payload from 68 MB to under 10 MB.
 */
function prune() {
  const files = readdirSync(outDir)
  const keep = new Set([
    'whisper-cli.exe',
    'whisper.dll',
    'ggml.dll',
    'ggml-base.dll',
    // Runtime-dispatched per CPU generation; ship them all so the build is
    // portable across machines.
    ...files.filter((f) => /^ggml-cpu-.*\.dll$/i.test(f))
  ])

  let removed = 0
  for (const f of files) {
    if (!keep.has(f)) {
      rmSync(join(outDir, f), { force: true })
      removed++
    }
  }
  console.log(`  pruned ${removed} unused files`)
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message)
  process.exitCode = 1
})
