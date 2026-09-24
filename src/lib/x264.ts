import { FFmpeg, type FFFSType } from '@ffmpeg/ffmpeg'
import {
  BlobSource,
  BufferSource,
  BufferTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  WEBM,
} from 'mediabunny'
import { outputSize, type Preset, type Probe, type Settings } from './shared'

type EncodingPreset = Exclude<Preset, 'copy'>

/** x264 constant-rate factors. 18 is the conventional "visually lossless" point. */
export const CRF: Record<EncodingPreset, number> = {
  'visually-lossless': 18,
  high: 22,
  compact: 26,
}

const X264_PRESET = 'veryfast'
const INPUT_DIR = '/in'
// Audio codecs an MP4 can carry as-is; anything else is re-encoded to AAC.
const COPYABLE_AUDIO = ['aac', 'mp3', 'opus', 'ac3', 'eac3']

export type Progress = { fraction: number; processed: number; elapsed: number }
export type Job = { promise: Promise<Blob>; cancel: () => void }

class Canceled extends Error {
  name = 'AbortError'
}

/** One single-threaded encoder per spare core, fewer when frames are big or memory is tight. */
export function workerCount(probe: Probe) {
  const cores = navigator.hardwareConcurrency || 4
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const perWorkerMB = probe.width * probe.height > 2.5e6 ? 700 : 300
  const byMemory = Math.floor((memoryGB * 1024 * 0.5) / perWorkerMB)
  return Math.max(1, Math.min(cores - 1, 8, byMemory))
}

async function fetchBlob(url: URL, type: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return new Blob([await response.arrayBuffer()], { type })
    } catch (err) {
      if (attempt === 3) throw new Error(`Couldn't download the x264 encoder (${err instanceof Error ? err.message : err}).`)
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}

let core: Promise<{ coreURL: string; wasmURL: string }> | null = null

/**
 * Downloads the ffmpeg core once and hands every worker an in-memory copy. Letting each worker fetch the 32 MB
 * binary itself makes Chrome fail some of the parallel requests with ERR_CACHE_WRITE_FAILURE.
 */
export function loadCore() {
  core ??= (async () => {
    const base = new URL('/ffmpeg/', location.href)
    const [js, wasm] = await Promise.all([
      fetchBlob(new URL('ffmpeg-core.js', base), 'text/javascript'),
      fetchBlob(new URL('ffmpeg-core.wasm', base), 'application/wasm'),
    ])
    return { coreURL: URL.createObjectURL(js), wasmURL: URL.createObjectURL(wasm) }
  })().catch((err) => {
    core = null
    throw err
  })
  return core
}

async function spawn(file: File) {
  const urls = await loadCore()
  const ff = new FFmpeg()
  await ff.load(urls)
  await ff.createDir(INPUT_DIR)
  await ff.mount('WORKERFS' as FFFSType, { files: [file] }, INPUT_DIR)
  return ff
}

/** Presentation timestamps of every video frame, in order. */
async function frameTimes(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA] })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('Missing video track.')
    const times: number[] = []
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      times.push(packet.timestamp)
    }
    return times.sort((a, b) => a - b)
  } finally {
    input.dispose()
  }
}

type Chunk = {
  index: number
  start: number | null
  end: number | null
  /** Source timestamp of the chunk's first frame, and how many frames it holds. */
  firstFrame: number
  frames: number
}

/** Splits the timeline halfway between frames so every frame lands in exactly one chunk. */
function planChunks(times: number[], count: number): Chunk[] {
  const n = Math.max(1, Math.min(count, Math.floor(times.length / 30)))
  const firsts = Array.from({ length: n }, (_, k) => Math.round((k * times.length) / n))
  return firsts.map((first, index) => {
    const next = firsts[index + 1] ?? times.length
    return {
      index,
      start: index === 0 ? null : (times[first - 1] + times[first]) / 2,
      end: index === n - 1 ? null : (times[next - 1] + times[next]) / 2,
      firstFrame: times[first],
      frames: next - first,
    }
  })
}

/**
 * Joins the encoded chunks into one video track, placing every frame at its exact source timestamp. (ffmpeg's concat
 * demuxer leaves a one-frame gap at each seam.)
 */
async function stitch(chunks: Chunk[], parts: Uint8Array[]) {
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })
  const track = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(track)
  await output.start()
  let sequence = 0
  for (const chunk of chunks) {
    const input = new Input({ source: new BufferSource(parts[chunk.index]), formats: [MP4] })
    try {
      const video = await input.getPrimaryVideoTrack()
      if (!video) throw new Error('An encoded chunk has no video.')
      const decoderConfig = (await video.getDecoderConfig()) ?? undefined
      const packets = []
      for await (const packet of new EncodedPacketSink(video).packets()) packets.push(packet)
      if (packets.length !== chunk.frames) {
        throw new Error(`Chunk ${chunk.index + 1} came back with ${packets.length} frames instead of ${chunk.frames}.`)
      }
      const offset = chunk.firstFrame - Math.min(...packets.map((p) => p.timestamp))
      for (const packet of packets) {
        const meta = sequence === 0 ? { decoderConfig } : undefined
        await track.add(packet.clone({ timestamp: packet.timestamp + offset, sequenceNumber: sequence++ }), meta)
      }
    } finally {
      input.dispose()
    }
  }
  await output.finalize()
  return new Uint8Array(target.buffer!)
}

function encodeArgs(probe: Probe, settings: Settings, chunk: Chunk, out: string) {
  const { width, height } = outputSize(probe, settings.shortSide)
  const scaled = width !== probe.width || height !== probe.height
  const preset = settings.preset === 'copy' ? 'visually-lossless' : settings.preset
  return [
    ...(chunk.start !== null ? ['-ss', chunk.start.toFixed(6)] : []),
    ...(chunk.end !== null ? ['-t', (chunk.end - (chunk.start ?? 0)).toFixed(6)] : []),
    '-i', `${INPUT_DIR}/${probe.file.name}`,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    ...(scaled ? ['-vf', `scale=${width}:${height}:flags=lanczos`] : []),
    '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', String(CRF[preset]), '-pix_fmt', 'yuv420p',
    '-vsync', 'passthrough',
    out,
  ]
}

function muxArgs(probe: Probe, settings: Settings) {
  const audio = settings.keepAudio && probe.audio
  const copyAudio = audio && probe.audio?.codec && COPYABLE_AUDIO.includes(probe.audio.codec)
  return [
    '-i', 'video.mp4',
    '-i', `${INPUT_DIR}/${probe.file.name}`,
    '-map', '0:v:0',
    ...(audio ? ['-map', '1:a:0?', ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])] : ['-an']),
    '-c:v', 'copy', '-map_metadata', '1', '-movflags', '+faststart',
    'out.mp4',
  ]
}

async function run(ff: FFmpeg, args: string[], signal: AbortSignal) {
  if (signal.aborted) throw new Canceled()
  const code = await ff.exec(args)
  if (signal.aborted) throw new Canceled()
  if (code !== 0) throw new Error(`The encoder stopped with code ${code}.`)
}

/** Encodes the video in parallel chunks with x264, then stitches them together without re-encoding. */
export function encode(probe: Probe, settings: Settings, onProgress: (p: Progress) => void): Job {
  const controller = new AbortController()
  const pool: FFmpeg[] = []
  const cancel = () => {
    controller.abort()
    for (const ff of pool) ff.terminate()
  }

  const promise = (async () => {
    try {
      const workers = workerCount(probe)
      const times = await frameTimes(probe.file)
      // Aim for a few chunks per worker so fast workers can pick up the slack at the end.
      const target = Math.min(20, Math.max(1.5, probe.duration / (workers * 3)))
      const chunks = planChunks(times, Math.ceil(probe.duration / target))
      const done = new Array<number>(chunks.length).fill(0)
      const lengths = chunks.map((c) => (c.end ?? probe.firstTimestamp + probe.duration) - (c.start ?? probe.firstTimestamp))
      const outputs = new Array<Uint8Array>(chunks.length)
      const started = performance.now()
      const report = () => {
        const processed = done.reduce((s, x) => s + x, 0)
        onProgress({ fraction: Math.min(0.99, processed / probe.duration), processed, elapsed: (performance.now() - started) / 1000 })
      }

      const queue = [...chunks]
      await Promise.all(
        Array.from({ length: Math.min(workers, chunks.length) }, async () => {
          const ff = await spawn(probe.file)
          pool.push(ff)
          if (controller.signal.aborted) throw new Canceled()
          let current = -1
          ff.on('progress', ({ time }) => {
            if (current < 0) return
            done[current] = Math.min(lengths[current], Math.max(0, time / 1e6))
            report()
          })
          for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
            current = chunk.index
            const name = `part${chunk.index}.mp4`
            await run(ff, encodeArgs(probe, settings, chunk, name), controller.signal)
            outputs[chunk.index] = (await ff.readFile(name)) as Uint8Array
            await ff.deleteFile(name)
            done[chunk.index] = lengths[chunk.index]
            report()
          }
          current = -1
        }),
      )

      const muxer = pool[0]
      await muxer.writeFile('video.mp4', await stitch(chunks, outputs))
      await run(muxer, muxArgs(probe, settings), controller.signal)
      const result = (await muxer.readFile('out.mp4')) as Uint8Array<ArrayBuffer>
      onProgress({ fraction: 1, processed: probe.duration, elapsed: (performance.now() - started) / 1000 })
      return new Blob([result], { type: 'video/mp4' })
    } finally {
      for (const ff of pool) ff.terminate()
    }
  })()

  return { promise, cancel }
}

/** Encodes a few short clips at the chosen CRF and extrapolates the finished size. */
export async function estimate(probe: Probe, settings: Settings, signal: AbortSignal) {
  const count = Math.min(workerCount(probe), probe.duration >= 20 ? 3 : probe.duration >= 6 ? 2 : 1)
  const length = Math.min(1.5, probe.duration / count)
  const pool: FFmpeg[] = []
  const stop = () => pool.forEach((ff) => ff.terminate())
  signal.addEventListener('abort', stop)
  try {
    const sizes = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const ff = await spawn(probe.file)
        pool.push(ff)
        const start = probe.firstTimestamp + Math.max(0, ((i + 0.5) / count) * probe.duration - length / 2)
        const sample = { index: i, start, end: start + length, firstFrame: start, frames: 0 }
        await run(ff, encodeArgs(probe, settings, sample, 'sample.mp4'), signal)
        return ((await ff.readFile('sample.mp4')) as Uint8Array).byteLength
      }),
    )
    const videoBytes = (sizes.reduce((s, x) => s + x, 0) / (count * length)) * probe.duration
    const audio = settings.keepAudio && probe.audio
    const audioBps = !audio ? 0 : probe.audio?.codec && COPYABLE_AUDIO.includes(probe.audio.codec) ? probe.audio.bitrate : 192_000
    return videoBytes + (audioBps * probe.duration) / 8
  } finally {
    signal.removeEventListener('abort', stop)
    stop()
  }
}
