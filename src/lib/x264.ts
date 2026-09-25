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
import singleScript from './x264/x264.mjs?url'
import singleWasm from './x264/x264.wasm?url'
import threadedScript from './x264/x264-mt.mjs?url'
import threadedWasm from './x264/x264-mt.wasm?url'
import type { EncodedChunk, FrameStat, WorkerChunk, WorkerInit, WorkerMessage } from './encode-worker'
import { outputSize, type Preset, type Probe, type Settings } from './shared'

type EncodingPreset = Exclude<Preset, 'copy'>

/**
 * x264 constant-rate factors. High and compact are calibrated so "faster" lands on the sizes "veryfast" produced at
 * CRF 22/26, scoring 1-5 VMAF points higher. Visually lossless is the no-size-limit target; with the size target on it
 * instead gets the best quality that fits (see plan()).
 */
export const CRF: Record<EncodingPreset, number> = {
  'visually-lossless': 16,
  high: 22.4,
  compact: 26.4,
}

// "faster" saves 18-30% of the bits of "veryfast" at equal quality (VMAF/SSIM BD-rate on the test corpus), and
// with the SIMD build it still encodes ~1.8x faster than scalar "veryfast" did.
export const X264_PRESET = 'faster'
const X264_TUNE = ''

export type Progress = {
  fraction: number
  processed: number
  elapsed: number
  /** Parallel encoders at work, and whether the file is being assembled. */
  workers?: number
  stage?: 'encoding' | 'refitting' | 'finishing'
}
/** Per-frame SSIM from the encoder, by source timestamp. */
export type FrameScores = { times: number[]; ssim: number[] }
export type Encoded = { blob: Blob; scores?: FrameScores }
export type Job = { promise: Promise<Encoded>; cancel: () => void }

class Canceled extends Error {
  name = 'AbortError'
}


/** Share of a frame's time spent before x264 outputs it: decoding, copying in, and lookahead analysis. On short
 * chunks, where the lookahead holds nearly every frame, that phase took about 40% of the wall time. */
const LOOKAHEAD_SHARE = 0.4

/**
 * x264's own frame threads need SharedArrayBuffer, which browsers only allow on cross-origin isolated pages. The
 * threaded build is the same encoder compiled with pthreads; it's only loaded when a layout actually uses threads.
 */
const canThread = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
const BUILDS = {
  single: { script: singleScript, wasm: singleWasm },
  threaded: { script: threadedScript, wasm: threadedWasm },
}
type Build = keyof typeof BUILDS
const compiled: Partial<Record<Build, Promise<WebAssembly.Module>>> = {}

/** Compiles an encoder build once; every worker instantiates the same module. */
export function loadEncoder(build: Build = 'single') {
  compiled[build] ??= WebAssembly.compileStreaming(fetch(BUILDS[build].wasm)).catch((err) => {
    delete compiled[build]
    throw new Error(`Couldn't load the x264 encoder (${err instanceof Error ? err.message : err}).`)
  })
  return compiled[build]
}

// Measured peak WebAssembly memory for one 1080p encoder with the preset's own lookahead; 40 frames needs ~400 MB.
const MEMORY_1080P_MB: Record<string, number> = { veryfast: 190, faster: 275, fast: 330, medium: 400, slow: 480 }

export type Layout = {
  /** Encoders running side by side, one chunk each. */
  encoders: number
  /** x264 frame threads inside each encoder. */
  threads: number
}

/**
 * One encoder per core (the main thread is mostly idle while they run), fewer when frames are big or memory is
 * tight, each running x264 with its own frame threads. Threads add a frame in flight rather than a whole encoder's
 * worth of memory, so cores beyond what memory allows go to them too.
 */
export function workerCount(probe: Probe, settings: Settings): Layout {
  const { width, height } = outputSize(probe, settings.shortSide)
  const cores = navigator.hardwareConcurrency || 4
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const perWorker = longLookahead(width, height)
    ? 400 * Math.max(0.35, (width * height) / (1920 * 1080))
    : (MEMORY_1080P_MB[X264_PRESET] ?? 400) * Math.max(0.35, (width * height) / (1920 * 1080))
  const budget = Math.min(3200, memoryGB * 1024 * 0.4)
  const encoders = Math.max(1, Math.min(cores, 8, Math.floor(budget / perWorker)))
  // Two threads per encoder even when there are no spare cores: while an encoder's worker waits for decoded frames
  // and copies them in, its other thread keeps x264 busy. Measured 13% faster on a 4-core, 8-thread machine.
  const threads = canThread ? Math.max(2, Math.min(4, Math.floor(cores / encoders))) : 1
  return { encoders, threads }
}

async function openTrack(file: Blob) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA] })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('The file has no video track.')
  return { input, track }
}

type Timeline = {
  /** Presentation timestamps of every video frame, in order. */
  times: number[]
  /** Indexes into `times` of the source's keyframes. */
  keys: number[]
}

async function timeline(file: Blob): Promise<Timeline> {
  const { input, track } = await openTrack(file)
  try {
    const frames: { t: number; key: boolean }[] = []
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      frames.push({ t: packet.timestamp, key: packet.type === 'key' })
    }
    frames.sort((a, b) => a.t - b.t)
    return { times: frames.map((f) => f.t), keys: frames.flatMap((f, i) => (f.key ? [i] : [])) }
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

export function presetCrf(settings: Settings) {
  return CRF[settings.preset === 'copy' ? 'visually-lossless' : settings.preset]
}

/** A 40-frame lookahead (vs. 20 in "faster") saves ~2% more bits at no speed cost, but the memory it needs at 4K
 * would cost a worker, so it stops at 1080p. */
const longLookahead = (width: number, height: number) => width * height <= 2.2e6

async function encoderOptions(probe: Probe, settings: Settings, crf: number) {
  // 3 reference frames and smart weighted prediction cost no measurable speed; with the 40-frame lookahead they
  // take "faster" from -27.8% to -29.7% BD-rate (VMAF NEG) against the old "veryfast".
  // ssim=1 makes x264 score every frame against its input as it encodes, at no measurable cost. stitchable=1 keeps
  // the picture parameter set independent of the rate factor, so chunks encoded at different ones can share it.
  const options = [X264_PRESET, X264_TUNE, `crf=${crf.toFixed(1)}`, 'ref=3', 'weightp=2', 'ssim=1', 'stitchable=1']
  const { width, height } = outputSize(probe, settings.shortSide)
  if (longLookahead(width, height)) options.push('rc-lookahead=40')
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
  /**
   * Encodes the chunks in queue order, reporting frames finished so far and the new frames' sizes. `prepare` sees
   * each chunk just before a worker takes it, so later chunks can use what earlier ones measured.
   */
  run(
    chunks: WorkerChunk[],
    onProgress: (frames: number, stats: FrameStat[], index: number) => void,
    prepare?: (chunk: WorkerChunk) => WorkerChunk,
  ): Promise<EncodedChunk[]>
  terminate(): void
  /** x264 threads per encoder: what was asked for, or 1 if the threaded build couldn't start. */
  threads: number
}

type PoolInit = Omit<WorkerInit, 'type' | 'module' | 'script' | 'threads'>

/** Starts `size` encoders with `threads` x264 threads each, falling back to single-threaded encoders if the
 * threaded build doesn't start (it's the less travelled path, and some browsers limit nested workers). */
let threadsFailed = false

async function createPool(size: number, threads: number, init: PoolInit): Promise<Pool> {
  if (threads > 1 && !threadsFailed) {
    try {
      return await startPool(size, threads, init, 20_000)
    } catch (err) {
      if (err instanceof Canceled) throw err
      threadsFailed = true
      console.warn(`[pare] threaded encoder unavailable, using one thread per encoder: ${err instanceof Error ? err.message : err}`)
    }
  }
  return startPool(size, 1, init)
}

async function startPool(size: number, threads: number, init: PoolInit, timeout?: number): Promise<Pool> {
  const build: Build = threads > 1 ? 'threaded' : 'single'
  const module = await loadEncoder(build)
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
    const ready = Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
              if (e.data.type === 'ready') resolve()
              else if (e.data.type === 'error') reject(failed(e.data.message))
            }
            worker.onerror = (e) => reject(failed(e.message))
            worker.postMessage({ type: 'init', module, script: BUILDS[build].script, threads, ...init } satisfies WorkerInit)
          }),
      ),
    )
    await (timeout
      ? Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(failed('timed out starting')), timeout))])
      : ready)
  } catch (err) {
    terminate()
    throw err
  }

  return {
    terminate,
    threads,
    run: (chunks, onProgress, prepare) =>
      new Promise((resolve, reject) => {
        abort = reject
        const queue = [...chunks]
        const results: EncodedChunk[] = []
        // Frames count a little when they enter the lookahead and the rest when x264 outputs them, so progress
        // moves from the start even though the first output waits for 40 frames of lookahead.
        const frames = new Map<number, number>()
        let pending = chunks.length
        const next = (worker: Worker) => {
          const chunk = queue.shift()
          if (chunk) worker.postMessage(prepare ? prepare(chunk) : chunk)
        }
        for (const worker of workers) {
          worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
            const message = e.data
            if (message.type === 'progress') {
              frames.set(message.index, LOOKAHEAD_SHARE * message.fed + (1 - LOOKAHEAD_SHARE) * message.frames)
              onProgress([...frames.values()].reduce((s, n) => s + n, 0), message.stats, message.index)
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

/**
 * Splits the video for the worker pool. At least one chunk per worker so no core idles; on longer videos about 8
 * seconds each (x264 starts a keyframe that often anyway), so there are several rounds and later chunks can be
 * steered by what earlier ones measured. Each boundary moves to the nearest source keyframe within a third of a
 * chunk: those are usually scene cuts, where a fresh keyframe costs nothing extra, and decoding a chunk then starts
 * exactly at its first frame.
 */
function planChunks({ times, keys }: Timeline, workers: number): WorkerChunk[] {
  const n = Math.max(1, Math.min(Math.max(workers, Math.min(6 * workers, Math.ceil(times.length / 240))), Math.floor(times.length / 30)))
  const span = times.length / n
  const firsts = [0]
  for (let k = 1; k < n; k++) {
    const ideal = Math.round(k * span)
    let best = ideal
    let distance = span / 3
    for (const key of keys) {
      const d = Math.abs(key - ideal)
      if (d < distance) (best = key), (distance = d)
    }
    if (best > firsts[firsts.length - 1] + 15 && best < times.length - 15) firsts.push(best)
  }
  return firsts.map((first, index) => ({
    type: 'chunk',
    index,
    start: times[first],
    end: index === firsts.length - 1 ? Infinity : times[firsts[index + 1]],
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

/**
 * Tracks an encode against a size budget. Finished frames are converted to what they would have cost at the floor
 * rate factor (x264's sizes fall about exponentially with it) and averaged, with chunk-opening keyframes kept apart.
 * Each chunk gets one rate factor when a worker picks it up: the one that makes the projected total land on the
 * goal, given what's already spent and what chunks in progress will still add. The first round of chunks has
 * nothing to go on and uses the plan's rate factor.
 */
type Course = {
  /** Video bytes to aim for. */
  goal: number
  /** Frames in each chunk, by index. */
  frames: number[]
  floor: number
  crf: number
  slope: number
}

class Budget {
  spent = 0
  private course: Course
  private keys = { count: 0, norm: 0 }
  private rest = { count: 0, norm: 0 }
  /** Rate factor and frames finished so far, per chunk that has started. */
  private started = new Map<number, { crf: number; done: number }>()

  constructor(course: Course) {
    this.course = course
  }

  add(index: number, stats: FrameStat[]) {
    const { slope, floor } = this.course
    const chunk = this.started.get(index)
    for (const f of stats) {
      this.spent += f.bytes
      const bucket = f.first ? this.keys : this.rest
      bucket.count++
      bucket.norm += f.bytes * Math.exp(-slope * (f.crf - floor))
      if (chunk) chunk.done++
    }
  }

  /** Picks the rate factor for a chunk about to start. */
  assign(index: number): number {
    const { goal, frames, floor, slope } = this.course
    let crf = this.course.crf
    // Wait for a few frames from every chunk of the first round before trusting the averages.
    if (this.rest.count >= Math.max(24, this.started.size * 8)) {
      const perFrame = this.rest.norm / this.rest.count
      const perKey = this.keys.count ? this.keys.norm / this.keys.count : perFrame * 4
      const cost = (n: number, first: boolean) => (first ? perKey + (n - 1) * perFrame : n * perFrame)
      let pending = 0
      for (const [i, c] of this.started) {
        const left = frames[i] - c.done
        if (left > 0) pending += cost(left, c.done === 0) * Math.exp(slope * (c.crf - floor))
      }
      let open = 0
      frames.forEach((n, i) => {
        if (!this.started.has(i)) open += cost(n, true)
      })
      const left = goal - this.spent - pending
      crf = left <= 0 ? MAX_CRF : floor + Math.log(left / open) / slope
      // Move gradually: stay within 1.5 of the frame-weighted average so far. Sizes can change faster than the
      // assumed slope, and neighbouring chunks look best at similar settings.
      let weight = 0
      let sum = 0
      for (const [i, c] of this.started) (sum += c.crf * frames[i]), (weight += frames[i])
      const mean = sum / weight
      crf = Math.min(mean + 1.5, Math.max(mean - 1.5, crf))
    }
    crf = Math.min(MAX_CRF, Math.max(floor, crf))
    this.started.set(index, { crf, done: 0 })
    return crf
  }
}

/** Puts one chunk from each part of the video first, so the first frames every encoder finishes span all of it. */
function spread<T>(items: T[], first: number): T[] {
  if (items.length <= first) return items
  const picked = new Set(Array.from({ length: first }, (_, i) => Math.floor(((i + 0.5) * items.length) / first)))
  return [...items.filter((_, i) => picked.has(i)), ...items.filter((_, i) => !picked.has(i))]
}

const chunkBytes = (c: EncodedChunk) => c.packets.reduce((t, p) => t + p.data.byteLength, 0)

/**
 * Chooses chunks to encode again so the video changes by `-excess` bytes. Too big: the biggest chunks go up first,
 * since they save the most per step and busy, complex footage hides the change best, and enough of them are taken
 * that the rise stays within 3 steps where it can. Far too small: every chunk above the floor comes down.
 */
function refit(chunks: EncodedChunk[], crfs: number[], excess: number, slope: number, floor: number) {
  let picked: EncodedChunk[]
  if (excess > 0) {
    const bySize = [...chunks].sort((a, b) => chunkBytes(b) - chunkBytes(a))
    const gain = 1 - Math.exp(slope * 3)
    let pool = 0
    let count = 0
    while (count < bySize.length && pool * gain < excess) pool += chunkBytes(bySize[count++])
    picked = bySize.slice(0, count)
  } else {
    picked = chunks.filter((c) => crfs[c.index] > floor + 0.25)
  }
  const pool = picked.reduce((t, c) => t + chunkBytes(c), 0)
  // pool * e^(slope * change) = pool - excess
  const change = excess >= pool ? 6 : Math.log(1 - excess / pool) / slope
  return picked.map((c) => ({
    index: c.index,
    crf: Math.min(MAX_CRF, Math.max(floor, crfs[c.index] + (excess > 0 ? Math.max(0.5, change) : change))),
  }))
}

/**
 * Local slope of log size against rate factor, from the real total at the rate factor just used to the plan's test
 * point on the side we're moving toward. Sizes rarely fall at a constant rate: noisy footage can halve within two
 * steps once x264 stops spending bits on the noise, so the nearer measurement beats the plan's overall average.
 */
function localSlope(points: { crf: number; bytes: number }[], crf: number, total: number, up: boolean, fallback: number) {
  const beyond = points.filter((p) => (up ? p.crf > crf + 1 : p.crf < crf - 1))
  if (!beyond.length) return fallback
  const p = beyond.reduce((a, b) => (Math.abs(b.crf - crf) < Math.abs(a.crf - crf) ? b : a))
  const slope = Math.log(p.bytes / total) / (p.crf - crf)
  return Number.isFinite(slope) ? Math.min(-0.05, Math.max(-0.6, slope)) : fallback
}

function audioBytes(probe: Probe, settings: Settings) {
  if (!settings.keepAudio || !probe.audio) return 0
  const bps = probe.audio.codec && MP4_AUDIO.includes(probe.audio.codec) ? probe.audio.bitrate
    : Math.min(256_000, 96_000 * Math.max(1, probe.audio.channels ?? 2))
  return (bps * probe.duration) / 8
}

/** The rate factor an encode starts from, and the lowest it may go: the quality ceiling or the preset's own. */
export function floorCrf(settings: Settings) {
  return settings.sizeTarget && settings.preset === 'visually-lossless' ? QUALITY_CEILING_CRF : presetCrf(settings)
}

export type EncodeStart = {
  /** Where to start; defaults to the floor. A finished size plan knows better. */
  crf?: number
  /** How fast size falls with the rate factor (log bytes per unit), when a plan measured it. */
  slope?: number
  /** The plan's predicted video bytes at the rate factors it tested. */
  points?: { crf: number; bytes: number }[]
}

/**
 * Encodes the video in parallel chunks with x264 and stitches them into one MP4. With the size target on, the rate
 * factor is steered during the encode so the file lands just under the target.
 */
export function encode(probe: Probe, settings: Settings, start: EncodeStart, onProgress: (p: Progress) => void): Job {
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
      const floor = floorCrf(settings)
      const crf = Math.min(MAX_CRF, Math.max(floor, start.crf ?? floor))
      const slope = start.slope && start.slope < -0.03 ? start.slope : DEFAULT_SLOPE
      const [line, options] = await Promise.all([timeline(probe.file), encoderOptions(probe, settings, crf)])
      const { times } = line
      const { encoders, threads } = workerCount(probe, settings)
      const chunks = planChunks(line, encoders)
      const frameCounts = chunks.map((c) => times.filter((t) => t >= c.start && t < c.end).length)
      const active = Math.min(encoders, chunks.length)
      const cores = Math.min(navigator.hardwareConcurrency || active, active * threads)
      const fps = probe.fps || 30
      const init = { file: probe.file, options, width: size.width, height: size.height, fpsNum: Math.round(fps * 1000), fpsDen: 1000 }
      pool = await createPool(active, threads, init)
      let poolThreads = pool.threads
      if (canceled) throw new Canceled()
      const audio = audioBytes(probe, settings)
      const goal = Math.max(probe.file.size * SIZE_AIM - audio, probe.file.size * 0.05)
      const limit = Math.max(probe.file.size * SIZE_TARGET - audio - 64e3, probe.file.size * 0.05)
      // A steeper slope than measured keeps the budget from overreaching when it lowers the rate factor: near the
      // sizes it lands on, noisy footage grows much faster than the plan's two distant tests suggest.
      const budget = settings.sizeTarget
        ? new Budget({ goal, frames: frameCounts, floor, crf, slope: Math.min(slope, -0.15) })
        : null
      const crfs: number[] = chunks.map(() => crf)
      const withCrf = (chunk: WorkerChunk, value: number) => {
        crfs[chunk.index] = value
        return { ...chunk, options: options.replace(/crf=[\d.]+/, `crf=${value.toFixed(2)}`) }
      }

      // Progress counts every frame encoded, including any second pass over chunks that came out too big.
      let work = times.length
      let finished = 0
      const started = performance.now()
      const report = (frames: number, stage: Progress['stage']) => {
        const fraction = Math.min(0.99, (finished + frames) / work)
        onProgress({ fraction, processed: fraction * probe.duration, elapsed: (performance.now() - started) / 1000,
          workers: cores, stage })
      }
      const encoded = await pool.run(
        spread(chunks, active),
        (frames, stats, index) => {
          budget?.add(index, stats)
          report(frames, 'encoding')
        },
        budget ? (chunk) => withCrf(chunk, budget.assign(chunk.index)) : undefined,
      )
      const passes = [chunks.map((c) => crfs[c.index].toFixed(1)).join(' ')]

      // The size limit is a promise, so check the real total and encode chunks again until it holds. A total far
      // under the goal means the plan was pessimistic, and the room is spent on quality instead.
      let total = encoded.reduce((t, c) => t + chunkBytes(c), 0)
      for (let round = 0; budget && round < 3; round++) {
        const over = total > limit
        if (!over && !(total < goal * 0.8 && crfs.some((c) => c > floor + 0.25))) break
        const mean = encoded.reduce((t, c) => t + crfs[c.index] * chunkBytes(c), 0) / total
        const local = localSlope(start.points ?? [], mean, total, over, slope)
        const redo = refit(encoded, crfs, total - goal, local, floor)
        const again = redo.map(({ index, crf: value }) => withCrf(chunks[index], value))
        finished += work - finished
        work = finished + again.reduce((t, c) => t + frameCounts[c.index], 0)
        // Fewer chunks than encoders: give each the cores the others would have used, as x264 threads.
        const spare = canThread ? Math.min(4, Math.floor((navigator.hardwareConcurrency || active) / again.length)) : 1
        if (spare > poolThreads) {
          pool.terminate()
          pool = await createPool(again.length, spare, init)
          poolThreads = pool.threads
          if (canceled) throw new Canceled()
        }
        const redone = await pool.run(again, (frames) => report(frames, 'refitting'))
        for (const c of redone) if (c) encoded[c.index] = c
        const before = total
        total = encoded.reduce((t, c) => t + chunkBytes(c), 0)
        passes.push(`${(before / 1e6).toFixed(2)} MB, slope ${local.toFixed(3)}, ${poolThreads} threads: ` +
          redo.map((r) => `${r.index}→${r.crf.toFixed(1)}`).join(' '))
      }
      pool.terminate()
      if (canceled) throw new Canceled()
      const wall = performance.now() - started
      const sum = (k: 'decode' | 'load' | 'encode') => encoded.reduce((t, c) => t + c.timing[k], 0)
      console.info(`[pare] ${active} workers × ${threads} threads asked, ${chunks.length} chunks, wall ${(wall / 1000).toFixed(1)} s; per-worker average: ` +
        `decode ${(sum('decode') / active / 1000).toFixed(1)} s, copy ${(sum('load') / active / 1000).toFixed(1)} s, ` +
        `encode ${(sum('encode') / active / 1000).toFixed(1)} s; video ${(total / 1e6).toFixed(2)} MB; rate factors ${passes.join(' | ')}`)
      onProgress({ fraction: 0.99, processed: probe.duration, elapsed: (performance.now() - started) / 1000,
        workers: cores, stage: 'finishing' })
      const blob = await mux(probe, settings, encoded, size, rotation)
      onProgress({ fraction: 1, processed: probe.duration, elapsed: (performance.now() - started) / 1000 })
      const scores: FrameScores = { times: [], ssim: [] }
      for (const chunk of encoded)
        for (const p of chunk.packets) {
          scores.times.push(chunk.times[p.pts])
          scores.ssim.push(p.ssim)
        }
      return { blob, scores }
    } catch (err) {
      if (canceled) throw new Canceled()
      throw err
    } finally {
      pool?.terminate()
    }
  })()

  return { promise, cancel }
}

/** The size target: at most half the original. Steering aims a little lower to absorb its error at the very end. */
export const SIZE_TARGET = 0.5
const SIZE_AIM = 0.47
const MAX_CRF = 30
/** x264 sizes fall ~13% per rate factor step between CRF 15 and 25 (median of the test corpus, range 8-25%). */
const DEFAULT_SLOPE = -0.13
/** Past this, extra bits buy nothing visible even on paused frames (VMAF NEG 95-100 on the test corpus at CRF 16). */
const QUALITY_CEILING_CRF = 15
/** Frames per test window: enough for x264's rate control to settle after the window's opening keyframe. */
const WINDOW_FRAMES = 24
/** Test-window estimates came in 3-11% under the finished files (median ~7%); scale them to match. */
const ESTIMATE_BIAS = 1.08

export type SizePlan = {
  crf: number
  /** Predicted size of the finished file in bytes. */
  size: number
  /** True when the rate factor was raised above the preset's to meet the size target. */
  raised: boolean
  /** Visually lossless with the size target: the best quality that fits (true), or the quality ceiling (false). */
  fitted?: boolean
  /** Measured change in log size per rate factor step. */
  slope?: number
  /** Predicted video bytes at the tested rate factors. */
  points?: { crf: number; bytes: number }[]
}

/**
 * Encodes a few short clips and extrapolates the finished size. With the size target on, and when the preset's
 * rate factor would leave the file bigger than half the original, searches for the lowest rate factor that gets
 * there (x264 roughly halves the bits every +6).
 */
export async function plan(probe: Probe, settings: Settings, signal: AbortSignal): Promise<SizePlan> {
  const began = performance.now()
  const { input, track } = await openTrack(probe.file)
  const rotation = await track.getRotation()
  input.dispose()
  const size = frameSize(probe, settings, rotation)
  const baseCrf = presetCrf(settings)
  const [line, options] = await Promise.all([timeline(probe.file), encoderOptions(probe, settings, baseCrf)])
  const { times } = line
  // One round of tests: half the cores encode short windows at the preset's rate factor, the other half the same
  // windows at a rate factor about half the size, so the curve between them is known without a second round. Each
  // window starts on a source keyframe when one is close, so its decoder doesn't work through frames it won't use.
  const { encoders, threads } = workerCount(probe, settings)
  const windowCount = Math.max(1, Math.min(Math.floor(encoders / 2) || 1, Math.floor(times.length / 40)))
  const count = Math.min(encoders, windowCount * 2)
  const per = Math.min(Math.floor(times.length / windowCount), WINDOW_FRAMES)
  const windows = Array.from({ length: windowCount }, (_, i) => {
    const ideal = Math.min(times.length - per, Math.max(0, Math.round(((i + 0.5) / windowCount) * times.length - per / 2)))
    const near = line.keys.filter((k) => Math.abs(k - ideal) <= times.length / windowCount / 3 && k + per <= times.length)
    const first = near.length ? near.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a)) : ideal
    return { start: times[first], end: first + per < times.length ? times[first + per] : Infinity }
  })
  // The real encode starts a keyframe per chunk and roughly every 250 frames, plus one per scene cut.
  const fixedKeyframes = planChunks(line, encoders).length + Math.floor(times.length / 250)
  if (signal.aborted) throw new Canceled()
  const fps = probe.fps || 30
  const pool = await createPool(count, threads, {
    file: probe.file, options, width: size.width, height: size.height, fpsNum: Math.round(fps * 1000), fpsDen: 1000,
  })
  const stop = () => pool.terminate()
  signal.addEventListener('abort', stop)

  const audio = audioBytes(probe, settings)

  /** Predicted video bytes for the whole file at each rate factor, all encoded in one round. */
  const videoAt = async (crfs: number[]) => {
    const chunks: WorkerChunk[] = crfs.flatMap((crf, c) =>
      windows.map((w, i) => ({
        type: 'chunk' as const,
        index: c * windows.length + i,
        ...w,
        options: options.replace(/crf=[\d.]+/, `crf=${crf.toFixed(1)}`),
      })),
    )
    const encoded = await pool.run(chunks, () => {})
    if (signal.aborted) throw new Canceled()
    return crfs.map((_, c) => {
      // Keyframes are priced separately: every window starts with one, which would over-count them. Keyframes
      // later in a window are scene cuts, and their rate carries over to the whole video.
      let keyBytes = 0, keyCount = 0, restBytes = 0, restCount = 0, sceneCuts = 0, frames = 0
      for (const chunk of encoded.slice(c * windows.length, (c + 1) * windows.length)) {
        frames += chunk.times.length
        for (const p of chunk.packets) {
          if (p.key) (keyBytes += p.data.byteLength), keyCount++
          else (restBytes += p.data.byteLength), restCount++
          if (p.key && p.pts > 0) sceneCuts++
        }
      }
      const keyframes = fixedKeyframes + (sceneCuts / Math.max(1, frames)) * times.length
      const perKey = keyCount ? keyBytes / keyCount : 0
      const perFrame = restCount ? restBytes / restCount : perKey
      // Short windows see less of the lookahead's bit redistribution and ran 3-11% low against full encodes.
      return ESTIMATE_BIAS * (perKey * keyframes + perFrame * Math.max(0, times.length - keyframes))
    })
  }

  try {
    if (!settings.sizeTarget) {
      const [base] = await videoAt([baseCrf])
      return { crf: baseCrf, size: base + audio, raised: false }
    }
    // Visually lossless spends the whole budget on quality: test the quality ceiling and a point well below it. Other
    // presets keep their own rate factor unless it would miss the target.
    const lossless = settings.preset === 'visually-lossless'
    const lo = lossless ? QUALITY_CEILING_CRF : baseCrf
    const hi = Math.min(MAX_CRF, lo + (lossless ? 10 : 6))
    const [atLo, atHi] = await videoAt([lo, hi])
    // Decide against the aim, not the target itself: estimates run up to ~10% low, and a file predicted at 48% could
    // land above half.
    const goal = Math.max(probe.file.size * SIZE_AIM - audio, probe.file.size * 0.05)
    // log(size) is close to linear in the rate factor; interpolate (or extrapolate) between the two tests.
    const measured = (Math.log(atHi) - Math.log(atLo)) / (hi - lo)
    const slope = measured < -0.03 ? measured : DEFAULT_SLOPE
    console.info(`[pare] plan: ${(performance.now() - began) / 1000 | 0} s, ${windows.length}×${per} frames, ` +
      `crf ${lo} → ${(atLo / 1e6).toFixed(1)} MB, crf ${hi} → ${(atHi / 1e6).toFixed(1)} MB, slope ${slope.toFixed(3)}`)
    const points = [{ crf: lo, bytes: atLo }, { crf: hi, bytes: atHi }]
    if (atLo <= goal) return { crf: lo, size: atLo + audio, raised: false, fitted: false, slope, points }
    let crf = Math.min(MAX_CRF, Math.max(lo, lo + (Math.log(goal) - Math.log(atLo)) / slope))
    // Past the higher test the straight line tends to overstate sizes (the noise stops costing bits), so land
    // halfway back: the encode checks its real size and corrects either way.
    if (crf > hi) crf = hi + (crf - hi) / 2
    const video = Math.exp(Math.log(atLo) + slope * (crf - lo))
    console.info(`[pare] plan: crf ${crf.toFixed(1)} → ${(video / 1e6).toFixed(2)} MB video`)
    return { crf: Math.round(crf * 10) / 10, size: Math.min(video, goal) + audio, raised: crf > baseCrf, fitted: lossless, slope, points }
  } finally {
    signal.removeEventListener('abort', stop)
    pool.terminate()
  }
}
