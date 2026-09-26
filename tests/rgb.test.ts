// RGB frames into x264's NV12 input planes (x264-wasm/pare_rgb.h, SIMD) against the BT.709 formulas it implements.
import { expect, test } from 'bun:test'
import create from '../src/lib/x264/x264.mjs'

const x = await create()
const CSP_NV12 = 0x0004

test('RGBA and BGRA import match the formulas at every size', () => {
  let r = 3
  const rand = () => (r = (r * 1103515245 + 12345) >>> 0) >>> 24
  for (const [width, height] of [[16, 2], [18, 4], [34, 6], [64, 8], [70, 10], [96, 2]])
    for (const bgr of [0, 1]) {
      const options = x.stringToNewUTF8('ultrafast;;crf=20')
      const enc = x._enc_open(width, height, 25, 1, CSP_NV12, options)
      x._free(options)
      expect(enc).not.toBe(0)
      const stride = width * 4 + 8
      const rgba = new Uint8Array(stride * height).map(rand)
      const p = x._malloc(rgba.length)
      x.HEAPU8.set(rgba, p)
      x._enc_import_rgba(enc, p, stride, width, height, bgr)
      const [ri, bi] = bgr ? [2, 0] : [0, 2]
      const y = x._enc_plane(enc, 0), ys = x._enc_stride(enc, 0), uv = x._enc_plane(enc, 1), us = x._enc_stride(enc, 1)
      for (let row = 0; row < height; row++)
        for (let col = 0; col < width; col++) {
          const s = row * stride + col * 4
          expect(x.HEAPU8[y + row * ys + col]).toBe(((47 * rgba[s + ri] + 157 * rgba[s + 1] + 16 * rgba[s + bi] + 128) >> 8) + 16)
        }
      for (let row = 0; row < height / 2; row++)
        for (let col = 0; col < width / 2; col++) {
          const a = 2 * row * stride + 8 * col, b = a + stride
          const R = rgba[a + ri] + rgba[a + ri + 4] + rgba[b + ri] + rgba[b + ri + 4]
          const G = rgba[a + 1] + rgba[a + 5] + rgba[b + 1] + rgba[b + 5]
          const B = rgba[a + bi] + rgba[a + bi + 4] + rgba[b + bi] + rgba[b + bi + 4]
          expect(x.HEAPU8[uv + row * us + 2 * col]).toBe(((-26 * R - 86 * G + 112 * B + 512) >> 10) + 128)
          expect(x.HEAPU8[uv + row * us + 2 * col + 1]).toBe(((112 * R - 102 * G - 10 * B + 512) >> 10) + 128)
        }
      x._free(p)
      x._enc_close(enc)
    }
})
