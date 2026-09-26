import {
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  MATROSKA,
  MkvOutputFormat,
  MP4,
  Mp4OutputFormat,
  Output,
  PCM_AUDIO_CODECS,
  QTFF,
  Quality,
  StreamTarget,
  WEBM,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  type InputVideoTrack,
} from 'mediabunny'
import { lumaOf, psnr, ssim } from './metrics'
import { even, outputSize, type OutputCodec, type Preset, type Probe, type Settings } from './shared'

type EncodingPreset = Exclude<Preset, 'copy'>

/** Mean luma SSIM each preset must reach on the calibration samples. */
export const SSIM_TARGET: Record<EncodingPreset, number> = {
  'visually-lossless': 0.985,
  high: 0.97,
  compact: 0.95,
}

// Starting guess for the bitrate search, in bits per pixel per frame.
const START_BPP: Record<OutputCodec, Record<EncodingPreset, number>> = {
  avc: { 'visually-lossless': 0.15, high: 0.09, compact: 0.05 },
  hevc: { 'visually-lossless': 0.1, high: 0.06, compact: 0.035 },
  av1: { 'visually-lossless': 0.08, high: 0.05, compact: 0.028 },
}

// The output must stay meaningfully smaller than the source to be worth downloading.
const MAX_SHARE_OF_SOURCE = 0.9
const MAX_ROUNDS = 5
const MEASURE_MAX_SIDE = 1920

const openInput = (file: Blob) => new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA] })

const isPcm = (codec: AudioCodec | null) => !!codec && (PCM_AUDIO_CODECS as readonly string[]).includes(codec)

export async function probeFile(file: File): Promise<Probe> {
  const input = openInput(file)
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('This file has no video track.')

    const [format, duration, videoCodec, width, height, canDecode, hdr, stats] = await Promise.all([
      input.getFormat(),
      input.computeDuration(),
      video.getCodec(),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.canDecode(),
      video.hasHighDynamicRange(),
      video.computePacketStats(),
    ])
    const firstTimestamp = Math.max(0, await video.getFirstTimestamp())

    const audioTrack = await input.getPrimaryAudioTrack()
    const audio = audioTrack
      ? {
          codec: await audioTrack.getCodec(),
          bitrate: (await audioTrack.computePacketStats(500)).averageBitrate,
          channels: await audioTrack.getNumberOfChannels(),
          sampleRate: await audioTrack.getSampleRate(),
        }
      : null

    const encodable = Object.fromEntries(
      await Promise.all(
        (['avc', 'hevc', 'av1'] as const).map(async (codec) => [
          codec,
          await canEncodeVideo(codec, { width: even(width), height: even(height) }).catch(() => false),
        ]),
      ),
    ) as Record<OutputCodec, boolean>

    const poster = canDecode ? await renderPoster(video, firstTimestamp + Math.min(1, duration * 0.1)) : null

    return {
      file,
      container: format.name,
      duration,
      firstTimestamp,
      width,
      height,
      fps: stats.averagePacketRate,
      videoCodec,
      videoBitrate: stats.averageBitrate,
      canDecode,
      hdr,
      audio,
      poster,
      encodable,
    }
  } finally {
    input.dispose()
  }
}

async function renderPoster(track: InputVideoTrack, timestamp: number) {
  const sink = new CanvasSink(track, { width: 640 })
  const frame = (await sink.getCanvas(timestamp)) ?? (await sink.getCanvas(await track.getFirstTimestamp()))
  if (!frame || !(frame.canvas instanceof HTMLCanvasElement)) return null
  const canvas = frame.canvas
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  return blob ? URL.createObjectURL(blob) : null
}

function videoOptions(probe: Probe, settings: Settings, bitrate: number): ConversionVideoOptions {
  if (settings.preset === 'copy') return {}
  const { width, height } = outputSize(probe, settings.shortSide)
  return {
    codec: settings.codec,
    width,
    height,
    fit: 'fill',
    forceTranscode: true,
    quality: new Quality({ bitrate: Math.round(bitrate), bitrateMode: 'variable' }),
  }
}

async function audioOptions(probe: Probe, settings: Settings): Promise<ConversionAudioOptions> {
  if (!settings.keepAudio) return { discard: true }
  if (settings.preset === 'copy' || !isPcm(probe.audio?.codec ?? null)) return {}
  const codec: AudioCodec = (await canEncodeAudio('aac')) ? 'aac' : 'opus'
  return { codec, quality: new Quality('high') }
}

function audioBytes(probe: Probe, settings: Settings) {
  if (!settings.keepAudio || !probe.audio) return 0
  const bps = settings.preset !== 'copy' && isPcm(probe.audio.codec) ? 128_000 * probe.audio.channels : probe.audio.bitrate
  return (bps * probe.duration) / 8
}

function outputFormat(probe: Probe, settings: Settings) {
  const mp4 = new Mp4OutputFormat({ fastStart: 'in-memory' })
  if (settings.preset !== 'copy') return mp4
  const fits = probe.videoCodec && mp4.getSupportedCodecs().includes(probe.videoCodec)
  return fits ? mp4 : new MkvOutputFormat()
}

function describeFailure(conversion: Conversion) {
  const reasons = conversion.discardedTracks.map((d) => `${d.track.type} track: ${d.reason}`)
  return reasons.length ? `Can't convert this file (${reasons.join('; ')}).` : "Can't convert this file."
}

function measureSize(outW: number, outH: number) {
  const scale = Math.min(1, MEASURE_MAX_SIDE / Math.max(outW, outH))
  return { width: even(outW * scale), height: even(outH * scale), fit: 'fill' as const }
}

export type Calibration = {
  bitrate: number
  /** Predicted size of the finished file in bytes. */
  size: number
  ssim: number
  target: number
  /** False when even the largest allowed bitrate fell short of the target. */
  reached: boolean
  /** Set when the size comes from x264 at a constant rate factor instead of a bitrate search. */
  crf?: number
  /** True when the rate factor was raised to meet the size target. */
  raised?: boolean
  /** Visually lossless with the size target: tuned to fill the budget (true) or at the quality ceiling (false). */
  fitted?: boolean
  /** x264 only: measured change in log size per rate factor step, and predicted video bytes at tested rate factors. */
  slope?: number
  points?: { crf: number; bytes: number }[]
  /** x264 only: plan test windows the encode can keep, and whether it runs at the superfast preset. */
  reuse?: import('./x264').Reusable[]
  fast?: boolean
  /** Auto: the encoder the in-browser test picked, why, and each one's predicted VMAF NEG at the target size. */
  codec?: 'avc' | 'av1'
  choice?: {
    /** testing: H.264's plan so far, while AV1's test runs. */
    reason: 'unlimited' | 'fits' | 'high' | 'device' | 'size' | 'better' | 'even' | 'testing'
    vmaf?: { avc: number; av1?: number }
  }
}

type Segment = {
  start: number
  end: number
  /** Source luma for a few frames inside the segment. */
  frames: { timestamp: number; duration: number; luma: Uint8Array }[]
}

/**
 * Encodes short samples of the video at different bitrates and measures each against the source, searching for the
 * lowest bitrate that meets the preset's SSIM target on this browser's encoder.
 */
export async function calibrate(
  probe: Probe,
  settings: Settings,
  signal: AbortSignal,
  onRound: (round: number) => void,
): Promise<Calibration> {
  const extra = audioBytes(probe, settings)
  if (settings.preset === 'copy') {
    const size = (probe.videoBitrate * probe.duration) / 8 + extra
    return { bitrate: probe.videoBitrate, size, ssim: 1, target: 1, reached: true }
  }

  const { width, height } = outputSize(probe, settings.shortSide)
  const size = measureSize(width, height)
  const fps = probe.fps || 30
  const target = SSIM_TARGET[settings.preset]
  // Some containers don't report a usable bitrate; fall back to a generous per-pixel budget.
  const share = settings.sizeTarget ? 0.45 : MAX_SHARE_OF_SOURCE
  const ceiling = probe.videoBitrate > 0 ? probe.videoBitrate * share : width * height * fps * 0.4
  const floor = Math.min(ceiling, 150_000)
  const clampRate = (b: number) => Math.min(ceiling, Math.max(floor, b))

  const segments = await sampleSource(probe, size)
  const sampled = segments.reduce((s, seg) => s + seg.end - seg.start, 0)

  type Trial = { bitrate: number; bytes: number; ssim: number }
  const tried: Trial[] = []
  const lowestPass = () => tried.filter((t) => t.ssim >= target).sort((a, b) => a.bitrate - b.bitrate)[0]
  const highestFail = () => tried.filter((t) => t.ssim < target).sort((a, b) => b.bitrate - a.bitrate)[0]
  let bitrate = clampRate(width * height * fps * START_BPP[settings.codec][settings.preset])

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    onRound(round)
    tried.push({ bitrate, ...(await trial(probe, settings, segments, size, bitrate, signal)) })

    const pass = lowestPass()
    const fail = highestFail()
    if (!pass && bitrate >= ceiling) break
    if (pass && pass.ssim - target < 0.002) break
    if (pass && fail && pass.bitrate / fail.bitrate < 1.1) break

    // Treat 1 − SSIM as a power law in bitrate and solve for the target using the two most informative trials.
    const pair = pass && fail ? [pass, fail] : tried.slice(-2)
    let next: number
    if (pair.length === 2 && pair[0].bitrate !== pair[1].bitrate) {
      const [p, q] = pair
      const k = Math.log((1 - p.ssim) / (1 - q.ssim)) / Math.log(p.bitrate / q.bitrate)
      const slope = Number.isFinite(k) ? Math.min(-0.25, Math.max(-3, k)) : -1
      next = p.bitrate * ((1 - target) / (1 - p.ssim)) ** (1 / slope)
    } else {
      next = pass ? bitrate * 0.6 : bitrate * 1.8
    }
    if (pass && fail) next = Math.min(pass.bitrate * 0.97, Math.max(fail.bitrate * 1.03, next))
    next = clampRate(next)
    if (tried.some((t) => Math.abs(t.bitrate - next) / next < 0.03)) break
    bitrate = next
  }

  const pick = lowestPass() ?? [...tried].sort((a, b) => b.ssim - a.ssim)[0]
  return {
    bitrate: pick.bitrate,
    size: (pick.bytes / sampled) * probe.duration + extra,
    ssim: pick.ssim,
    target,
    reached: pick.ssim >= target,
  }
}

async function sampleSource(probe: Probe, size: { width: number; height: number; fit: 'fill' }): Promise<Segment[]> {
  const count = probe.duration >= 24 ? 3 : probe.duration >= 8 ? 2 : 1
  const length = Math.min(2, probe.duration / count)
  const input = openInput(probe.file)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('Missing video track.')
    const sink = new CanvasSink(track, size)
    const segments: Segment[] = []
    for (let i = 0; i < count; i++) {
      const center = probe.firstTimestamp + ((i + 0.5) / count) * probe.duration
      const start = Math.max(probe.firstTimestamp, center - length / 2)
      const segment: Segment = { start, end: start + length, frames: [] }
      for (const at of [0.3, 0.7]) {
        const frame = await sink.getCanvas(start + length * at)
        if (frame && frame.timestamp >= start) {
          segment.frames.push({
            timestamp: frame.timestamp,
            duration: frame.duration,
            luma: lumaOf(frame.canvas, size.width, size.height),
          })
        }
      }
      segments.push(segment)
    }
    return segments
  } finally {
    input.dispose()
  }
}

async function trial(
  probe: Probe,
  settings: Settings,
  segments: Segment[],
  size: { width: number; height: number; fit: 'fill' },
  bitrate: number,
  signal: AbortSignal,
) {
  const results = await Promise.all(
    segments.map(async (segment) => {
      const input = openInput(probe.file)
      const target = new BufferTarget()
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })
      try {
        const conversion = await Conversion.init({
          input,
          output,
          tracks: 'primary',
          video: videoOptions(probe, settings, bitrate),
          audio: { discard: true },
          trim: { start: segment.start, end: segment.end },
          showWarnings: false,
        })
        if (!conversion.isValid) throw new Error(describeFailure(conversion))
        const abort = () => void conversion.cancel()
        signal.addEventListener('abort', abort)
        try {
          await conversion.execute()
        } finally {
          signal.removeEventListener('abort', abort)
        }
      } finally {
        input.dispose()
      }

      const buffer = target.buffer!
      const encoded = openInput(new Blob([buffer]))
      try {
        const track = await encoded.getPrimaryVideoTrack()
        if (!track) throw new Error('Encoded sample has no video.')
        const sink = new CanvasSink(track, size)
        const scores: number[] = []
        for (const f of segment.frames) {
          const frame = await sink.getCanvas(f.timestamp - segment.start + f.duration / 2)
          if (frame) scores.push(ssim(f.luma, lumaOf(frame.canvas, size.width, size.height), size.width, size.height))
        }
        return { bytes: buffer.byteLength, scores }
      } finally {
        encoded.dispose()
      }
    }),
  )
  const scores = results.flatMap((r) => r.scores)
  if (!scores.length) throw new Error('Could not measure the encoded samples.')
  return {
    bytes: results.reduce((s, r) => s + r.bytes, 0),
    ssim: scores.reduce((s, x) => s + x, 0) / scores.length,
  }
}

export type Progress = {
  fraction: number
  processed: number
  elapsed: number
  workers?: number
  stage?: 'encoding' | 'finishing'
}

export type Job = {
  promise: Promise<{ blob: Blob; scores?: { times: number[]; ssim: number[] } }>
  cancel: () => void
}

export function compress(probe: Probe, settings: Settings, bitrate: number, onProgress: (p: Progress) => void): Job {
  let conversion: Conversion | null = null
  let canceled = false

  const promise = (async () => {
    const input = openInput(probe.file)
    const format = outputFormat(probe, settings)
    const parts: Uint8Array<ArrayBuffer>[] = []
    let written = 0
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array<ArrayBuffer>; position: number }>({
      write(chunk) {
        if (chunk.position !== written) throw new Error('Output was written out of order.')
        parts.push(chunk.data)
        written += chunk.data.byteLength
      },
    })
    const output = new Output({ format, target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 2 ** 20 }) })

    try {
      conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        video: videoOptions(probe, settings, bitrate),
        audio: await audioOptions(probe, settings),
        showWarnings: false,
      })
      if (canceled) await conversion.cancel()
      if (!conversion.isValid) throw new Error(describeFailure(conversion))

      const started = performance.now()
      conversion.onProgress = (fraction, processed) =>
        onProgress({ fraction, processed, elapsed: (performance.now() - started) / 1000 })
      await conversion.execute()
      return { blob: new Blob(parts, { type: format.mimeType }) }
    } finally {
      input.dispose()
    }
  })()

  return {
    promise,
    cancel: () => {
      canceled = true
      void conversion?.cancel()
    },
  }
}

export type FramePair = {
  time: number
  original: ImageBitmap
  compressed: ImageBitmap
  ssim: number
  psnr: number
}

export type QualityReport = {
  /** Mean SSIM: over every frame when the encoder scored them, else over the sampled frames. */
  ssim: number
  /** Lowest single-frame SSIM seen. */
  min: number
  /** How many frames the SSIM figures cover. */
  scored: number
  psnr: number
  frames: FramePair[]
}

/** Frames to show side by side: the worst-scoring ones (kept apart from each other) plus an even spread. */
function pickFrames(probe: Probe, scores: { times: number[]; ssim: number[] } | undefined, count: number) {
  const even = Array.from({ length: count }, (_, i) => probe.firstTimestamp + ((i + 0.5) / count) * probe.duration)
  if (!scores?.times.length) return even
  const gap = probe.duration / (count * 1.5)
  const order = scores.ssim.map((_, i) => i).sort((a, b) => scores.ssim[a] - scores.ssim[b])
  const worst: number[] = []
  for (const i of order) {
    const t = scores.times[i]
    if (worst.every((w) => Math.abs(w - t) >= gap)) worst.push(t)
    if (worst.length === Math.ceil(count / 2)) break
  }
  const picks = [...worst]
  for (const t of even) if (picks.length < count && picks.every((p) => Math.abs(p - t) >= gap / 2)) picks.push(t)
  return picks.sort((a, b) => a - b)
}

/**
 * Decodes matching frames from both files for the side-by-side view and scores them. When the encoder scored every
 * frame, those scores are the headline numbers and the view opens on the weakest frames.
 */
export async function measureQuality(
  probe: Probe,
  result: Blob,
  scores?: { times: number[]; ssim: number[] },
  count = 8,
): Promise<QualityReport> {
  const source = openInput(probe.file)
  const encoded = openInput(result)
  try {
    const [a, b] = await Promise.all([source.getPrimaryVideoTrack(), encoded.getPrimaryVideoTrack()])
    if (!a || !b) throw new Error('Missing video track.')
    const size = measureSize(await b.getDisplayWidth(), await b.getDisplayHeight())
    const sinkA = new CanvasSink(a, size)
    const sinkB = new CanvasSink(b, size)
    // The conversion trims to the first timestamp, so encoded time = source time − offset.
    const offset = probe.firstTimestamp - Math.max(0, await b.getFirstTimestamp())

    const frames: FramePair[] = []
    for (const t of pickFrames(probe, scores, count)) {
      const original = await sinkA.getCanvas(t)
      if (!original) continue
      // Sample the encoded file mid-frame so a rounding difference can't pick the neighbouring frame.
      const compressed = await sinkB.getCanvas(original.timestamp - offset + original.duration / 2)
      if (!compressed) continue
      const ya = lumaOf(original.canvas, size.width, size.height)
      const yb = lumaOf(compressed.canvas, size.width, size.height)
      frames.push({
        time: original.timestamp - probe.firstTimestamp,
        original: await createImageBitmap(original.canvas),
        compressed: await createImageBitmap(compressed.canvas),
        ssim: ssim(ya, yb, size.width, size.height),
        psnr: psnr(ya, yb),
      })
    }
    if (!frames.length) throw new Error('Could not decode frames to compare.')
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    const all = scores?.ssim.length ? scores.ssim : frames.map((f) => f.ssim)
    return {
      ssim: mean(all),
      min: Math.min(...all),
      scored: all.length,
      psnr: mean(frames.map((f) => Math.min(f.psnr, 99))),
      frames,
    }
  } finally {
    source.dispose()
    encoded.dispose()
  }
}
