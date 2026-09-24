import {
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  StreamTarget,
  WEBM,
  canEncodeAudio,
  type AudioCodec,
} from 'mediabunny'
import wasmUrl from './x264/x264.wasm?url'
import type { EncodedChunk, WorkerChunk, WorkerInit, WorkerMessage } from './encode-worker'
import { outputSize, type Preset, type Probe, type Settings } from './shared'

type EncodingPreset = Exclude<Preset, 'copy'>

/**
 * x264 constant-rate factors, calibrated so "faster" lands on the file sizes "veryfast" produced at CRF 18/22/26.
 * At those sizes it scores 1-5 VMAF points higher on the test corpus.
 */
export const CRF: Record<EncodingPreset, number> = {
  'visually-lossless': 18.3,
  high: 22.4,
  compact: 26.4,
}

// "faster" saves 18-30% of the bits of "veryfast" at equal quality (VMAF/SSIM BD-rate on the test corpus), and
// with the SIMD build it still encodes ~1.8x faster than scalar "veryfast" did.
export const X264_PRESET = 'faster'
const X264_TUNE = ''

export type Progress = { fraction: number; processed: number; elapsed: number }
export type Job = { promise: Promise<Blob>; cancel: () => void }

class Canceled extends Error {
  name = 'AbortError'
}

let compiled: Promise<WebAssembly.Module> | null = null

/** Compiles the encoder once; every worker instantiates the same module. */
export function loadEncoder() {
  compiled ??= WebAssembly.compileStreaming(fetch(wasmUrl)).catch((err) => {
    compiled = null
    throw new Error(`Couldn't load the x264 encoder (${err instanceof Error ? err.message : err}).`)
  })
  return compiled
}

// Measured peak WebAssembly memory for one 1080p encoder: lookahead and reference frames dominate.
const MEMORY_1080P_MB: Record<string, number> = { veryfast: 190, faster: 275, fast: 330, medium: 400, slow: 480 }

/** One encoder per core (the main thread is mostly idle while they run), fewer when frames are big or memory is tight. */
export function workerCount(probe: Probe, settings: Settings) {
  const { width, height } = outputSize(probe, settings.shortSide)
  const cores = navigator.hardwareConcurrency || 4
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const perWorker = (MEMORY_1080P_MB[X264_PRESET] ?? 400) * Math.max(0.35, (width * height) / (1920 * 1080))
  const budget = Math.min(3200, memoryGB * 1024 * 0.4)
  return Math.max(1, Math.min(cores, 8, Math.floor(budget / perWorker)))
}

async function openTrack(file: Blob) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA] })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('The file has no video track.')
  return { input, track }
}

/** Presentation timestamps of every video frame, in order. */
async function frameTimes(file: Blob) {
  const { input, track } = await openTrack(file)
  try {
    const times: number[] = []
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      times.push(packet.timestamp)
    }
    return times.sort((a, b) => a - b)
  } finally {
    input.dispose()
  }
}

const PRIMARIES: Record<string, string> = {
  bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m', bt2020: 'bt2020', smpte432: 'smpte432',
}
const TRANSFER: Record<string, string> = {
  bt709: 'bt709', smpte170m: 'smpte170m', 'iec61966-2-1': 'iec61966-2-1', linear: 'linear',
  pq: 'smpte2084', hlg: 'arib-std-b67',
}
const MATRIX: Record<string, string> = {
  bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m', 'bt2020-ncl': 'bt2020nc', rgb: 'GBR',
}

async function encoderOptions(probe: Probe, settings: Settings) {
  const preset = settings.preset === 'copy' ? 'visually-lossless' : settings.preset
  const options = [X264_PRESET, X264_TUNE, `crf=${CRF[preset]}`]
  const { width, height } = outputSize(probe, settings.shortSide)
  const resized = width !== probe.width || height !== probe.height
  if (resized) {
    // Resized frames go through an RGB canvas and come back as BT.709 limited range.
    options.push('colorprim=bt709', 'transfer=bt709', 'colormatrix=bt709', 'fullrange=off')
  } else {
    const { input, track } = await openTrack(probe.file)
    try {
      const color = await track.getColorSpace()
      if (color.primaries && PRIMARIES[color.primaries]) options.push(`colorprim=${PRIMARIES[color.primaries]}`)
      if (color.transfer && TRANSFER[color.transfer]) options.push(`transfer=${TRANSFER[color.transfer]}`)
      if (color.matrix && MATRIX[color.matrix]) options.push(`colormatrix=${MATRIX[color.matrix]}`)
      options.push(`fullrange=${color.fullRange ? 'on' : 'off'}`)
    } finally {
      input.dispose()
    }
  }
  return options.join(';')
}

/** Encoder input size: the frame as stored (before rotation), at the requested resolution. */
function frameSize(probe: Probe, settings: Settings, rotation: number) {
  const { width, height } = outputSize(probe, settings.shortSide)
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width }
}

type Pool = {
  run(chunks: WorkerChunk[], onFrames: (frames: number) => void): Promise<EncodedChunk[]>
  terminate(): void
}

async function createPool(size: number, init: Omit<WorkerInit, 'type' | 'module'>): Promise<Pool> {
  const module = await loadEncoder()
  const workers = Array.from({ length: size }, () =>
    new Worker(new URL('./encode-worker.ts', import.meta.url), { type: 'module' }),
  )
  const failed = (message: string) => new Error(`Encoder failed: ${message}`)
  let abort: ((err: Error) => void) | null = null
  const terminate = () => {
    workers.forEach((w) => w.terminate())
    abort?.(new Canceled())
  }
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
              if (e.data.type === 'ready') resolve()
              else if (e.data.type === 'error') reject(failed(e.data.message))
            }
            worker.onerror = (e) => reject(failed(e.message))
            worker.postMessage({ type: 'init', module, ...init } satisfies WorkerInit)
          }),
      ),
    )
  } catch (err) {
    terminate()
    throw err
  }

  return {
    terminate,
    run: (chunks, onFrames) =>
      new Promise((resolve, reject) => {
        abort = reject
        const queue = [...chunks]
        const results: EncodedChunk[] = []
        const frames = new Map<number, number>()
        let pending = chunks.length
        const next = (worker: Worker) => {
          const chunk = queue.shift()
          if (chunk) worker.postMessage(chunk)
        }
        for (const worker of workers) {
          worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
            const message = e.data
            if (message.type === 'progress') {
              frames.set(message.index, message.frames)
              onFrames([...frames.values()].reduce((s, n) => s + n, 0))
            } else if (message.type === 'done') {
              results[message.chunk.index] = message.chunk
              if (--pending === 0) resolve(results)
              else next(worker)
            } else if (message.type === 'error') {
              reject(failed(message.message))
            }
          }
          worker.onerror = (e) => reject(failed(e.message))
          next(worker)
        }
        if (pending === 0) resolve(results)
      }),
  }
}

/** Splits frames into roughly equal chunks; each chunk runs from one frame's timestamp to the next chunk's. */
function planChunks(times: number[], count: number): WorkerChunk[] {
  const n = Math.max(1, Math.min(count, Math.floor(times.length / 30)))
  const firsts = Array.from({ length: n }, (_, k) => Math.round((k * times.length) / n))
  return firsts.map((first, index) => ({
    type: 'chunk',
    index,
    start: times[first],
    end: index === n - 1 ? Infinity : times[firsts[index + 1]],
  }))
}

/** Splits x264's headers (4-byte length-prefixed SPS, PPS, SEI) into an avcC record and codec string. */
function avcConfig(headers: Uint8Array, width: number, height: number): VideoDecoderConfig {
  const nals: Uint8Array[] = []
  for (let i = 0; i < headers.length; ) {
    const len = (headers[i] << 24) | (headers[i + 1] << 16) | (headers[i + 2] << 8) | headers[i + 3]
    nals.push(headers.subarray(i + 4, i + 4 + len))
    i += 4 + len
  }
  const sps = nals.find((n) => (n[0] & 0x1f) === 7)
  const pps = nals.find((n) => (n[0] & 0x1f) === 8)
  if (!sps || !pps) throw new Error('The encoder produced no SPS/PPS.')
  const avcC = new Uint8Array(11 + sps.length + pps.length)
  avcC.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff])
  avcC.set(sps, 8)
  avcC.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length)
  avcC.set(pps, 11 + sps.length)
  const hex = (b: number) => b.toString(16).padStart(2, '0')
  return { codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`, codedWidth: width, codedHeight: height, description: avcC }
}

const MP4_AUDIO: AudioCodec[] = ['aac', 'opus', 'mp3', 'ac3', 'eac3', 'flac']

async function mux(probe: Probe, settings: Settings, chunks: EncodedChunk[], size: { width: number; height: number },
                   rotation: 0 | 90 | 180 | 270) {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let written = 0
  const writable = new WritableStream<{ type: 'write'; data: Uint8Array<ArrayBuffer>; position: number }>({
    write(chunk) {
      if (chunk.position !== written) throw new Error('Output was written out of order.')
      parts.push(chunk.data)
      written += chunk.data.byteLength
    },
  })
  const format = new Mp4OutputFormat({ fastStart: 'in-memory' })
  const output = new Output({ format, target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 2 ** 20 }) })
  const video = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(video, { rotation })

  const input = new Input({ source: new BlobSource(probe.file), formats: [MP4, QTFF, WEBM, MATROSKA] })
  try {
    const audioTrack = settings.keepAudio ? await input.getPrimaryAudioTrack() : null
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null
    const copyAudio = !!audioCodec && MP4_AUDIO.includes(audioCodec)
    const audioCopy = audioTrack && copyAudio ? new EncodedAudioPacketSource(audioCodec!) : null
    // 96 kbps per channel is transparent for AAC and Opus alike.
    const channels = audioTrack ? await audioTrack.getNumberOfChannels() : 2
    const audioEncode = audioTrack && !copyAudio
      ? new AudioSampleSource({
          codec: (await canEncodeAudio('aac')) ? 'aac' : 'opus',
          bitrate: Math.min(256_000, 96_000 * Math.max(1, channels)),
        })
      : null
    if (audioCopy) output.addAudioTrack(audioCopy)
    if (audioEncode) output.addAudioTrack(audioEncode)

    await output.start()

    const config = avcConfig(chunks[0].headers, size.width, size.height)
    const allTimes = chunks.flatMap((c) => c.times)
    const frameDuration = allTimes.length > 1 ? (allTimes[allTimes.length - 1] - allTimes[0]) / (allTimes.length - 1) : 1 / 30
    let first = true
    let offset = 0
    for (const chunk of chunks) {
      for (const packet of chunk.packets) {
        const i = offset + packet.pts
        const timestamp = allTimes[i]
        const duration = i + 1 < allTimes.length ? allTimes[i + 1] - timestamp : frameDuration
        await video.add(new EncodedPacket(packet.data, packet.key ? 'key' : 'delta', timestamp, duration),
          first ? { decoderConfig: config } : undefined)
        first = false
      }
      offset += chunk.times.length
    }
    video.close()

    if (audioTrack && audioCopy) {
      const decoderConfig = await audioTrack.getDecoderConfig()
      let firstAudio = true
      for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
        await audioCopy.add(packet, firstAudio && decoderConfig ? { decoderConfig } : undefined)
        firstAudio = false
      }
      audioCopy.close()
    }
    if (audioTrack && audioEncode) {
      for await (const sample of new AudioSampleSink(audioTrack).samples()) {
        await audioEncode.add(sample)
        sample.close()
      }
      audioEncode.close()
    }

    await output.finalize()
    return new Blob(parts, { type: format.mimeType })
  } finally {
    input.dispose()
  }
}

/** Encodes the video in parallel chunks with x264 and stitches them into one MP4. */
export function encode(probe: Probe, settings: Settings, onProgress: (p: Progress) => void): Job {
  let pool: Pool | null = null
  let canceled = false
  const cancel = () => {
    canceled = true
    pool?.terminate()
  }

  const promise = (async () => {
    try {
      const { input, track } = await openTrack(probe.file)
      const rotation = await track.getRotation()
      input.dispose()
      const size = frameSize(probe, settings, rotation)
      const [times, options] = await Promise.all([frameTimes(probe.file), encoderOptions(probe, settings)])
      const workers = workerCount(probe, settings)
      // Two chunks per worker keeps cores busy near the end; each chunk costs one extra keyframe, so not too many.
      const chunkSeconds = Math.min(20, Math.max(3, probe.duration / (workers * 2)))
      const chunks = planChunks(times, Math.ceil(probe.duration / chunkSeconds))
      const fps = probe.fps || 30
      pool = await createPool(Math.min(workers, chunks.length), {
        file: probe.file, options, width: size.width, height: size.height,
        fpsNum: Math.round(fps * 1000), fpsDen: 1000,
      })
      if (canceled) throw new Canceled()
      const started = performance.now()
      const encoded = await pool.run(chunks, (frames) => {
        const processed = (frames / times.length) * probe.duration
        onProgress({ fraction: Math.min(0.99, frames / times.length), processed, elapsed: (performance.now() - started) / 1000 })
      })
      pool.terminate()
      if (canceled) throw new Canceled()
      const blob = await mux(probe, settings, encoded, size, rotation)
      onProgress({ fraction: 1, processed: probe.duration, elapsed: (performance.now() - started) / 1000 })
      return blob
    } catch (err) {
      if (canceled) throw new Canceled()
      throw err
    } finally {
      pool?.terminate()
    }
  })()

  return { promise, cancel }
}

/** Encodes a few short clips with the same settings and extrapolates the finished size. */
export async function estimate(probe: Probe, settings: Settings, signal: AbortSignal) {
  const { input, track } = await openTrack(probe.file)
  const rotation = await track.getRotation()
  input.dispose()
  const size = frameSize(probe, settings, rotation)
  const [times, options] = await Promise.all([frameTimes(probe.file), encoderOptions(probe, settings)])
  const count = Math.min(workerCount(probe, settings), probe.duration >= 20 ? 3 : probe.duration >= 6 ? 2 : 1)
  const per = Math.min(times.length, Math.max(15, Math.round((probe.fps || 30) * 1.5)))
  const samples: WorkerChunk[] = Array.from({ length: count }, (_, i) => {
    const first = Math.min(times.length - per, Math.max(0, Math.round(((i + 0.5) / count) * times.length - per / 2)))
    return { type: 'chunk', index: i, start: times[first], end: first + per < times.length ? times[first + per] : Infinity }
  })
  if (signal.aborted) throw new Canceled()
  const fps = probe.fps || 30
  const pool = await createPool(count, {
    file: probe.file, options, width: size.width, height: size.height, fpsNum: Math.round(fps * 1000), fpsDen: 1000,
  })
  const stop = () => pool.terminate()
  signal.addEventListener('abort', stop)
  try {
    const encoded = await pool.run(samples, () => {})
    if (signal.aborted) throw new Canceled()
    const bytes = encoded.reduce((s, c) => s + c.packets.reduce((t, p) => t + p.data.byteLength, 0), 0)
    const frames = encoded.reduce((s, c) => s + c.times.length, 0)
    const videoBytes = (bytes / frames) * times.length
    const audio = settings.keepAudio && probe.audio
    const audioBps = !audio ? 0
      : probe.audio?.codec && MP4_AUDIO.includes(probe.audio.codec) ? probe.audio.bitrate
      : Math.min(256_000, 96_000 * Math.max(1, probe.audio?.channels ?? 2))
    return videoBytes + (audioBps * probe.duration) / 8
  } finally {
    signal.removeEventListener('abort', stop)
    pool.terminate()
  }
}
