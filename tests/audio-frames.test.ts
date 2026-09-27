import { expect, test } from 'bun:test'
import { AudioSample } from 'mediabunny'
import { encoderFrames, packetFrames, resamplerBlock } from '../src/lib/audio-frames'

const rate = 48000
/** A stereo sample of `frames` frames whose left channel counts up from `first`. */
function sample(frames: number, timestamp: number, first = 0) {
  const data = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) data[i] = (first + i) / 1e6
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp })
}

function left(s: AudioSample) {
  const plane = new Float32Array(s.numberOfFrames)
  s.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
  return plane
}

test('resampler blocks become packet-sized pieces that follow each other exactly', () => {
  const frames = packetFrames('opus', rate)
  const block = resamplerBlock(rate)
  const pieces = encoderFrames(frames, block)
  // Two full 5 s blocks, then the resampler's short last block.
  const out = [sample(block, 0, 0), sample(block, 5, block), sample(1234, 10, 2 * block)].flatMap((s) => pieces(s) as AudioSample[])
  const total = out.reduce((n, s) => n + s.numberOfFrames, 0)
  expect(total).toBe(2 * block + 1234)
  let at = 0
  for (const s of out) {
    expect(s.timestamp).toBeCloseTo(at / rate, 9)
    expect(left(s)[0]).toBeCloseTo(at / 1e6, 6)
    at += s.numberOfFrames
  }
  // Every piece but the last is exactly one packet.
  expect(out.slice(0, -1).every((s) => s.numberOfFrames === frames)).toBe(true)
})

test('audio that isn\'t resampled is cut up and sent on whole', () => {
  const pieces = encoderFrames(packetFrames('opus', rate), resamplerBlock(rate))
  const out = pieces(sample(2048, 1)) as AudioSample[]
  expect(out.map((s) => s.numberOfFrames)).toEqual([960, 960, 128])
  expect(out.map((s) => s.timestamp)).toEqual([1, 1 + 960 / rate, 1 + 1920 / rate])
  expect(packetFrames('aac', 44100)).toBe(1024)
})
