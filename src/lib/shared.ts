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
  audio: { codec: AudioCodec | null; bitrate: number; channels: number; sampleRate: number } | null
  poster: string | null
  encodable: Record<OutputCodec, boolean>
}

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
 * Whether the source's frames go into the encoder as decoded, keeping their colours and bit depth: at the source's
 * own size and in a planar 4:2:0 format. Otherwise they're drawn on an RGB canvas at the output size, which makes them
 * 8-bit BT.709 SDR, and the output has to be tagged that way.
 */
export function copiesFrames(probe: Probe, settings: Settings) {
  const { width, height } = outputSize(probe, settings.shortSide)
  const frame = probe.frame
  return !!frame && DIRECT_FORMATS.includes(frame.format) && frame.width === width && frame.height === height
}

/** Whether decoded frames of this format carry more than 8 bits. */
export const deepFormat = (format: VideoSamplePixelFormat | null | undefined) => format === 'I420P10' || format === 'I420P12'

/**
 * Whether AV1 keeps this video HDR in 10 bits: PQ or HLG, decoded in 10 bits or more, copied in as it is, and
 * playable here. An 8-bit HDR source stays HDR in 8 bits, as it came.
 */
export const keepsHdr = (probe: Probe, settings: Settings) =>
  probe.hdr && probe.playsHdrAv1 && deepFormat(probe.frame?.format) && copiesFrames(probe, settings)

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
    return info.supported && info.smooth
  } catch {
    return false
  }
}
