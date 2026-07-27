/**
 * Local speech-to-text via whisper.cpp.
 *
 * The binary is bundled (~9 MB) but the model is not — models run from 142 MB
 * to well over a gigabyte, so the first transcription downloads the one the user
 * picked into their app data folder and reuses it afterwards.
 */
import { spawn, execFile } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { app } from 'electron'
import { toolStatus } from './ffmpeg'
import type { CaptionWord, WhisperModelId, ModelProgress } from '../shared/types'
import { WHISPER_MODELS } from '../shared/types'

function whisperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

export function whisperPath(): string | null {
  const exe = join(whisperDir(), 'whisper-cli.exe')
  return existsSync(exe) ? exe : null
}

function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function modelPath(id: WhisperModelId): string {
  return join(modelsDir(), WHISPER_MODELS[id].file)
}

export function isModelReady(id: WhisperModelId): boolean {
  const p = modelPath(id)
  // A part-finished download would be smaller than the real file; treat anything
  // suspiciously small as missing rather than handing ffmpeg a broken model.
  return existsSync(p) && statSync(p).size > 1_000_000
}

export async function downloadModel(
  id: WhisperModelId,
  onProgress: (p: ModelProgress) => void
): Promise<string> {
  const target = modelPath(id)
  if (isModelReady(id)) return target

  const meta = WHISPER_MODELS[id]
  const tmp = `${target}.part`
  rmSync(tmp, { force: true })

  const res = await fetch(meta.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])

  // Count bytes with a pass-through rather than a 'data' listener: attaching one
  // puts the stream into flowing mode before pipeline() hooks up the writer, and
  // the chunks emitted in between are lost — producing a file of roughly the
  // right size that whisper then refuses to load.
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      onProgress({ received, total, percent: total ? received / total : 0 })
      cb(null, chunk)
    }
  })

  await pipeline(body, counter, createWriteStream(tmp))

  if (total > 0 && received !== total) {
    rmSync(tmp, { force: true })
    throw new Error(`Model download truncated: got ${received} of ${total} bytes`)
  }

  // Rename only once complete, so an interrupted download never looks ready.
  const { renameSync } = await import('fs')
  renameSync(tmp, target)
  return target
}

/**
 * whisper.cpp only accepts 16 kHz mono PCM, so the clip's audio is extracted and
 * resampled first. Only the trimmed range is pulled — no point transcribing
 * audio the export will discard.
 */
async function extractAudio(inputPath: string, startSec: number, endSec: number): Promise<string> {
  const { ffmpegPath } = toolStatus()
  if (!ffmpegPath) throw new Error('ffmpeg not found')

  const dir = join(app.getPath('temp'), 'flowclip-audio')
  mkdirSync(dir, { recursive: true })
  const key = createHash('sha1')
    .update(`${inputPath}:${startSec}:${endSec}`)
    .digest('hex')
    .slice(0, 16)
  const out = join(dir, `${key}.wav`)
  if (existsSync(out)) return out

  const duration = Math.max(0.1, endSec - startSec)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', startSec.toFixed(3),
    '-i', inputPath,
    '-t', duration.toFixed(3),
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    out
  ]

  await new Promise<void>((resolve, reject) => {
    execFile(ffmpegPath, args, (err, _o, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve()
    })
  })
  return out
}

interface WhisperJson {
  transcription?: {
    text: string
    offsets: { from: number; to: number }
  }[]
}

/**
 * Transcribes the trimmed range and returns one entry per word.
 *
 * `-ml 1` forces whisper to break at every token, which is what yields
 * word-level timings rather than whole-sentence blocks — the difference between
 * a subtitle and a caption that pops word by word.
 */
export async function transcribe(
  inputPath: string,
  startSec: number,
  endSec: number,
  modelId: WhisperModelId,
  onStage: (stage: string) => void
): Promise<CaptionWord[]> {
  const exe = whisperPath()
  if (!exe) throw new Error('whisper.cpp not found — run npm run setup:whisper')
  if (!isModelReady(modelId)) throw new Error('Speech model not downloaded yet')

  onStage('Extracting audio')
  const wav = await extractAudio(inputPath, startSec, endSec)

  onStage('Transcribing')
  const outBase = wav.replace(/\.wav$/, '')
  const args = [
    '-m', modelPath(modelId),
    '-f', wav,
    '-ml', '1',
    '-oj',
    '-of', outBase,
    '--no-prints'
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(exe, args)
    let tail = ''
    proc.stderr.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-3000)
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(tail.trim() || `whisper exited ${code}`))
    )
  })

  const jsonPath = `${outBase}.json`
  if (!existsSync(jsonPath)) throw new Error('whisper produced no output')
  const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson

  return (data.transcription ?? [])
    .map((seg) => ({
      text: seg.text.trim(),
      // Offsets are relative to the extracted clip; shift onto the source
      // timeline so captions line up with the trim the user actually set.
      start: seg.offsets.from / 1000 + startSec,
      end: seg.offsets.to / 1000 + startSec
    }))
    // Whisper emits empty leaders and bare punctuation; neither is a caption.
    .filter((w) => w.text.length > 0 && /[\p{L}\p{N}]/u.test(w.text))
}
