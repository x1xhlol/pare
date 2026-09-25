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
import av1Script from './av1/av1.mjs?url'
import av1Wasm from './av1/av1.wasm?url'
import type { EncodedChunk, FrameStat, WorkerChunk, WorkerInit, WorkerMessage, WorkerSplit } from './encode-worker'
import { outputSize, type Preset, type Probe, type Settings } from './shared'

type EncodingPreset = Exclude<Preset, 'copy'>

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


/** Least a cut must take off the encode's wall time to be worth a keyframe, in seconds and in frames moved. */
const MIN_CUT = { seconds: 1, frames: 8 }

/** Share of a frame's time spent before x264 outputs it: decoding, copying in, and lookahead analysis. On short
 * chunks, where the lookahead holds nearly every frame, that phase took about 40% of the wall time. */
const LOOKAHEAD_SHARE = 0.4

/**
 * x264's own frame threads need SharedArrayBuffer, which browsers only allow on cross-origin isolated pages. The
 * threaded build is the same encoder compiled with pthreads; it's only loaded when a layout actually uses threads.
 */
const canThread = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
const BUILDS = {
  x264: { script: singleScript, wasm: singleWasm },
  'x264-mt': { script: threadedScript, wasm: threadedWasm },
  av1: { script: av1Script, wasm: av1Wasm },
}
type Build = keyof typeof BUILDS
const compiled: Partial<Record<Build, Promise<WebAssembly.Module>>> = {}

/** Compiles an encoder build once; every worker instantiates the same module. */
export function loadEncoder(build: Build) {
  compiled[build] ??= WebAssembly.compileStreaming(fetch(BUILDS[build].wasm)).catch((err) => {
    delete compiled[build]
    throw new Error(`Couldn't load the encoder (${err instanceof Error ? err.message : err}).`)
  })
  return compiled[build]
}

/** Colour description for the encoder: the source's, or BT.709 limited range for resized frames. */
type Color = { primaries?: string; transfer?: string; matrix?: string; fullRange: boolean }

/**
 * What differs between the encoders. Everything else (the size plan, chunks, budget, refit and quality check) is
 * shared: both builds expose the same C API (x264-wasm/pare_x264.c, av1-wasm/pare_svtav1.c).
 */
type Profile = {
  /** One-thread build, and the pthreads build if there is one. */
  single: Build
  threaded?: Build
  /** Mediabunny's codec, and the decoder config built from the encoder's headers. */
  codec: 'avc' | 'av1'
  config: (headers: Uint8Array, width: number, height: number) => VideoDecoderConfig
  /** Rate factors without the size target. Visually lossless with it starts from `ceiling` instead. */
  crf: Record<EncodingPreset, number>
  ceiling: number
  max: number
  /** Typical change in log size per rate factor step, and the steeper one the budget assumes. */
  slope: number
  budgetSlope: number
  /** How far above its first test encode the plan puts the second. */
  span: { lossless: number; other: number }
  /** A faster preset for the plan's test encodes, when its sizes predict the real preset's as well. */
  planPreset?: string
  /** Peak WebAssembly memory of one encoder at this size, in MB. */
  memory: (width: number, height: number) => number
  /** Time to decode a source frame against decoding and encoding one, with every core busy (1080p H.264 source). */
  decodeShare: number
  options: (crf: number, color: Color, width: number, height: number) => string[]
}

const scale = (width: number, height: number) => Math.max(0.35, (width * height) / (1920 * 1080))

/** A 40-frame lookahead (vs. 20 in "faster") saves ~2% more bits at no speed cost, but the memory it needs at 4K
 * would cost a worker, so it stops at 1080p. */
const longLookahead = (width: number, height: number) => width * height <= 2.2e6

const X264_PRIMARIES: Record<string, string> = {
  bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m', bt2020: 'bt2020', smpte432: 'smpte432',
}
const X264_TRANSFER: Record<string, string> = {
  bt709: 'bt709', smpte170m: 'smpte170m', 'iec61966-2-1': 'iec61966-2-1', linear: 'linear',
  pq: 'smpte2084', hlg: 'arib-std-b67',
}
const X264_MATRIX: Record<string, string> = {
  bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m', 'bt2020-ncl': 'bt2020nc', rgb: 'GBR',
}

/**
 * x264 at "faster": 18-30% fewer bits than "veryfast" for the same quality on the test corpus. High and compact are
 * calibrated so it lands on the sizes "veryfast" produced at CRF 22/26, scoring 1-5 VMAF points higher.
 */
const X264: Profile = {
  single: 'x264',
  threaded: 'x264-mt',
  codec: 'avc',
  config: (headers, width, height) => avcConfig(headers, width, height),
  crf: { 'visually-lossless': 16, high: 22.4, compact: 26.4 },
  /** Past this, extra bits buy nothing visible even on paused frames (VMAF NEG 95-100 on the corpus at CRF 16). */
  ceiling: 15,
  max: 30,
  /** Sizes fall ~13% per step between CRF 15 and 25 (median of the corpus, range 8-25%). */
  slope: -0.13,
  budgetSlope: -0.15,
  span: { lossless: 10, other: 6 },
  // Measured peak memory at 1080p: ~400 MB with the 40-frame lookahead, 275 MB with the preset's 20.
  memory: (width, height) => (longLookahead(width, height) ? 400 : 275) * scale(width, height),
  // 30 ms to decode, 310 ms to encode.
  decodeShare: 0.09,
  options: (crf, color, width, height) => {
    // 3 reference frames and smart weighted prediction cost no measurable speed; with the 40-frame lookahead they
    // take "faster" from -27.8% to -29.7% BD-rate (VMAF NEG) against the old "veryfast". ssim=1 scores every frame
    // as it's encoded. stitchable=1 keeps the picture parameter set independent of the rate factor, so chunks
    // encoded at different ones can share it.
    const options = ['faster', '', `crf=${crf.toFixed(1)}`, 'ref=3', 'weightp=2', 'ssim=1', 'stitchable=1']
    if (longLookahead(width, height)) options.push('rc-lookahead=40')
    if (color.primaries && X264_PRIMARIES[color.primaries]) options.push(`colorprim=${X264_PRIMARIES[color.primaries]}`)
    if (color.transfer && X264_TRANSFER[color.transfer]) options.push(`transfer=${X264_TRANSFER[color.transfer]}`)
    if (color.matrix && X264_MATRIX[color.matrix]) options.push(`colormatrix=${X264_MATRIX[color.matrix]}`)
    options.push(`fullrange=${color.fullRange ? 'on' : 'off'}`)
    return options
  },
}

const SVT_PRIMARIES: Record<string, string> = {
  bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'bt601', bt2020: 'bt2020', smpte432: 'smpte432',
}
const SVT_TRANSFER: Record<string, string> = {
  bt709: 'bt709', smpte170m: 'bt601', 'iec61966-2-1': 'srgb', linear: 'linear', pq: 'smpte2084', hlg: 'hlg',
}
const SVT_MATRIX: Record<string, string> = {
  bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'bt601', 'bt2020-ncl': 'bt2020-ncl', rgb: 'identity',
}

/**
 * SVT-AV1 at preset 8: 30% fewer bits than the x264 setting for the same VMAF NEG on the corpus (far more on some
 * footage, worse on rippling water). Its rate factors are the ones that score like x264's on the corpus.
 */
const AV1: Profile = {
  single: 'av1',
  codec: 'av1',
  config: (headers, width, height) => av1Config(headers, width, height),
  crf: { 'visually-lossless': 18, high: 36, compact: 42 },
  ceiling: 16,
  max: 55,
  /** Sizes fall ~7.5% per step (median of the corpus, range 4-15%). */
  slope: -0.075,
  budgetSlope: -0.1,
  span: { lossless: 24, other: 12 },
  // 1.7x faster in WebAssembly. On 24-frame windows of the corpus its sizes are 1-6% above preset 8's (4-8%
  // spread), which doesn't show next to the windows' own error against whole encodes (21% spread either way).
  planPreset: '10',
  memory: (width, height) => 350 * scale(width, height),
  // 30 ms to decode, 430 ms to encode.
  decodeShare: 0.065,
  options: (crf, color) => {
    const options = ['8', '', `crf=${crf.toFixed(2)}`, 'ssim=1']
    if (color.primaries && SVT_PRIMARIES[color.primaries]) options.push(`color-primaries=${SVT_PRIMARIES[color.primaries]}`)
    if (color.transfer && SVT_TRANSFER[color.transfer]) options.push(`transfer-characteristics=${SVT_TRANSFER[color.transfer]}`)
    if (color.matrix && SVT_MATRIX[color.matrix]) options.push(`matrix-coefficients=${SVT_MATRIX[color.matrix]}`)
    options.push(`color-range=${color.fullRange ? 1 : 0}`)
    return options
  },
}

/** The encoder the settings ask for: AV1 when chosen, x264 otherwise. */
export const profileFor = (settings: Settings) => (settings.codec === 'av1' ? AV1 : X264)

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
  const profile = profileFor(settings)
  const cores = navigator.hardwareConcurrency || 4
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const budget = Math.min(3200, memoryGB * 1024 * 0.4)
  const encoders = Math.max(1, Math.min(cores, 8, Math.floor(budget / profile.memory(width, height))))
  // Two threads per encoder even when there are no spare cores: while an encoder's worker waits for decoded frames
  // and copies them in, its other thread keeps x264 busy. Measured 13% faster on a 4-core, 8-thread machine.
  // SVT-AV1's own threading starts dozens of threads per encoder, so AV1 runs one thread per encoder.
  const threads = canThread && profile.threaded ? Math.max(2, Math.min(4, Math.floor(cores / encoders))) : 1
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

export function presetCrf(settings: Settings) {
  return profileFor(settings).crf[settings.preset === 'copy' ? 'visually-lossless' : settings.preset]
}

async function encoderOptions(probe: Probe, settings: Settings, crf: number) {
  const { width, height } = outputSize(probe, settings.shortSide)
  let color: Color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
  // Resized frames go through an RGB canvas and come back as BT.709 limited range; others keep the source's.
  if (width === probe.width && height === probe.height) {
    const { input, track } = await openTrack(probe.file)
    try {
      const c = await track.getColorSpace()
      color = { primaries: c.primaries ?? undefined, transfer: c.transfer ?? undefined, matrix: c.matrix ?? undefined,
        fullRange: !!c.fullRange }
    } finally {
      input.dispose()
    }
  }
  return profileFor(settings).options(crf, color, width, height).join(';')
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
    divider?: Divider,
  ): Promise<EncodedChunk[]>
  terminate(): void
  /** x264 threads per encoder: what was asked for, or 1 if the threaded build couldn't start. */
  threads: number
}

type PoolInit = Omit<WorkerInit, 'type' | 'module' | 'script' | 'threads'>

/**
 * A chunk being encoded: frames that went into the encoder, frames that came out, and output frames per second
 * once enough have come out to tell.
 */
type Running = { index: number; fed: number; frames: number; rate?: number }
/**
 * Moves the ends of chunks that will finish late onto new chunks for the encoders that will finish first.
 * `propose` sees the running chunks once the queue is empty and returns where to cut (null until it can tell);
 * `accept` runs once a worker has agreed to stop at the cut, and returns the new chunk.
 */
type Divider = {
  propose: (running: Running[], workers: number) => { index: number; at: number }[] | null
  accept: (index: number, at: number) => WorkerChunk
}

/** Starts `size` encoders with `threads` x264 threads each, falling back to single-threaded encoders if the
 * threaded build doesn't start (it's the less travelled path, and some browsers limit nested workers). */
let threadsFailed = false

async function createPool(profile: Profile, size: number, threads: number, init: PoolInit): Promise<Pool> {
  if (threads > 1 && profile.threaded && !threadsFailed) {
    try {
      return await startPool(profile.threaded, size, threads, init, 20_000)
    } catch (err) {
      if (err instanceof Canceled) throw err
      threadsFailed = true
      console.warn(`[pare] threaded encoder unavailable, using one thread per encoder: ${err instanceof Error ? err.message : err}`)
    }
  }
  return startPool(profile.single, size, 1, init)
}

async function startPool(build: Build, size: number, threads: number, init: PoolInit, timeout?: number): Promise<Pool> {
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
    run: (chunks, onProgress, prepare, divider) =>
      new Promise((resolve, reject) => {
        abort = reject
        const queue = [...chunks]
        const results: EncodedChunk[] = []
        // Frames count a little when they enter the lookahead and the rest when x264 outputs them, so progress
        // moves from the start even though the first output waits for 40 frames of lookahead.
        const frames = new Map<number, number>()
        const running = new Map<Worker, Running>()
        /** When each running chunk's first output was reported, to measure its speed from there. */
        const clock = new Map<number, { time: number; frames: number }>()
        const idle: Worker[] = []
        let cuts: { index: number; at: number }[] | null = null
        let asking = false
        let pending = chunks.length
        const next = (worker: Worker) => {
          const chunk = queue.shift()
          if (!chunk) {
            idle.push(worker)
            return
          }
          running.set(worker, { index: chunk.index, fed: 0, frames: 0 })
          worker.postMessage(prepare ? prepare(chunk) : chunk)
        }
        // Cuts go to their workers one at a time; each worker says whether it can still stop there.
        const ask = () => {
          if (asking || !cuts?.length) return
          const cut = cuts.shift()!
          const worker = [...running].find(([, r]) => r.index === cut.index)?.[0]
          if (!worker) return ask()
          asking = true
          worker.postMessage({ type: 'split', ...cut } satisfies WorkerSplit)
        }
        for (const worker of workers) {
          worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
            const message = e.data
            if (message.type === 'progress') {
              const r = running.get(worker)
              if (r) {
                r.fed = message.fed
                r.frames = message.frames
                const now = performance.now()
                const start = clock.get(r.index)
                if (!start) {
                  if (r.frames > 0) clock.set(r.index, { time: now, frames: r.frames })
                } else if (r.frames - start.frames >= 16) {
                  r.rate = ((r.frames - start.frames) * 1000) / (now - start.time)
                }
              }
              if (divider && !cuts && !queue.length) {
                cuts = divider.propose([...running.values()], workers.length)
                ask()
              }
              frames.set(message.index, LOOKAHEAD_SHARE * message.fed + (1 - LOOKAHEAD_SHARE) * message.frames)
              onProgress([...frames.values()].reduce((s, n) => s + n, 0), message.stats, message.index)
            } else if (message.type === 'split') {
              asking = false
              if (message.ok) {
                pending++
                queue.push(divider!.accept(message.index, message.at))
                if (idle.length) next(idle.shift()!)
              }
              ask()
            } else if (message.type === 'done') {
              running.delete(worker)
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
 * steered by what earlier ones measured.
 *
 * Every chunk costs the same: its frames, plus the frames its decoder works through from the source keyframe before
 * its first one, at `decodeShare` of a frame each. Moving boundaries to source keyframes instead left chunks up to
 * 1.5x apart on phone footage with a keyframe every 50 frames, and every encoder waits for the longest one. Each
 * chunk reaching as far as the cost allows is optimal: a frame moved into a chunk costs a whole frame, while starting
 * the next chunk later costs at most a fraction of one in extra decoding.
 */
function planChunks({ times, keys }: Timeline, workers: number, decodeShare: number): WorkerChunk[] {
  const total = times.length
  const n = Math.max(1, Math.min(Math.max(workers, Math.min(6 * workers, Math.ceil(total / 240))), Math.floor(total / 30)))
  // Frames decoded before the first one used, for a chunk starting at each frame.
  const lead: number[] = []
  for (let i = 0, k = 0, key = 0; i < total; i++) {
    while (k < keys.length && keys[k] <= i) key = keys[k++]
    lead.push(i - key)
  }
  const split = (limit: number) => {
    const firsts = [0]
    for (let first = 0; total - first + decodeShare * lead[first] > limit; ) {
      const next = first + Math.max(15, Math.floor(limit - decodeShare * lead[first]))
      // A remainder too short to stand alone stays with this chunk.
      if (next > total - 15) break
      firsts.push((first = next))
    }
    return firsts
  }
  // The smallest per-chunk cost that covers the video in n chunks.
  let lo = total / n
  let hi = total / n + decodeShare * lead.reduce((a, b) => Math.max(a, b), 0) + 16
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2
    const firsts = split(mid)
    const last = firsts[firsts.length - 1]
    if (firsts.length <= n && total - last + decodeShare * lead[last] <= mid) hi = mid
    else lo = mid
  }
  const firsts = split(hi)
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

/**
 * The codec string for AV1 in MP4 ("av01.P.LLT.08"), from the sequence header OBU SVT-AV1 returns as its headers.
 * Mediabunny builds the av1C box from it; the sequence header itself travels in every keyframe. Reads profile, and
 * level and tier of operating point 0 (AV1 spec 5.5).
 */
function av1Config(headers: Uint8Array, width: number, height: number): VideoDecoderConfig {
  let bit = 0
  const read = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((headers[bit >> 3] >> (7 - (bit & 7))) & 1)
    return v
  }
  const uvlc = () => {
    let zeros = 0
    while (!read(1)) zeros++
    return zeros >= 32 ? 2 ** 32 - 1 : read(zeros) + 2 ** zeros - 1
  }
  const leb128 = () => {
    let v = 0
    for (let i = 0; i < 8; i++) {
      const byte = read(8)
      v += (byte & 0x7f) * 2 ** (7 * i)
      if (!(byte & 0x80)) break
    }
    return v
  }
  // OBU header: forbidden bit, type, extension flag, has_size_field, reserved.
  read(1)
  if (read(4) !== 1) throw new Error('The AV1 encoder returned no sequence header.')
  const extension = read(1)
  const hasSize = read(1)
  read(1)
  if (extension) read(8)
  if (hasSize) leb128()
  const profile = read(3)
  read(1) // still_picture
  let level = 0
  let tier = 0
  if (read(1)) {
    level = read(5) // reduced_still_picture_header
  } else {
    if (read(1)) {
      // timing_info, then decoder_model_info if present
      read(32)
      read(32)
      if (read(1)) uvlc()
      if (read(1)) {
        read(5)
        read(32)
        read(5)
        read(5)
      }
    }
    read(1) // initial_display_delay_present_flag
    read(5) // operating_points_cnt_minus_1
    read(12) // operating_point_idc[0]
    level = read(5)
    if (level > 7) tier = read(1)
  }
  const codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.08`
  return { codec, codedWidth: width, codedHeight: height }
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
  const profile = profileFor(settings)
  const video = new EncodedVideoPacketSource(profile.codec)
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

    const config = profile.config(chunks[0].headers, size.width, size.height)
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
  max: number
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
      crf = left <= 0 ? this.course.max : floor + Math.log(left / open) / slope
      // Move gradually: stay within 1.5 of the frame-weighted average so far. Sizes can change faster than the
      // assumed slope, and neighbouring chunks look best at similar settings.
      let weight = 0
      let sum = 0
      for (const [i, c] of this.started) (sum += c.crf * frames[i]), (weight += frames[i])
      const mean = sum / weight
      crf = Math.min(mean + 1.5, Math.max(mean - 1.5, crf))
    }
    crf = Math.min(this.course.max, Math.max(floor, crf))
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

/** What a chunk's opening keyframe costs over an ordinary frame, on average: the price of one more cut. */
function keyframeCost(chunks: EncodedChunk[]) {
  let keys = 0, rest = 0, count = 0
  for (const c of chunks)
    for (const p of c.packets) {
      if (p.pts === 0) {
        keys += p.data.byteLength
      } else {
        rest += p.data.byteLength
        count++
      }
    }
  return Math.max(0, keys / chunks.length - rest / Math.max(1, count))
}

/**
 * Chooses chunks to encode again so the video changes by `-excess` bytes. Too big: the biggest chunks go up first,
 * since they save the most per step and busy, complex footage hides the change best, and enough of them are taken
 * that the rise stays within 3 steps where it can. Far too small: every chunk above the floor comes down.
 */
function refit(chunks: EncodedChunk[], crfs: number[], excess: number, slope: number, floor: number, max: number) {
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
    crf: Math.min(max, Math.max(floor, crfs[c.index] + (excess > 0 ? Math.max(0.5, change) : change))),
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
  return settings.sizeTarget && settings.preset === 'visually-lossless' ? profileFor(settings).ceiling : presetCrf(settings)
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
      const profile = profileFor(settings)
      const floor = floorCrf(settings)
      const crf = Math.min(profile.max, Math.max(floor, start.crf ?? floor))
      const slope = start.slope && start.slope < -0.03 ? start.slope : profile.slope
      const [line, options] = await Promise.all([timeline(probe.file), encoderOptions(probe, settings, crf)])
      const { times } = line
      const { encoders, threads } = workerCount(probe, settings)
      const chunks = planChunks(line, encoders, profile.decodeShare)
      const countFrames = (c: WorkerChunk) => times.filter((t) => t >= c.start && t < c.end).length
      const frameCounts = chunks.map(countFrames)
      const active = Math.min(encoders, chunks.length)
      const cores = Math.min(navigator.hardwareConcurrency || active, active * threads)
      const fps = probe.fps || 30
      const init = { file: probe.file, options, width: size.width, height: size.height, fpsNum: Math.round(fps * 1000), fpsDen: 1000 }
      pool = await createPool(profile, active, threads, init)
      let poolThreads = pool.threads
      if (canceled) throw new Canceled()
      const audio = audioBytes(probe, settings)
      const goal = Math.max(probe.file.size * SIZE_AIM - audio, probe.file.size * 0.05)
      const limit = Math.max(probe.file.size * SIZE_TARGET - audio - 64e3, probe.file.size * 0.05)
      // A steeper slope than measured keeps the budget from overreaching when it lowers the rate factor: near the
      // sizes it lands on, noisy footage grows much faster than the plan's two distant tests suggest.
      const budget = settings.sizeTarget
        ? new Budget({ goal, frames: frameCounts, floor, max: profile.max, crf, slope: Math.min(slope, profile.budgetSlope) })
        : null
      const crfs: number[] = chunks.map(() => crf)
      /** Ends chunk `index` before the frame at `at`, and returns the rest as a new chunk. */
      const cut = (index: number, at: number) => {
        const rest: WorkerChunk = { type: 'chunk', index: chunks.length, start: at, end: chunks[index].end }
        const moved = countFrames(rest)
        frameCounts[index] -= moved
        frameCounts.push(moved)
        chunks[index] = { ...chunks[index], end: at }
        chunks.push(rest)
        crfs.push(crfs[index])
        return rest
      }
      /** Chunk `index` in `count` pieces of about the same length, the first keeping its index. */
      const cutInto = (index: number, count: number) => {
        const first = times.indexOf(chunks[index].start)
        const frames = frameCounts[index]
        const rest: WorkerChunk[] = []
        for (let j = count - 1; j >= 1; j--) rest.unshift(cut(index, times[first + Math.round((j * frames) / count)]))
        return [chunks[index], ...rest]
      }
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
      // Busy footage takes up to 1.5x longer per frame than calm footage, which splitting by frames can't know ahead,
      // and every encoder waits for the last chunk. Once each chunk has shown its speed, the ones that will finish
      // last hand the end of their frames to new chunks, for the encoders that will finish first: each cut where both
      // sides should finish together. It costs a keyframe per cut (~0.4% of the file).
      const divider: Divider = {
        propose: (running, workers) => {
          if (running.some((r) => !r.rate)) return null
          const left = running.map((r) => ({ r, seconds: (frameCounts[r.index] - r.frames) / r.rate! }))
          // When each encoder will be free: idle ones now, busy ones when their chunk ends.
          const free = [...Array<number>(Math.max(0, workers - running.length)).fill(0), ...left.map((l) => l.seconds)]
          const cuts: { index: number; at: number }[] = []
          for (const { r, seconds } of left.sort((a, b) => b.seconds - a.seconds)) {
            free.sort((a, b) => a - b)
            const helper = free[0]
            // The new chunk's decoder and encoder take about 4 frames' time to get going.
            const startup = 4 / r.rate!
            const moved = (seconds - helper - startup) / 2
            // The cut has to be past the frames already in the encoder, with a margin for reports every 8 frames.
            const give = Math.min(Math.floor(moved * r.rate!), frameCounts[r.index] - r.fed - 13)
            if (give < MIN_CUT.frames || moved < MIN_CUT.seconds) continue
            const at = times.indexOf(chunks[r.index].start) + frameCounts[r.index] - give
            cuts.push({ index: r.index, at: times[at] })
            free[0] = helper + startup + give / r.rate!
          }
          return cuts
        },
        accept: (index, at) => cut(index, at),
      }
      const encoded = await pool.run(
        spread(chunks, active),
        (frames, stats, index) => {
          budget?.add(index, stats)
          report(frames, 'encoding')
        },
        budget ? (chunk) => withCrf(chunk, budget.assign(chunk.index)) : undefined,
        divider,
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
        // A few chunks to redo would leave most encoders idle, and AV1 has no threads to give them: cut each chunk
        // into pieces so every encoder works (x264 keeps two threads per piece), and budget for the extra keyframes.
        const share = profile.threaded && canThread ? 2 : 1
        const piecesFor = (count: number, index: number) =>
          Math.max(1, Math.min(Math.floor(active / share / count), Math.floor(frameCounts[index] / 30)))
        const cuts = (list: { index: number }[]) => list.reduce((t, r) => t + piecesFor(list.length, r.index) - 1, 0)
        let redo = refit(encoded, crfs, total - goal, local, floor, profile.max)
        if (cuts(redo)) redo = refit(encoded, crfs, total - goal + cuts(redo) * keyframeCost(encoded), local, floor, profile.max)
        const again = redo.flatMap(({ index, crf: value }) =>
          cutInto(index, piecesFor(redo.length, index)).map((c) => withCrf(c, value)))
        finished += work - finished
        work = finished + again.reduce((t, c) => t + frameCounts[c.index], 0)
        // Fewer chunks than encoders: give each the cores the others would have used, as x264 threads.
        const spare = canThread ? Math.min(4, Math.floor((navigator.hardwareConcurrency || active) / again.length)) : 1
        if (spare > poolThreads) {
          pool.terminate()
          pool = await createPool(profile, again.length, spare, init)
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
      // Chunks split off during the encode come last by index; the file needs them in time order.
      const ordered = [...encoded].sort((a, b) => a.times[0] - b.times[0])
      const blob = await mux(probe, settings, ordered, size, rotation)
      onProgress({ fraction: 1, processed: probe.duration, elapsed: (performance.now() - started) / 1000 })
      const scores: FrameScores = { times: [], ssim: [] }
      for (const chunk of ordered)
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
  const [line, full] = await Promise.all([timeline(probe.file), encoderOptions(probe, settings, baseCrf)])
  const { times } = line
  const profile = profileFor(settings)
  const options = profile.planPreset ? full.replace(/^[^;]*/, profile.planPreset) : full
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
  const fixedKeyframes = planChunks(line, encoders, profile.decodeShare).length + Math.floor(times.length / 250)
  if (signal.aborted) throw new Canceled()
  const fps = probe.fps || 30
  const pool = await createPool(profile, count, threads, {
    file: probe.file, options, width: size.width, height: size.height, fpsNum: Math.round(fps * 1000), fpsDen: 1000,
  })
  const stop = () => pool.terminate()
  // Settings can change while the encoders start, and a listener added after the abort would never run.
  if (signal.aborted) {
    stop()
    throw new Canceled()
  }
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
    const lo = lossless ? profile.ceiling : baseCrf
    const hi = Math.min(profile.max, lo + (lossless ? profile.span.lossless : profile.span.other))
    const [atLo, atHi] = await videoAt([lo, hi])
    // Decide against the aim, not the target itself: estimates run up to ~10% low, and a file predicted at 48% could
    // land above half.
    const goal = Math.max(probe.file.size * SIZE_AIM - audio, probe.file.size * 0.05)
    // log(size) is close to linear in the rate factor; interpolate (or extrapolate) between the two tests.
    const measured = (Math.log(atHi) - Math.log(atLo)) / (hi - lo)
    const slope = measured < -0.03 ? measured : profile.slope
    console.info(`[pare] plan: ${(performance.now() - began) / 1000 | 0} s, ${windows.length}×${per} frames, ` +
      `crf ${lo} → ${(atLo / 1e6).toFixed(1)} MB, crf ${hi} → ${(atHi / 1e6).toFixed(1)} MB, slope ${slope.toFixed(3)}`)
    const points = [{ crf: lo, bytes: atLo }, { crf: hi, bytes: atHi }]
    if (atLo <= goal) return { crf: lo, size: atLo + audio, raised: false, fitted: false, slope, points }
    let crf = Math.min(profile.max, Math.max(lo, lo + (Math.log(goal) - Math.log(atLo)) / slope))
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
