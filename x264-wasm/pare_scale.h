// Resizes one plane of decoded video in WebAssembly, for both encoders' bindings (pare_x264.c, pare_svtav1.c).
//
// Pare used to resize by drawing each frame on an RGB canvas, which cost 170 ms a frame taking 4K to 720p on the
// benchmark machine (the encode itself took 5), turned the colours into 8-bit BT.709, and lost HDR. This scales the
// decoder's own planes instead: a separable bicubic filter (Catmull-Rom), widened by the ratio when shrinking so every
// source sample counts, as ffmpeg's swscale does. Vertical first, over whole rows, which vectorises; then horizontal.
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <wasm_simd128.h>

#define SCALE_BITS 14 // filter weights sum to 1 << SCALE_BITS

static double scale_cubic(double x) {
  const double a = -0.5;
  x = fabs(x);
  return x < 1 ? ((a + 2) * x - (a + 3)) * x * x + 1 : x < 2 ? ((a * x - 5 * a) * x + 8 * a) * x - 4 * a : 0;
}

// For each of `dn` output positions, the first of `*taps` source positions it reads and their weights. Positions past
// either edge take the edge sample, so every window lies inside the plane.
static int16_t *scale_filter(int sn, int dn, int *taps_out, int **starts_out) {
  const double ratio = (double)sn / dn, widen = ratio > 1 ? ratio : 1;
  int taps = 2 * (int)ceil(2 * widen);
  if (taps > sn) taps = sn;
  int16_t *weights = malloc((size_t)dn * taps * sizeof(int16_t));
  int *starts = malloc((size_t)dn * sizeof(int));
  double *f = malloc((size_t)taps * sizeof(double));
  if (!weights || !starts || !f) {
    free(weights), free(starts), free(f);
    return NULL;
  }
  for (int i = 0; i < dn; i++) {
    const double center = (i + 0.5) * ratio - 0.5;
    int first = (int)floor(center - 2 * widen) + 1;
    int start = first < 0 ? 0 : first > sn - taps ? sn - taps : first;
    for (int k = 0; k < taps; k++) f[k] = 0;
    double sum = 0;
    for (int p = first; p < first + 2 * (int)ceil(2 * widen); p++) {
      const double w = scale_cubic((p - center) / widen);
      const int at = (p < 0 ? 0 : p >= sn ? sn - 1 : p) - start;
      if (at >= 0 && at < taps) f[at] += w, sum += w;
    }
    int total = 0, biggest = 0;
    for (int k = 0; k < taps; k++) {
      const int w = (int)lround(f[k] / sum * (1 << SCALE_BITS));
      weights[i * taps + k] = (int16_t)w;
      total += w;
      if (abs(w) > abs(weights[i * taps + biggest])) biggest = k;
    }
    weights[i * taps + biggest] += (int16_t)((1 << SCALE_BITS) - total);
    starts[i] = start;
  }
  free(f);
  *taps_out = taps;
  *starts_out = starts;
  return weights;
}

// The vertical filter over `taps` lines for every sample of a row, rounded and shifted down by `down` bits. 8-bit
// samples go 16 at a time, 10- and 12-bit ones 8 at a time, each widened to 16 bits and multiplied into 32.
static void scale_rows(int32_t *acc, const uint8_t *const *lines, const int16_t *w, int taps, int row, int bytes,
                       int down) {
  const v128_t round = wasm_i32x4_splat(1 << (down - 1));
  int x = 0;
  if (bytes == 1)
    for (; x + 16 <= row; x += 16) {
      v128_t a0 = round, a1 = round, a2 = round, a3 = round;
      for (int k = 0; k < taps; k++) {
        const v128_t p = wasm_v128_load(lines[k] + x), wk = wasm_i16x8_splat(w[k]);
        const v128_t lo = wasm_u16x8_extend_low_u8x16(p), hi = wasm_u16x8_extend_high_u8x16(p);
        a0 = wasm_i32x4_add(a0, wasm_i32x4_extmul_low_i16x8(lo, wk));
        a1 = wasm_i32x4_add(a1, wasm_i32x4_extmul_high_i16x8(lo, wk));
        a2 = wasm_i32x4_add(a2, wasm_i32x4_extmul_low_i16x8(hi, wk));
        a3 = wasm_i32x4_add(a3, wasm_i32x4_extmul_high_i16x8(hi, wk));
      }
      wasm_v128_store(acc + x, wasm_i32x4_shr(a0, down));
      wasm_v128_store(acc + x + 4, wasm_i32x4_shr(a1, down));
      wasm_v128_store(acc + x + 8, wasm_i32x4_shr(a2, down));
      wasm_v128_store(acc + x + 12, wasm_i32x4_shr(a3, down));
    }
  else
    for (; x + 8 <= row; x += 8) {
      v128_t a0 = round, a1 = round;
      for (int k = 0; k < taps; k++) {
        const v128_t p = wasm_v128_load((const uint16_t *)lines[k] + x), wk = wasm_i16x8_splat(w[k]);
        a0 = wasm_i32x4_add(a0, wasm_i32x4_extmul_low_i16x8(p, wk));
        a1 = wasm_i32x4_add(a1, wasm_i32x4_extmul_high_i16x8(p, wk));
      }
      wasm_v128_store(acc + x, wasm_i32x4_shr(a0, down));
      wasm_v128_store(acc + x + 4, wasm_i32x4_shr(a1, down));
    }
  for (; x < row; x++) {
    int32_t a = 1 << (down - 1);
    for (int k = 0; k < taps; k++) a += w[k] * (bytes == 1 ? lines[k][x] : ((const uint16_t *)lines[k])[x]);
    acc[x] = a >> down;
  }
}

// Scales a plane of `sw` x `sh` positions, each `channels` interleaved samples (2 for NV12 chroma) of `src_bytes` bytes
// (1, or 2 for 10- and 12-bit), rows `src_stride` bytes apart, to `dw` x `dh`. Channel c of output position x goes to
// dst + (x * dst_step + c) * dst_bytes, rows `dst_stride` bytes apart, shifted right by `shift` bits (12-bit into a
// 10-bit encoder: 2; 10-bit into an 8-bit one: 2), rounded and clamped to `max`. Returns 0, or -1 without memory.
//
// Four output rows at a time: their vertical sums are interleaved sample by sample, so the horizontal filter makes all
// four with each multiply.
EMSCRIPTEN_KEEPALIVE int scale_plane(const uint8_t *src, int src_stride, int sw, int sh, int src_bytes, int channels,
                                     uint8_t *dst, int dst_stride, int dw, int dh, int dst_bytes, int dst_step,
                                     int shift, int max) {
  int vtaps, htaps, *vstart = NULL, *hstart = NULL;
  int16_t *vw = scale_filter(sh, dh, &vtaps, &vstart), *hw = scale_filter(sw, dw, &htaps, &hstart);
  const int row = sw * channels;
  int32_t *acc = malloc((size_t)row * 4 * sizeof(int32_t)), *quad = malloc(((size_t)row * 4 + 4) * sizeof(int32_t));
  const uint8_t **lines = malloc((size_t)vtaps * sizeof(*lines));
  if (!vw || !hw || !acc || !quad || !lines) {
    free(vw), free(hw), free(vstart), free(hstart), free(acc), free(quad), free(lines);
    return -1;
  }
  // The vertical pass keeps `extra` bits of its fraction: as many as fit the horizontal sum in 32 bits.
  const int extra = src_bytes == 1 ? 6 : 2, down = SCALE_BITS - extra, final = SCALE_BITS + extra + shift;
  const v128_t round = wasm_i32x4_splat(1 << (final - 1)), low = wasm_i32x4_splat(0), high = wasm_i32x4_splat(max);
  for (int y0 = 0; y0 < dh; y0 += 4) {
    const int rows = dh - y0 < 4 ? dh - y0 : 4;
    // Past the last row, repeat it: computed, not written.
    for (int r = 0; r < 4; r++) {
      const int y = y0 + (r < rows ? r : rows - 1);
      for (int k = 0; k < vtaps; k++) lines[k] = src + (size_t)(vstart[y] + k) * src_stride;
      scale_rows(acc + (size_t)r * row, lines, vw + y * vtaps, vtaps, row, src_bytes, down);
    }
    const int32_t *r0 = acc, *r1 = acc + row, *r2 = acc + 2 * row, *r3 = acc + 3 * row;
    int s = 0;
    for (; s + 4 <= row; s += 4) {
      const v128_t a = wasm_v128_load(r0 + s), b = wasm_v128_load(r1 + s), c = wasm_v128_load(r2 + s),
                   d = wasm_v128_load(r3 + s);
      const v128_t ab01 = wasm_i32x4_shuffle(a, b, 0, 4, 1, 5), ab23 = wasm_i32x4_shuffle(a, b, 2, 6, 3, 7);
      const v128_t cd01 = wasm_i32x4_shuffle(c, d, 0, 4, 1, 5), cd23 = wasm_i32x4_shuffle(c, d, 2, 6, 3, 7);
      wasm_v128_store(quad + 4 * s, wasm_i32x4_shuffle(ab01, cd01, 0, 1, 4, 5));
      wasm_v128_store(quad + 4 * s + 4, wasm_i32x4_shuffle(ab01, cd01, 2, 3, 6, 7));
      wasm_v128_store(quad + 4 * s + 8, wasm_i32x4_shuffle(ab23, cd23, 0, 1, 4, 5));
      wasm_v128_store(quad + 4 * s + 12, wasm_i32x4_shuffle(ab23, cd23, 2, 3, 6, 7));
    }
    for (; s < row; s++) quad[4 * s] = r0[s], quad[4 * s + 1] = r1[s], quad[4 * s + 2] = r2[s], quad[4 * s + 3] = r3[s];
    uint8_t *out = dst + (size_t)y0 * dst_stride;
    for (int x = 0; x < dw; x++) {
      const int16_t *h = hw + x * htaps;
      for (int c = 0; c < channels; c++) {
        const int32_t *base = quad + 4 * (hstart[x] * channels + c);
        v128_t sum = round;
        for (int k = 0; k < htaps; k++)
          sum = wasm_i32x4_add(sum, wasm_i32x4_mul(wasm_v128_load(base + 4 * k * channels), wasm_i32x4_splat(h[k])));
        const v128_t v = wasm_i32x4_min(wasm_i32x4_max(wasm_i32x4_shr(sum, final), low), high);
        const size_t at = (size_t)x * dst_step + c;
        if (dst_bytes == 1) {
          out[at] = (uint8_t)wasm_i32x4_extract_lane(v, 0);
          if (rows > 1) out[dst_stride + at] = (uint8_t)wasm_i32x4_extract_lane(v, 1);
          if (rows > 2) out[2 * dst_stride + at] = (uint8_t)wasm_i32x4_extract_lane(v, 2);
          if (rows > 3) out[3 * dst_stride + at] = (uint8_t)wasm_i32x4_extract_lane(v, 3);
        } else {
          ((uint16_t *)out)[at] = (uint16_t)wasm_i32x4_extract_lane(v, 0);
          if (rows > 1) ((uint16_t *)(out + dst_stride))[at] = (uint16_t)wasm_i32x4_extract_lane(v, 1);
          if (rows > 2) ((uint16_t *)(out + 2 * dst_stride))[at] = (uint16_t)wasm_i32x4_extract_lane(v, 2);
          if (rows > 3) ((uint16_t *)(out + 3 * dst_stride))[at] = (uint16_t)wasm_i32x4_extract_lane(v, 3);
        }
      }
    }
  }
  free(vw), free(hw), free(vstart), free(hstart), free(acc), free(quad), free(lines);
  return 0;
}
