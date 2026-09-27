import type { AudioCodec, VideoCodec, VideoSamplePixelFormat } from 'mediabunny'
import type { Origin } from './origin'

export type Preset = 'visually-lossless' | 'high' | 'compact' | 'copy'
export type OutputCodec = 'avc' | 'hevc' | 'av1'

/** 'thorough' runs x264 in WebAssembly; 'fast' uses the browser's built-in (often hardware) encoder. */
export type Engine = 'thorough' | 'fast'

export type Settings = {
  preset: Preset
  engine: Engine
  codec: OutputCodec
  /** Thorough only: test H.264 and AV1 on this video and keep the one that looks better at the target size. */
  autoCodec: boolean
  /** Target length of the short side in pixels, or null to keep the source resolution. */
  shortSide: number | null
  keepAudio: boolean
  /** Keep the result at or below a size (half the original's, or `targetBytes`), raising compression only when needed. */
  sizeTarget: boolean
  /** With the size target: the most the file may weigh, in bytes, or null for half the original. */
  targetBytes?: number | null
  /** Keep where the video was recorded, when its file says. The recording date is kept either way. */
  keepPlace?: boolean
  /** Only this part of the video, or null for all of it. */
  trim?: Trim | null
}

/**
 * A part of the video, in the source's own seconds (the clock of Probe.start and the frames' timestamps): from the
 * first frame kept to where the part ends, the timestamp of the first frame left out or the end of the video.
 */
export type Trim = { start: number; end: number }

/** Every video frame's timestamp, in order, with its size and whether it's a keyframe, from the container's index. */
export type FrameIndex = {
  times: Float64Array
  bytes: Float64Array
  /** Indexes into `times` of the keyframes. */
  keys: number[]
  /** All the frames' bytes. */
  total: number
}

export type Probe = {
  file: File
  /**
   * The source bytes being compressed: the file's size, or the share of it a trimmed part stands for (its video
   * frames, its length of audio, and the container in proportion). Half the size means half of this.
   */
  bytes: number
  /** The part being compressed (narrow), or null for the whole video. `start` and `duration` describe the part. */
  trim: Trim | null
  index: FrameIndex
  container: string
  duration: number
  firstTimestamp: number
  /** Where the copy's timeline starts: the earliest track's first timestamp, at least 0. `duration` runs from here. */
  start: number
  width: number
  height: number
  fps: number
  videoCodec: VideoCodec | null
  videoBitrate: number
  canDecode: boolean
  /** PQ or HLG. Wide-gamut SDR (Display P3, BT.2020 primaries on an SDR transfer) doesn't count. */
  hdr: boolean
  /** The source's colour tags: the container's, or the decoded frame's when the container has none. */
  colorSpace: VideoColorSpaceInit
  /**
   * One decoded frame: its pixel format and visible size, turned to display orientation. What the encoders will be
   * given, which the container tags can't say (an HLG video can be 8-bit, and a 10-bit one can decode to a format
   * WebCodecs doesn't name). Null when the browser can't decode the video. `copies`: copyTo gives it back as it is
   * (readback.ts), so frames can go into the encoders as decoded.
   */
  frame: { format: VideoSamplePixelFormat | null; width: number; height: number; copies: boolean } | null
  /** Whether this device decodes 10-bit AV1 at the source's size smoothly (only asked for 10-bit HDR sources). */
  playsHdrAv1: boolean
  audio: { codec: AudioCodec | null; bitrate: number; channels: number; sampleRate: number; plan: AudioPlan } | null
  poster: string | null
  encodable: Record<OutputCodec, boolean>
  origin: Origin
}

/** Audio codecs an MP4 can carry as they are. */
export const MP4_AUDIO: AudioCodec[] = ['aac', 'opus', 'mp3', 'ac3', 'eac3', 'flac']

/** How this browser can encode the audio: codec, and the channels and sample rate it takes. */
export type AudioEncode = {
  codec: 'aac' | 'opus'
  channels: number
  sampleRate: number
  bitrate: number
  /** The compact rate, for audio under a tight Fit under size (audioFor). */
  reduced?: boolean
}

/**
 * What Pare's own encoders do with the audio, decided when the file is opened so a compression can't fail at the end:
 * copy it (with how it could be encoded instead, when it can), encode it (mixed down or resampled where this browser's
 * encoder needs that), or leave it out.
 */
export type AudioPlan =
  | { kind: 'copy'; encode?: AudioEncode; compact?: AudioEncode }
  | ({ kind: 'encode'; compact?: AudioEncode } & AudioEncode)
  | { kind: 'drop'; reason: 'decode' | 'encode' }

/** The default size target: at most half the original. The first pass aims 6% under a target, for its errors. */
export const SIZE_TARGET = 0.5
export const SIZE_AIM = 0.47
/** The least the video may be given, as a share of the target, however much the audio takes. */
export const VIDEO_FLOOR = 0.1

/** The most the file may weigh: the size chosen, or half the original (of the part, for a trimmed one). */
export const targetBytes = (probe: Probe, settings: Settings) => settings.targetBytes ?? probe.bytes * SIZE_TARGET

/** What the first pass aims at: 6% under the target, as 47% is under half. */
export const aimBytes = (probe: Probe, settings: Settings) => targetBytes(probe, settings) * (SIZE_AIM / SIZE_TARGET)

/**
 * The audio plan for these settings, or null for none. With the size target, audio copied at more than twice what
 * encoding it takes, and over a quarter of the target (a lossless track in a music video), is encoded instead: copied,
 * it would leave the video little room or none.
 */
export function audioFor(probe: Probe, settings: Settings): AudioPlan | null {
  const audio = probe.audio
  if (!audio || !settings.keepAudio) return null
  const plan = audio.plan
  // Under a size chosen with Fit under, audio that would take over a quarter of it goes down to a compact rate
  // (48 kbps a channel, stereo at most) when that saves a fifth of it or more: a 142 kbps Opus track took 43% of
  // 164 KB, and H.264 missed by 7%.
  if (plan.kind !== 'drop' && plan.compact && settings.sizeTarget && settings.targetBytes && settings.preset !== 'copy') {
    const rate = plan.kind === 'copy' ? audio.bitrate : plan.bitrate
    if (rate > 1.25 * plan.compact.bitrate && (rate * probe.duration) / 8 > 0.25 * targetBytes(probe, settings))
      return { kind: 'encode', ...plan.compact }
  }
  if (plan.kind === 'copy' && plan.encode && settings.sizeTarget && settings.preset !== 'copy' &&
      audio.bitrate > 2 * plan.encode.bitrate && (audio.bitrate * probe.duration) / 8 > 0.25 * targetBytes(probe, settings))
    return { kind: 'encode', ...plan.encode }
  return plan
}

/** Bytes of audio in the output: copied at the source's rate, encoded at the plan's. */
export function audioBytes(probe: Probe, settings: Settings) {
  const plan = audioFor(probe, settings)
  if (!plan || plan.kind === 'drop') return 0
  return ((plan.kind === 'copy' ? probe.audio!.bitrate : plan.bitrate) * probe.duration) / 8
}

/** Whether the size target can be reached at all: the audio and container leave the video its floor. */
export const reachable = (probe: Probe, settings: Settings) =>
  aimBytes(probe, settings) - audioBytes(probe, settings) >= targetBytes(probe, settings) * VIDEO_FLOOR

/**
 * The settings the encoders get. Where the audio alone rules out half the size, squeezing the video to its floor would
 * only ruin it (a music video with lossless 8-channel audio came out at CRF 55 and still bigger than the original), so
 * it's encoded at the chosen quality instead.
 */
export const forEngine = (probe: Probe, settings: Settings): Settings =>
  settings.sizeTarget && !reachable(probe, settings) ? { ...settings, sizeTarget: false } : settings

export const CODEC_LABEL: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  prores: 'ProRes',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  flac: 'FLAC',
  vorbis: 'Vorbis',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
}

/** A codec's name for people: every PCM variant is just PCM. */
export const codecName = (codec: string | null | undefined) =>
  !codec ? 'Unknown' : codec.startsWith('pcm-') ? 'PCM' : (CODEC_LABEL[codec] ?? codec)

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export function outputSize(probe: Probe, shortSide: number | null) {
  const short = Math.min(probe.width, probe.height)
  if (!shortSide || shortSide >= short) return { width: even(probe.width), height: even(probe.height) }
  const scale = shortSide / short
  return { width: even(probe.width * scale), height: even(probe.height * scale) }
}

/** Pixel formats the encoders take as they are. Anything else goes through an RGB canvas. */
export const DIRECT_FORMATS: (VideoSamplePixelFormat | null)[] = ['NV12', 'I420', 'I420A', 'I420P10', 'I420P12']

/**
 * Whether the source's frames go into the encoder as decoded, keeping their colours and bit depth: planar 4:2:0, copied
 * in at the source's size or scaled plane by plane. Otherwise (RGB from Firefox's decoder, 4:2:2, 4:4:4) they're drawn
 * on an RGB canvas at the output size, which makes them 8-bit BT.709 SDR, and the output has to be tagged that way. So
 * are frames this browser doesn't copy out correctly (Probe.frame.copies).
 */
export const copiesFrames = (probe: Probe) => !!probe.frame?.copies && DIRECT_FORMATS.includes(probe.frame.format ?? null)

/** Whether decoded frames of this format carry more than 8 bits. */
export const deepFormat = (format: VideoSamplePixelFormat | null | undefined) => format === 'I420P10' || format === 'I420P12'

/**
 * Whether AV1 keeps this video HDR in 10 bits: PQ or HLG, decoded in 10 bits or more, copied in as it is, and
 * playable here. An 8-bit HDR source stays HDR in 8 bits, as it came.
 */
export const keepsHdr = (probe: Probe) =>
  probe.hdr && probe.playsHdrAv1 && deepFormat(probe.frame?.format) && copiesFrames(probe)

/**
 * Whether this device decodes AV1 at this size smoothly, in 10 bits when asked. Not whether it shows HDR: Chrome
 * reports HDR transfer functions unsupported on a screen without HDR, and still plays the file, tone-mapped.
 */
export async function playsAv1(width: number, height: number, fps: number, tenBit = false) {
  try {
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType: `video/mp4; codecs="av01.0.08M.${tenBit ? 10 : '08'}"`, width, height, bitrate: 8e6,
        framerate: fps || 30 },
    })
    return info.supported && info.smooth && (await decodesAv1(tenBit))
  } catch {
    return false
  }
}

/** A 64×64 grey AV1 keyframe from libaom, 27 bytes; byte 12 sets the bit depth (0x20: 8, 0x28: 10). */
const tinyAv1 = (tenBit: boolean) =>
  Uint8Array.from(`12000a0a00000002afff9b5f${tenBit ? 28 : 20}08320b1000f8000002c000000280`.match(/../g)!, (h) => parseInt(h, 16))

const decodes: Record<'8' | '10', Promise<boolean> | undefined> = { 8: undefined, 10: undefined }

/**
 * Whether AV1 actually decodes here, tried on a tiny keyframe. WebKit on Linux reports AV1 supported, 10-bit included,
 * and fails on every frame, which would make Auto write files this browser can't play.
 */
function decodesAv1(tenBit: boolean) {
  return (decodes[tenBit ? 10 : 8] ??= new Promise<boolean>((resolve) => {
    let frames = 0
    const decoder = new VideoDecoder({ output: (f) => (frames++, f.close()), error: () => resolve(false) })
    try {
      decoder.configure({ codec: `av01.0.00M.${tenBit ? 10 : '08'}` })
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: tinyAv1(tenBit) }))
      decoder.flush().then(() => resolve(frames > 0), () => resolve(false)).finally(() => decoder.state !== 'closed' && decoder.close())
    } catch {
      resolve(false)
    }
  }))
}

/** The first index in sorted `times` at or after `t`, allowing for float rounding. */
function firstAtOrAfter(times: Float64Array, t: number) {
  let lo = 0, hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t - 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Frames of the index in a part: from `first` up to, not including, `last`. */
export function framesIn(index: FrameIndex, trim: Trim) {
  return { first: firstAtOrAfter(index.times, trim.start), last: firstAtOrAfter(index.times, trim.end) }
}

/** Where the video ends: the last track's end, in the source's seconds. */
export const endOf = (probe: Probe) => probe.start + probe.duration

/** The shortest part Pare compresses, in seconds. */
export const MIN_PART = 1

/**
 * A part from `from` to `to` (seconds on the source's clock) snapped to frames: it starts with the frame shown at
 * `from` and ends where the first frame at or after `to` starts, or where the video does. A part's own end snaps to
 * itself. Null for the whole video. Whether the part is long enough is the caller's to check (MIN_PART).
 */
export function snapTrim(probe: Probe, from: number, to: number): Trim | null {
  const { times } = probe.index
  if (!times.length) return null
  const first = Math.max(0, firstAtOrAfter(times, from + 2e-6) - 1)
  const after = firstAtOrAfter(times, to)
  if (first === 0 && after >= times.length) return null
  return { start: times[first], end: after < times.length ? times[after] : endOf(probe) }
}

/**
 * The probe for the part of the video these settings compress: its start, length, bitrate and bytes. The same probe
 * when the whole video is compressed, so nothing changes there.
 */
export function narrow(probe: Probe, settings: Settings): Probe {
  const trim = settings.trim
  if (!trim || probe.trim) return probe
  const { index } = probe
  const { first, last } = framesIn(index, trim)
  let video = 0
  for (let i = first; i < last; i++) video += index.bytes[i]
  const duration = Math.min(trim.end, endOf(probe)) - trim.start
  const audioRate = probe.audio?.bitrate ?? 0
  const whole = index.total + (audioRate * probe.duration) / 8
  const part = video + (audioRate * duration) / 8
  return {
    ...probe,
    trim,
    start: trim.start,
    duration,
    firstTimestamp: index.times[first] ?? trim.start,
    videoBitrate: duration > 0 ? (video * 8) / duration : 0,
    bytes: whole > 0 ? (probe.file.size * part) / whole : (probe.file.size * duration) / probe.duration,
  }
}
