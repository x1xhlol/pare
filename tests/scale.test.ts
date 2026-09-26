// The WebAssembly plane scaler (x264-wasm/pare_scale.h) against a plain JavaScript port of its fixed-point filter:
// the SIMD version has to match it bit for bit.
import { expect, test } from 'bun:test'
import create from '../src/lib/x264/x264.mjs'

const x = await create()
const BITS = 14

const cubic = (v: number) => {
  const a = -0.5
  v = Math.abs(v)
  return v < 1 ? ((a + 2) * v - (a + 3)) * v * v + 1 : v < 2 ? ((a * v - 5 * a) * v + 8 * a) * v - 4 * a : 0
}
// C's lround: halves away from zero.
const lround = (v: number) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5)

function filter(sn: number, dn: number) {
  const ratio = sn / dn, widen = ratio > 1 ? ratio : 1
  const span = 2 * Math.ceil(2 * widen)
  const taps = Math.min(span, sn)
  const weights = new Int32Array(dn * taps), starts = new Int32Array(dn)
  for (let i = 0; i < dn; i++) {
    const center = (i + 0.5) * ratio - 0.5
    const first = Math.floor(center - 2 * widen) + 1
    const start = first < 0 ? 0 : first > sn - taps ? sn - taps : first
    const f = new Float64Array(taps)
    let sum = 0
    for (let p = first; p < first + span; p++) {
      const w = cubic((p - center) / widen)
      const at = (p < 0 ? 0 : p >= sn ? sn - 1 : p) - start
      if (at >= 0 && at < taps) (f[at] += w), (sum += w)
    }
    let total = 0, biggest = 0
    for (let k = 0; k < taps; k++) {
      const w = lround((f[k] / sum) * (1 << BITS))
      weights[i * taps + k] = w
      total += w
      if (Math.abs(w) > Math.abs(weights[i * taps + biggest])) biggest = k
    }
    weights[i * taps + biggest] += (1 << BITS) - total
    starts[i] = start
  }
  return { taps, weights, starts }
}

type Case = { sw: number; sh: number; srcBytes: number; channels: number; dw: number; dh: number; dstBytes: number;
  dstStep: number; shift: number; max: number }

function reference(src: Uint16Array, c: Case) {
  const v = filter(c.sh, c.dh), h = filter(c.sw, c.dw)
  const row = c.sw * c.channels
  const extra = c.srcBytes === 1 ? 6 : 2, down = BITS - extra, final = BITS + extra + c.shift
  const out = new Uint16Array(c.dw * c.dstStep * c.dh)
  const acc = new Int32Array(row)
  for (let y = 0; y < c.dh; y++) {
    for (let s = 0; s < row; s++) {
      let a = 1 << (down - 1)
      for (let k = 0; k < v.taps; k++) a += v.weights[y * v.taps + k] * src[(v.starts[y] + k) * row + s]
      acc[s] = a >> down
    }
    for (let xo = 0; xo < c.dw; xo++)
      for (let ch = 0; ch < c.channels; ch++) {
        let sum = 1 << (final - 1)
        for (let k = 0; k < h.taps; k++) sum += h.weights[xo * h.taps + k] * acc[(h.starts[xo] + k) * c.channels + ch]
        out[y * c.dw * c.dstStep + xo * c.dstStep + ch] = Math.min(c.max, Math.max(0, sum >> final))
      }
  }
  return out
}

function run(c: Case, seed: number) {
  let r = seed
  const rand = () => ((r = (r * 1103515245 + 12345) >>> 0) >>> 16) / 65536
  const top = c.srcBytes === 1 ? 255 : 1023
  const src = new Uint16Array(c.sw * c.channels * c.sh).map(() => Math.floor(rand() * (top + 1)))
  const srcStride = c.sw * c.channels * c.srcBytes
  const sp = x._malloc(src.length * c.srcBytes)
  if (c.srcBytes === 1) x.HEAPU8.set(Uint8Array.from(src), sp)
  else x.HEAPU8.set(new Uint8Array(src.buffer), sp)
  const dstStride = c.dw * c.dstStep * c.dstBytes
  const dp = x._malloc(dstStride * c.dh)
  x.HEAPU8.fill(0, dp, dp + dstStride * c.dh)
  expect(x._scale_plane(sp, srcStride, c.sw, c.sh, c.srcBytes, c.channels, dp, dstStride, c.dw, c.dh, c.dstBytes,
    c.dstStep, c.shift, c.max)).toBe(0)
  const bytes = x.HEAPU8.slice(dp, dp + dstStride * c.dh)
  const got = c.dstBytes === 1 ? Uint16Array.from(bytes) : new Uint16Array(bytes.buffer)
  x._free(sp)
  x._free(dp)
  const want = reference(src, c)
  // Only the samples the scaler writes: with an interleaved destination, the other channel's are left alone.
  for (let y = 0; y < c.dh; y++)
    for (let xo = 0; xo < c.dw; xo++)
      for (let ch = 0; ch < c.channels; ch++) {
        const at = y * c.dw * c.dstStep + xo * c.dstStep + ch
        if (got[at] !== want[at]) throw new Error(`${JSON.stringify(c)}: (${xo}, ${y}) channel ${ch}: ${got[at]} != ${want[at]}`)
      }
}

test('matches the reference on common resizes', () => {
  run({ sw: 192, sh: 108, srcBytes: 1, channels: 1, dw: 128, dh: 72, dstBytes: 1, dstStep: 1, shift: 0, max: 255 }, 1)
  run({ sw: 384, sh: 216, srcBytes: 1, channels: 1, dw: 128, dh: 72, dstBytes: 1, dstStep: 1, shift: 0, max: 255 }, 2)
  run({ sw: 96, sh: 54, srcBytes: 1, channels: 2, dw: 64, dh: 36, dstBytes: 1, dstStep: 2, shift: 0, max: 255 }, 3)
})

test('matches the reference for 10-bit input, into 10 and 8 bits', () => {
  run({ sw: 192, sh: 108, srcBytes: 2, channels: 1, dw: 128, dh: 72, dstBytes: 2, dstStep: 1, shift: 0, max: 1023 }, 4)
  run({ sw: 192, sh: 108, srcBytes: 2, channels: 1, dw: 128, dh: 72, dstBytes: 1, dstStep: 1, shift: 2, max: 255 }, 5)
  run({ sw: 96, sh: 54, srcBytes: 2, channels: 1, dw: 64, dh: 36, dstBytes: 1, dstStep: 2, shift: 2, max: 255 }, 6)
})

test('matches the reference on odd, tiny and enlarging sizes', () => {
  let seed = 10
  for (const [sw, sh, dw, dh] of [[7, 5, 4, 2], [3, 3, 1, 1], [33, 17, 31, 9], [50, 30, 51, 31], [16, 9, 40, 22],
    [101, 57, 34, 19], [2, 2, 5, 3]])
    for (const channels of [1, 2])
      run({ sw, sh, srcBytes: 1, channels, dw, dh, dstBytes: 1, dstStep: channels, shift: 0, max: 255 }, seed++)
})

test('matches the reference on random configurations', () => {
  let r = 7
  const rand = (n: number) => ((r = (r * 1103515245 + 12345) >>> 0) >>> 16) % n
  for (let i = 0; i < 60; i++) {
    const deep = rand(2) === 1, channels = rand(2) + 1
    const sw = 2 + rand(90), sh = 2 + rand(50)
    const dw = 1 + rand(sw + 10), dh = 1 + rand(sh + 10)
    const toTen = deep && rand(2) === 1
    run({ sw, sh, srcBytes: deep ? 2 : 1, channels, dw, dh, dstBytes: toTen ? 2 : 1, dstStep: channels === 2 ? 2 : 1 + rand(2),
      shift: deep && !toTen ? 2 : 0, max: toTen ? 1023 : 255 }, 100 + i)
  }
})
