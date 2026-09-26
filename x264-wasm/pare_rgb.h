// RGB frames to 4:2:0 planes, BT.709 limited range, for both encoders' bindings (pare_x264.c, pare_svtav1.c). Firefox
// decodes to RGB, so every frame there comes this way; the plain C version took 3.4-5.5 s a worker on 10 s of 1080p.
// Bit-exact with it: 16 pixels at a time, luma in 16-bit lanes, each 2x2 block's chroma from pairwise sums and dot
// products.
#include <stdint.h>
#include <wasm_simd128.h>

// Channel k of 8 pixels (32 bytes in a and b), in the low 8 bytes.
#define RGB_CHANNEL(a, b, k)                                                                                           \
  wasm_i8x16_shuffle(a, b, k, k + 4, k + 8, k + 12, k + 16, k + 20, k + 24, k + 28, k, k + 4, k + 8, k + 12, k + 16,   \
                     k + 20, k + 24, k + 28)

// Channels 0, 1 and 2 of 16 pixels at p.
static inline void rgb_split(const uint8_t *p, v128_t *c0, v128_t *c1, v128_t *c2) {
  const v128_t v0 = wasm_v128_load(p), v1 = wasm_v128_load(p + 16), v2 = wasm_v128_load(p + 32),
               v3 = wasm_v128_load(p + 48);
  *c0 = wasm_i8x16_shuffle(RGB_CHANNEL(v0, v1, 0), RGB_CHANNEL(v2, v3, 0), 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20,
                           21, 22, 23);
  *c1 = wasm_i8x16_shuffle(RGB_CHANNEL(v0, v1, 1), RGB_CHANNEL(v2, v3, 1), 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20,
                           21, 22, 23);
  *c2 = wasm_i8x16_shuffle(RGB_CHANNEL(v0, v1, 2), RGB_CHANNEL(v2, v3, 2), 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20,
                           21, 22, 23);
}

// (47 R + 157 G + 16 B + 128) / 256 + 16 for 8 pixels in 16-bit lanes; the sum stays under 2^16.
static inline v128_t rgb_luma(v128_t r, v128_t g, v128_t b) {
  v128_t y = wasm_i16x8_add(wasm_i16x8_mul(r, wasm_i16x8_splat(47)), wasm_i16x8_mul(g, wasm_i16x8_splat(157)));
  y = wasm_i16x8_add(y, wasm_i16x8_add(wasm_i16x8_mul(b, wasm_i16x8_splat(16)), wasm_i16x8_splat(128)));
  return wasm_i16x8_add(wasm_u16x8_shr(y, 8), wasm_i16x8_splat(16));
}

// (wr R + wg G + wb B + 512) / 1024 + 128 for 8 chroma samples, R, G and B each the sum of a 2x2 block.
static inline v128_t rgb_chroma(v128_t r, v128_t g, v128_t b, int16_t wr, int16_t wg, int16_t wb) {
  const v128_t ones = wasm_i16x8_splat(1), wrg = wasm_i16x8_make(wr, wg, wr, wg, wr, wg, wr, wg),
               wb1 = wasm_i16x8_make(wb, 512, wb, 512, wb, 512, wb, 512), bias = wasm_i32x4_splat(128);
  const v128_t lo = wasm_i32x4_add(wasm_i32x4_dot_i16x8(wasm_i16x8_shuffle(r, g, 0, 8, 1, 9, 2, 10, 3, 11), wrg),
                                   wasm_i32x4_dot_i16x8(wasm_i16x8_shuffle(b, ones, 0, 8, 1, 9, 2, 10, 3, 11), wb1));
  const v128_t hi = wasm_i32x4_add(wasm_i32x4_dot_i16x8(wasm_i16x8_shuffle(r, g, 4, 12, 5, 13, 6, 14, 7, 15), wrg),
                                   wasm_i32x4_dot_i16x8(wasm_i16x8_shuffle(b, ones, 4, 12, 5, 13, 6, 14, 7, 15), wb1));
  return wasm_i16x8_narrow_i32x4(wasm_i32x4_add(wasm_i32x4_shr(lo, 10), bias), wasm_i32x4_add(wasm_i32x4_shr(hi, 10), bias));
}

// RGBA/RGBX (or BGRA/BGRX when bgr != 0), rows `stride` bytes apart, to luma at y (rows `ys` apart) and chroma at u and
// v (rows `cs` apart, samples `step` apart: NV12 passes u = uv, v = uv + 1, step 2).
static void rgb_to_yuv(const uint8_t *rgba, int stride, int width, int height, int bgr, uint8_t *y, int ys, uint8_t *u,
                       uint8_t *v, int cs, int step) {
  const int ri = bgr ? 2 : 0, bi = bgr ? 0 : 2;
  for (int row = 0; row < height; row++) {
    const uint8_t *s = rgba + (size_t)row * stride;
    uint8_t *d = y + (size_t)row * ys;
    int x = 0;
    for (; x + 16 <= width; x += 16) {
      v128_t c0, c1, c2;
      rgb_split(s + 4 * x, &c0, &c1, &c2);
      const v128_t r = bgr ? c2 : c0, b = bgr ? c0 : c2;
      const v128_t lo = rgb_luma(wasm_u16x8_extend_low_u8x16(r), wasm_u16x8_extend_low_u8x16(c1),
                                 wasm_u16x8_extend_low_u8x16(b));
      const v128_t hi = rgb_luma(wasm_u16x8_extend_high_u8x16(r), wasm_u16x8_extend_high_u8x16(c1),
                                 wasm_u16x8_extend_high_u8x16(b));
      wasm_v128_store(d + x, wasm_u8x16_narrow_i16x8(lo, hi));
    }
    for (; x < width; x++) {
      const uint8_t *p = s + 4 * x;
      d[x] = (uint8_t)(((47 * p[ri] + 157 * p[1] + 16 * p[bi] + 128) >> 8) + 16);
    }
  }
  for (int row = 0; row < height / 2; row++) {
    const uint8_t *a = rgba + (size_t)2 * row * stride, *b = a + stride;
    uint8_t *du = u + (size_t)row * cs, *dv = v + (size_t)row * cs;
    int x = 0;
    for (; 2 * x + 16 <= width; x += 8) {
      v128_t a0, a1, a2, b0, b1, b2;
      rgb_split(a + 8 * x, &a0, &a1, &a2);
      rgb_split(b + 8 * x, &b0, &b1, &b2);
      const v128_t s0 = wasm_i16x8_add(wasm_u16x8_extadd_pairwise_u8x16(a0), wasm_u16x8_extadd_pairwise_u8x16(b0));
      const v128_t g = wasm_i16x8_add(wasm_u16x8_extadd_pairwise_u8x16(a1), wasm_u16x8_extadd_pairwise_u8x16(b1));
      const v128_t s2 = wasm_i16x8_add(wasm_u16x8_extadd_pairwise_u8x16(a2), wasm_u16x8_extadd_pairwise_u8x16(b2));
      const v128_t r = bgr ? s2 : s0, bl = bgr ? s0 : s2;
      const v128_t cb = rgb_chroma(r, g, bl, -26, -86, 112), cr = rgb_chroma(r, g, bl, 112, -102, -10);
      if (step == 2)
        wasm_v128_store(du + 2 * x, wasm_u8x16_narrow_i16x8(wasm_i16x8_shuffle(cb, cr, 0, 8, 1, 9, 2, 10, 3, 11),
                                                            wasm_i16x8_shuffle(cb, cr, 4, 12, 5, 13, 6, 14, 7, 15)));
      else {
        wasm_v128_store64_lane(du + x, wasm_u8x16_narrow_i16x8(cb, cb), 0);
        wasm_v128_store64_lane(dv + x, wasm_u8x16_narrow_i16x8(cr, cr), 0);
      }
    }
    for (; x < width / 2; x++) {
      const uint8_t *p = a + 8 * x, *q = b + 8 * x;
      const int r = p[ri] + p[ri + 4] + q[ri] + q[ri + 4], g = p[1] + p[5] + q[1] + q[5],
                bl = p[bi] + p[bi + 4] + q[bi] + q[bi + 4];
      du[x * step] = (uint8_t)(((-26 * r - 86 * g + 112 * bl + 512) >> 10) + 128);
      dv[x * step] = (uint8_t)(((112 * r - 102 * g - 10 * bl + 512) >> 10) + 128);
    }
  }
}
