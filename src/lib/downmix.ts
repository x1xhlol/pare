import { AudioSample } from 'mediabunny'

const S = Math.SQRT1_2

/**
 * Left and right weights for each source channel, in the WAVE channel order cameras and most files use. Mediabunny
 * mixes 4 and 6 channels down properly and keeps only the first two of any other count, which would drop the centre
 * (dialogue) of a 3.0, 5.0, 6.1 or 7.1 track. Centre and surrounds fold in at -3 dB as in Mediabunny's 5.1 mix; LFE
 * is left out.
 */
const LAYOUTS: Record<number, [number[], number[]]> = {
  // L R C
  3: [[1, 0, S], [0, 1, S]],
  // L R C Ls Rs
  5: [[1, 0, S, S, 0], [0, 1, S, 0, S]],
  // L R C LFE Cs Ls Rs
  7: [[1, 0, S, 0, 0.5, S, 0], [0, 1, S, 0, 0.5, 0, S]],
  // L R C LFE Lb Rb Ls Rs
  8: [[1, 0, S, 0, S, 0, S, 0], [0, 1, S, 0, 0, S, 0, S]],
}

/** Whether Pare mixes this many channels down to stereo itself rather than leaving it to Mediabunny. */
export const ownDownmix = (channels: number) => channels > 2 && channels !== 4 && channels !== 6

/**
 * A process function (Mediabunny's transform.process) mixing `channels` down to stereo. Counts without a known layout
 * put the even channels on the left and the odd ones on the right, so nothing is dropped.
 */
export function stereoDownmix(channels: number) {
  const [left, right] = LAYOUTS[channels] ?? [
    Array.from({ length: channels }, (_, i) => (i % 2 ? 0 : 2 / channels)),
    Array.from({ length: channels }, (_, i) => (i % 2 ? 2 / channels : 0)),
  ]
  return (sample: AudioSample) => {
    const frames = sample.numberOfFrames
    const planes = Array.from({ length: sample.numberOfChannels }, (_, i) => {
      const plane = new Float32Array(frames)
      sample.copyTo(plane, { planeIndex: i, format: 'f32-planar' })
      return plane
    })
    const out = new Float32Array(2 * frames)
    for (const [side, weights] of [left, right].entries())
      for (let i = 0; i < frames; i++) {
        let v = 0
        for (let c = 0; c < planes.length; c++) v += weights[c] * planes[c][i]
        out[side * frames + i] = Math.max(-1, Math.min(1, v))
      }
    return new AudioSample({ data: out, format: 'f32-planar', numberOfChannels: 2, sampleRate: sample.sampleRate,
      timestamp: sample.timestamp })
  }
}
