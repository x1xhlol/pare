import type { AudioCodec, VideoCodec, VideoSamplePixelFormat } from 'mediabunny'

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
  /** Keep the result at or below half the original's size, raising compression only when needed. */
  sizeTarget: boolean
}

export type Probe = {
  file: File
  container: string
  duration: number
  firstTimestamp: number
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
   * WebCodecs doesn't name). Null when the browser can't decode the video.
   */
  frame: { format: VideoSamplePixelFormat | null; width: number; height: number } | null
  /** Whether this device decodes 10-bit AV1 at the source's size smoothly (only asked for 10-bit HDR sources). */
  playsHdrAv1: boolean
  audio: { codec: AudioCodec | null; bitrate: number; channels: number; sampleRate: number; plan: AudioPlan } | null
  poster: string | null
  encodable: Record<OutputCodec, boolean>
}

/** Audio codecs an MP4 can carry as they are. */
export const MP4_AUDIO: AudioCodec[] = ['aac', 'opus', 'mp3', 'ac3', 'eac3', 'flac']

/** How this browser can encode the audio: codec, and the channels and sample rate it takes. */
export type AudioEncode = { codec: 'aac' | 'opus'; channels: number; sampleRate: number; bitrate: number }

/**
 * What Pare's own encoders do with the audio, decided when the file is opened so a compression can't fail at the end:
 * copy it (with how it could be encoded instead, when it can), encode it (mixed down or resampled where this browser's
 * encoder needs that), or leave it out.
 */
export type AudioPlan =
  | { kind: 'copy'; encode?: AudioEncode }
  | ({ kind: 'encode' } & AudioEncode)
  | { kind: 'drop'; reason: 'decode' | 'encode' }

/** The size target: at most half the original. Steering aims a little lower to absorb its error at the very end. */
export const SIZE_TARGET = 0.5
export const SIZE_AIM = 0.47
/** The least the video may be given, as a share of the original, however much the audio takes. */
export const VIDEO_FLOOR = 0.05

/**
 * The audio plan for these settings, or null for none. With the size target, audio copied at more than twice what
 * encoding it takes, and over a quarter of the target (a lossless track in a music video), is encoded instead: copied,
 * it would leave the video little room or none.
 */
export function audioFor(probe: Probe, settings: Settings): AudioPlan | null {
  const audio = probe.audio
  if (!audio || !settings.keepAudio) return null
  const plan = audio.plan
  if (plan.kind === 'copy' && plan.encode && settings.sizeTarget && settings.preset !== 'copy' &&
      audio.bitrate > 2 * plan.encode.bitrate && (audio.bitrate * probe.duration) / 8 > 0.25 * SIZE_TARGET * probe.file.size)
    return { kind: 'encode', ...plan.encode }
  return plan
}

/** Bytes of audio in the output: copied at the source's rate, encoded at the plan's. */
export function audioBytes(probe: Probe, settings: Settings) {
  const plan = audioFor(probe, settings)
  if (!plan || plan.kind === 'drop') return 0
  return ((plan.kind === 'copy' ? probe.audio!.bitrate : plan.bitrate) * probe.duration) / 8
}

/** Whether half the size can be reached at all: the audio and container leave the video its floor. */
export const halvable = (probe: Probe, settings: Settings) =>
  probe.file.size * SIZE_AIM - audioBytes(probe, settings) >= probe.file.size * VIDEO_FLOOR

/**
 * The settings the encoders get. Where the audio alone rules out half the size, squeezing the video to its floor would
 * only ruin it (a music video with lossless 8-channel audio came out at CRF 55 and still bigger than the original), so
 * it's encoded at the chosen quality instead.
 */
export const forEngine = (probe: Probe, settings: Settings): Settings =>
  settings.sizeTarget && !halvable(probe, settings) ? { ...settings, sizeTarget: false } : settings

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
const DIRECT_FORMATS: (VideoSamplePixelFormat | null)[] = ['NV12', 'I420', 'I420A', 'I420P10', 'I420P12']

/**
 * Whether the source's frames go into the encoder as decoded, keeping their colours and bit depth: planar 4:2:0, copied
 * in at the source's size or scaled plane by plane. Otherwise (RGB from Firefox's decoder, 4:2:2, 4:4:4) they're drawn
 * on an RGB canvas at the output size, which makes them 8-bit BT.709 SDR, and the output has to be tagged that way.
 */
export const copiesFrames = (probe: Probe) => DIRECT_FORMATS.includes(probe.frame?.format ?? null)

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
