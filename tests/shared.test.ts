import { expect, test } from 'bun:test'
import {
  aimBytes, audioBytes, audioFor, codecName, copiesFrames, forEngine, keepsHdr, outputSize, reachable, targetBytes,
  type AudioPlan, type Probe,
  type Settings,
} from '../src/lib/shared'

const settings: Settings = { preset: 'visually-lossless', engine: 'thorough', codec: 'avc', autoCodec: true, shortSide: null,
  keepAudio: true, sizeTarget: true }

/** A 10 s 1080p video of `size` bytes with audio at `bitrate` bits a second. */
function probe(size: number, bitrate: number, plan: AudioPlan, extra: Partial<Probe> = {}): Probe {
  return {
    file: { size } as File, container: 'MP4', duration: 10, firstTimestamp: 0, start: 0, width: 1920, height: 1080, fps: 30,
    videoCodec: 'avc', videoBitrate: 8e6, canDecode: true, hdr: false, colorSpace: {},
    frame: { format: 'I420', width: 1920, height: 1080, copies: true }, playsHdrAv1: false,
    audio: { codec: 'flac', bitrate, channels: 2, sampleRate: 48000, plan }, poster: null,
    encodable: { avc: true, hevc: false, av1: true }, origin: { date: null, place: null }, ...extra,
  }
}
const opus = { codec: 'opus' as const, channels: 2, sampleRate: 48000, bitrate: 192_000 }

test('ordinary audio is copied', () => {
  const p = probe(20e6, 256_000, { kind: 'copy', encode: opus })
  expect(audioFor(p, settings)?.kind).toBe('copy')
  expect(audioBytes(p, settings)).toBe(320_000)
})

test('audio that would take most of the size target is encoded instead, only with the target on', () => {
  // 10 s of 4 Mbps lossless audio (5 MB) in a 20 MB file: over a quarter of the 10 MB target, and over twice Opus's rate.
  const p = probe(20e6, 4e6, { kind: 'copy', encode: opus })
  expect(audioFor(p, settings)?.kind).toBe('encode')
  expect(audioBytes(p, settings)).toBe(240_000)
  expect(audioFor(p, { ...settings, sizeTarget: false })?.kind).toBe('copy')
  expect(audioFor(p, { ...settings, preset: 'copy' })?.kind).toBe('copy')
  // No way to encode it here: copied.
  expect(audioFor(probe(20e6, 4e6, { kind: 'copy' }), settings)?.kind).toBe('copy')
})

test('under a chosen size, audio taking over a quarter of it goes down to the compact rate', () => {
  const compact = { codec: 'opus' as const, channels: 2, sampleRate: 48000, bitrate: 96_000 }
  // 10 s of 142 kbps audio (178 KB) under 400 KB: 44% of it.
  const p = probe(20e6, 142_000, { kind: 'copy', encode: opus, compact })
  const fit = { ...settings, targetBytes: 400_000 }
  expect(audioFor(p, fit)).toMatchObject({ kind: 'encode', bitrate: 96_000 })
  expect(audioBytes(p, fit)).toBe(120_000)
  // Half the original, or a size the audio barely dents, keep the copy.
  expect(audioFor(p, settings)?.kind).toBe('copy')
  expect(audioFor(p, { ...settings, targetBytes: 5e6 })?.kind).toBe('copy')
  // Audio already near the compact rate isn't encoded again.
  expect(audioFor(probe(20e6, 110_000, { kind: 'copy', encode: opus, compact }), fit)?.kind).toBe('copy')
  // Encoded audio (an MP4 can't carry the source's) takes the compact rate too.
  expect(audioFor(probe(20e6, 1.4e6, { kind: 'encode', ...opus, compact }), fit)).toMatchObject({ bitrate: 96_000 })
})

test('no audio, audio removed, or audio this browser can\'t decode count for nothing', () => {
  expect(audioBytes(probe(20e6, 256_000, { kind: 'drop', reason: 'decode' }), settings)).toBe(0)
  expect(audioBytes(probe(20e6, 256_000, { kind: 'copy' }), { ...settings, keepAudio: false })).toBe(0)
  expect(audioFor(probe(20e6, 256_000, { kind: 'copy' }, { audio: null }), settings)).toBeNull()
})

test('the size target is dropped only when the audio alone rules out half the size', () => {
  // A podcast: a still picture (60 KB of video) and 200 KB of AAC at 160 kbps, under twice Opus's rate, so copied.
  const podcast = probe(260_000, 160_000, { kind: 'copy', encode: opus })
  expect(audioFor(podcast, settings)?.kind).toBe('copy')
  expect(reachable(podcast, settings)).toBe(false)
  expect(forEngine(podcast, settings).sizeTarget).toBe(false)
  const ordinary = probe(20e6, 256_000, { kind: 'copy', encode: opus })
  expect(reachable(ordinary, settings)).toBe(true)
  expect(forEngine(ordinary, settings)).toBe(settings)
  // Lossless audio at 1.28 Mbps would rule it out copied, but encoded it leaves the video room.
  expect(reachable(probe(2.6e6, 1.28e6, { kind: 'copy', encode: opus }), settings)).toBe(true)
})

test('frames go in as planes only in planar 4:2:0 formats, at any size', () => {
  const p = (format: VideoPixelFormat | null, copies = true) =>
    probe(20e6, 0, { kind: 'copy' }, { frame: { format, width: 1920, height: 1080, copies } })
  expect(copiesFrames(p('NV12'))).toBe(true)
  expect(copiesFrames(p('I420P10'))).toBe(true)
  expect(copiesFrames(p('BGRX'))).toBe(false)
  expect(copiesFrames(p(null))).toBe(false)
  // A browser whose copyTo doesn't give the frame back (WebKit on some VP9 and H.264 frames) gets the canvas path.
  expect(copiesFrames(p('I420', false))).toBe(false)
  expect(copiesFrames(probe(20e6, 0, { kind: 'copy' }, { frame: null }))).toBe(false)
})

test('HDR stays 10-bit only for PQ/HLG, decoded deep, playable here', () => {
  const hdr = (format: VideoPixelFormat, playsHdrAv1: boolean, isHdr = true) =>
    probe(20e6, 0, { kind: 'copy' }, { hdr: isHdr, playsHdrAv1, frame: { format, width: 1920, height: 1080, copies: true } })
  expect(keepsHdr(hdr('I420P10', true))).toBe(true)
  expect(keepsHdr(hdr('I420', true))).toBe(false)
  expect(keepsHdr(hdr('I420P10', false))).toBe(false)
  expect(keepsHdr(hdr('I420P10', true, false))).toBe(false)
})

test('output sizes keep the aspect and even dimensions', () => {
  const p = probe(20e6, 0, { kind: 'copy' })
  expect(outputSize(p, null)).toEqual({ width: 1920, height: 1080 })
  expect(outputSize(p, 720)).toEqual({ width: 1280, height: 720 })
  expect(outputSize({ ...p, width: 1080, height: 1920 }, 480)).toEqual({ width: 480, height: 854 })
  expect(outputSize({ ...p, width: 1917, height: 1079 }, null)).toEqual({ width: 1918, height: 1080 })
})

test('codec names', () => {
  expect(codecName('pcm-s24')).toBe('PCM')
  expect(codecName('aac')).toBe('AAC')
  expect(codecName(null)).toBe('Unknown')
})

test('a chosen size replaces half the original everywhere', () => {
  const p = probe(100e6, 128_000, { kind: 'copy', encode: opus })
  const fit = { ...settings, targetBytes: 10e6 }
  expect(targetBytes(p, settings)).toBe(50e6)
  expect(targetBytes(p, fit)).toBe(10e6)
  expect(aimBytes(p, fit)).toBeCloseTo(9.4e6, -3)
  expect(reachable(p, fit)).toBe(true)
  // 10 s of 7 Mbps audio (8.75 MB) leaves 10 MB no room for video, even encoded (a 192 kbps plan here isn't possible).
  expect(reachable(probe(100e6, 7e6, { kind: 'copy' }), fit)).toBe(false)
  // With an encoder, the lossless-size track is encoded and the target is within reach again.
  expect(reachable(probe(100e6, 7e6, { kind: 'copy', encode: opus }), fit)).toBe(true)
})
