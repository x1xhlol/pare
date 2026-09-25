import type { AudioCodec, VideoCodec } from 'mediabunny'

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
  hdr: boolean
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

