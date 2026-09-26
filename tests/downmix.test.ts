import { expect, test } from 'bun:test'
import { AudioSample } from 'mediabunny'
import { ownDownmix, stereoDownmix } from '../src/lib/downmix'

function sample(channels: number, values: number[]) {
  const frames = 4
  const data = new Float32Array(channels * frames)
  values.forEach((v, c) => data.fill(v, c * frames, (c + 1) * frames))
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: channels, sampleRate: 48000, timestamp: 0 })
}
/** The first frame's left and right values of a mix of `input`, closing both samples. */
function sides(mix: (s: AudioSample) => AudioSample, input: AudioSample) {
  const out = mix(input)
  const values = [0, 1].map((i) => {
    const plane = new Float32Array(out.numberOfFrames)
    out.copyTo(plane, { planeIndex: i, format: 'f32-planar' })
    return plane[0]
  })
  input.close()
  out.close()
  return values
}

test('Pare mixes the counts Mediabunny would drop channels of', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8].filter(ownDownmix)).toEqual([3, 5, 7, 8])
})

test('the centre reaches both sides at -3 dB, surrounds their own side, LFE neither', () => {
  const [l5, r5] = sides(stereoDownmix(5), sample(5, [0, 0, 0.5, 0, 0]))
  expect(l5).toBeCloseTo(0.5 * Math.SQRT1_2, 5)
  expect(r5).toBeCloseTo(0.5 * Math.SQRT1_2, 5)
  // 7.1 in WAVE order: L R C LFE Lb Rb Ls Rs.
  const [l8, r8] = sides(stereoDownmix(8), sample(8, [0, 0, 0, 0.9, 0.4, 0, 0, 0.2]))
  expect(l8).toBeCloseTo(0.4 * Math.SQRT1_2, 5)
  expect(r8).toBeCloseTo(0.2 * Math.SQRT1_2, 5)
})

test('loud mixes clip at full scale instead of wrapping', () => {
  const [l] = sides(stereoDownmix(3), sample(3, [1, 0, 1]))
  expect(l).toBe(1)
})
