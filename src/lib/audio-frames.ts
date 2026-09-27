import { AudioSample } from 'mediabunny'

/*
 * WebKit's AudioEncoder stamps every packet it makes from one AudioData with that AudioData's timestamp instead of
 * counting forward. Mediabunny's resampler, which runs whenever a transform sets the channel count or sample rate, hands
 * the encoder 5-second blocks, so a short clip's audio all came out at timestamp 0 (stts [(139, 0), (1, 144001)]), and
 * a longer one in one timestamp per block. Chrome and Firefox count forward. So the encoder gets its audio one encoder
 * frame at a time, each piece timed from a running count of frames.
 */

/** Frames in each block Mediabunny's resampler hands on: 5 seconds. */
export const resamplerBlock = (sampleRate: number) => Math.floor(sampleRate * 5)

/** Frames in one encoder packet: 1024 for AAC, 20 ms for Opus. */
export const packetFrames = (codec: 'aac' | 'opus', sampleRate: number) =>
  codec === 'aac' ? 1024 : Math.round(sampleRate / 50)

function planes(sample: AudioSample) {
  return Array.from({ length: sample.numberOfChannels }, (_, c) => {
    const plane = new Float32Array(sample.numberOfFrames)
    sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
    return plane
  })
}

function piece(all: Float32Array[], from: number, count: number, sampleRate: number, timestamp: number) {
  const data = new Float32Array(count * all.length)
  for (let c = 0; c < all.length; c++) data.set(all[c].subarray(from, from + count), c * count)
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: all.length, sampleRate, timestamp })
}

/**
 * A transform.process for audio coming out of Mediabunny's resampler in blocks of `block` frames: cuts it into pieces
 * of `frames`, carrying what's left over into the next block, so pieces follow each other exactly. A block shorter than
 * `block` is the resampler's last, and everything left goes out with it. Audio that isn't resampled comes in the
 * decoder's short samples, each cut up and sent on whole.
 */
export function encoderFrames(frames: number, block: number) {
  let held: { timestamp: number; planes: Float32Array[] } | null = null
  return (sample: AudioSample) => {
    const current = planes(sample)
    const rate = sample.sampleRate
    const start = held ? held.timestamp : sample.timestamp
    const all = held
      ? current.map((plane, c) => {
          const joined = new Float32Array(held!.planes[c].length + plane.length)
          joined.set(held!.planes[c])
          joined.set(plane, held!.planes[c].length)
          return joined
        })
      : current
    const total = all[0]?.length ?? 0
    const whole = sample.numberOfFrames < block ? total : total - (total % frames)
    const pieces: AudioSample[] = []
    for (let at = 0; at < whole; at += frames) pieces.push(piece(all, at, Math.min(frames, whole - at), rate, start + at / rate))
    held = whole < total ? { timestamp: start + whole / rate, planes: all.map((plane) => plane.slice(whole)) } : null
    return pieces
  }
}
