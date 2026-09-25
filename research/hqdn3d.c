// hqdn3d (spatial-temporal denoiser, 8-bit path), ported from FFmpeg's libavfilter/vf_hqdn3d.c.
// Copyright (c) 2003 Daniel Moreno, (c) 2010 Baptiste Coudurier, (c) 2012 Loren Merritt. GPL-2.0-or-later.
// Changes: a pixel step so interleaved NV12 chroma is filtered in place, and a temporal-only mode when the
// spatial strength is 0.
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define LUT_BITS 4
#define LUT_SIZE (2 * (256 << LUT_BITS))

typedef struct {
  int16_t *coefs[4]; // luma spatial, chroma spatial, luma temporal, chroma temporal (NULL = off)
  uint16_t *line;
  uint16_t *frame[3];
  int width[3], height[3];
} Denoiser;

static int16_t *precalc_coefs(double dist25) {
  if (dist25 <= 0) return NULL;
  int16_t *ct = malloc(LUT_SIZE * sizeof(int16_t));
  double gamma = log(0.25) / log(1.0 - fmin(dist25, 252.0) / 255.0 - 0.00001);
  for (int i = -(256 << LUT_BITS); i < 256 << LUT_BITS; i++) {
    double f = (i * (1 << (9 - LUT_BITS)) + (1 << (8 - LUT_BITS)) - 1) / 512.0;
    double simil = fmax(0, 1.0 - fabs(f) / 255.0);
    ct[(256 << LUT_BITS) + i] = (int16_t)lrint(pow(simil, gamma) * 256.0 * f);
  }
  ct[0] = 1;
  return ct;
}

static inline uint32_t lowpass(int prev, int cur, const int16_t *coef) {
  return cur + coef[(prev - cur) >> (8 - LUT_BITS)];
}

#define LOAD(p) (((uint32_t)(p) << 8) + 127)

// Filters one plane in place. `step` is the distance between neighbouring samples (2 for NV12 chroma).
static void denoise_plane(Denoiser *d, int plane, uint8_t *pix, int stride, int step, int w, int h,
                          const int16_t *spatial, const int16_t *temporal) {
  uint16_t *frame = d->frame[plane];
  if (!frame) {
    frame = d->frame[plane] = malloc((size_t)w * h * sizeof(uint16_t));
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) frame[y * w + x] = LOAD(pix[y * stride + x * step]);
  }
  const int16_t *t = temporal ? temporal + (256 << LUT_BITS) : NULL;
  if (!spatial) {
    if (!t) return;
    for (int y = 0; y < h; y++, pix += stride, frame += w)
      for (int x = 0; x < w; x++) {
        uint32_t v = frame[x] = lowpass(frame[x], LOAD(pix[x * step]), t);
        pix[x * step] = v >> 8;
      }
    return;
  }
  const int16_t *s = spatial + (256 << LUT_BITS);
  uint16_t *line = d->line;
  uint32_t pixel_ant = LOAD(pix[0]), v;
  for (int x = 0; x < w; x++) {
    line[x] = v = pixel_ant = lowpass(pixel_ant, LOAD(pix[x * step]), s);
    if (t) frame[x] = v = lowpass(frame[x], v, t);
    pix[x * step] = v >> 8;
  }
  for (int y = 1; y < h; y++) {
    pix += stride;
    frame += w;
    pixel_ant = LOAD(pix[0]);
    int x = 0;
    for (; x < w - 1; x++) {
      line[x] = v = lowpass(line[x], pixel_ant, s);
      pixel_ant = lowpass(pixel_ant, LOAD(pix[(x + 1) * step]), s);
      if (t) frame[x] = v = lowpass(frame[x], v, t);
      pix[x * step] = v >> 8;
    }
    line[x] = v = lowpass(line[x], pixel_ant, s);
    if (t) frame[x] = v = lowpass(frame[x], v, t);
    pix[x * step] = v >> 8;
  }
}

Denoiser *denoiser_new(double luma_spatial, double chroma_spatial, double luma_tmp, double chroma_tmp, int width) {
  Denoiser *d = calloc(1, sizeof(Denoiser));
  d->coefs[0] = precalc_coefs(luma_spatial);
  d->coefs[1] = precalc_coefs(chroma_spatial);
  d->coefs[2] = precalc_coefs(luma_tmp);
  d->coefs[3] = precalc_coefs(chroma_tmp);
  d->line = malloc((size_t)width * sizeof(uint16_t));
  return d;
}

void denoiser_free(Denoiser *d) {
  if (!d) return;
  for (int i = 0; i < 4; i++) free(d->coefs[i]);
  for (int i = 0; i < 3; i++) free(d->frame[i]);
  free(d->line);
  free(d);
}

// 4:2:0 frame; `interleaved` = NV12 (u holds UVUV..., v is ignored).
void denoiser_run(Denoiser *d, uint8_t *y, int sy, uint8_t *u, int su, uint8_t *v, int sv, int w, int h,
                  int interleaved) {
  denoise_plane(d, 0, y, sy, 1, w, h, d->coefs[0], d->coefs[2]);
  if (interleaved) {
    denoise_plane(d, 1, u, su, 2, w / 2, h / 2, d->coefs[1], d->coefs[3]);
    denoise_plane(d, 2, u + 1, su, 2, w / 2, h / 2, d->coefs[1], d->coefs[3]);
  } else {
    denoise_plane(d, 1, u, su, 1, w / 2, h / 2, d->coefs[1], d->coefs[3]);
    denoise_plane(d, 2, v, sv, 1, w / 2, h / 2, d->coefs[1], d->coefs[3]);
  }
}
