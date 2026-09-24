// Minimal x264 binding for the browser. JS writes frames straight into the input planes, calls enc_encode, and
// reads length-prefixed NAL units back out of WebAssembly memory.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "x264.h"

typedef struct {
  x264_t *h;
  x264_picture_t in;
  x264_picture_t out;
  int csp;
  uint8_t *payload;
  int payload_size;
  uint8_t *headers;
  int headers_size;
} Encoder;

// `options` is "preset;tune;key=value;key=value..." using x264's own option names (the same as the CLI flags).
EMSCRIPTEN_KEEPALIVE
Encoder *enc_open(int width, int height, int fps_num, int fps_den, int csp, const char *options) {
  char *copy = strdup(options);
  char *rest = copy;
  char *preset = strsep(&rest, ";");
  char *tune = strsep(&rest, ";");

  x264_param_t p;
  if (x264_param_default_preset(&p, preset, tune && *tune ? tune : NULL) < 0) goto fail;
  p.i_width = width;
  p.i_height = height;
  p.i_fps_num = fps_num;
  p.i_fps_den = fps_den;
  p.i_timebase_num = fps_den;
  p.i_timebase_den = fps_num;
  p.i_csp = csp;
  p.i_threads = 1;
  p.b_annexb = 0;
  p.b_repeat_headers = 0;
  p.i_log_level = X264_LOG_ERROR;

  for (char *pair = strsep(&rest, ";"); pair; pair = strsep(&rest, ";")) {
    if (!*pair) continue;
    char *value = strchr(pair, '=');
    if (value) *value++ = 0;
    if (x264_param_parse(&p, pair, value) < 0) goto fail;
  }
  if (x264_param_apply_profile(&p, "high") < 0) goto fail;

  Encoder *e = calloc(1, sizeof(Encoder));
  e->csp = csp;
  e->h = x264_encoder_open(&p);
  if (!e->h || x264_picture_alloc(&e->in, csp, width, height) < 0) {
    free(e);
    goto fail;
  }
  free(copy);
  return e;

fail:
  free(copy);
  return NULL;
}

EMSCRIPTEN_KEEPALIVE uint8_t *enc_plane(Encoder *e, int i) { return e->in.img.plane[i]; }
EMSCRIPTEN_KEEPALIVE int enc_stride(Encoder *e, int i) { return e->in.img.i_stride[i]; }

// Writes SPS, PPS and SEI (each prefixed with a 4-byte big-endian length) and returns their total size.
EMSCRIPTEN_KEEPALIVE int enc_headers(Encoder *e) {
  x264_nal_t *nals;
  int count;
  int size = x264_encoder_headers(e->h, &nals, &count);
  if (size < 0) return size;
  e->headers = nals[0].p_payload;
  e->headers_size = size;
  return size;
}
EMSCRIPTEN_KEEPALIVE uint8_t *enc_headers_ptr(Encoder *e) { return e->headers; }

static int collect(Encoder *e, x264_nal_t *nals, int count, int size) {
  // x264 guarantees that the payloads of one call are contiguous in memory.
  e->payload = count > 0 ? nals[0].p_payload : NULL;
  e->payload_size = size;
  return size;
}

// Encodes the frame currently in the input planes. Returns the size of the output (0 while the lookahead fills).
EMSCRIPTEN_KEEPALIVE int enc_encode(Encoder *e, double pts) {
  x264_nal_t *nals;
  int count;
  e->in.i_pts = (int64_t)pts;
  e->in.i_type = X264_TYPE_AUTO;
  int size = x264_encoder_encode(e->h, &nals, &count, &e->in, &e->out);
  return size < 0 ? size : collect(e, nals, count, size);
}

// Drains one delayed frame. Returns its size, 0 if there was nothing to emit, or -1 when fully drained.
EMSCRIPTEN_KEEPALIVE int enc_flush(Encoder *e) {
  if (x264_encoder_delayed_frames(e->h) <= 0) return -1;
  x264_nal_t *nals;
  int count;
  int size = x264_encoder_encode(e->h, &nals, &count, NULL, &e->out);
  return size < 0 ? size : collect(e, nals, count, size);
}

EMSCRIPTEN_KEEPALIVE uint8_t *enc_payload(Encoder *e) { return e->payload; }
EMSCRIPTEN_KEEPALIVE double enc_out_pts(Encoder *e) { return (double)e->out.i_pts; }
EMSCRIPTEN_KEEPALIVE double enc_out_dts(Encoder *e) { return (double)e->out.i_dts; }
EMSCRIPTEN_KEEPALIVE int enc_out_keyframe(Encoder *e) { return e->out.b_keyframe; }

EMSCRIPTEN_KEEPALIVE void enc_close(Encoder *e) {
  x264_encoder_close(e->h);
  x264_picture_clean(&e->in);
  free(e);
}

// RGBA/RGBX (or BGRA/BGRX when bgr != 0) to the NV12 input planes, BT.709 limited range.
EMSCRIPTEN_KEEPALIVE void enc_import_rgba(Encoder *e, const uint8_t *rgba, int stride, int width, int height, int bgr) {
  const int ri = bgr ? 2 : 0, bi = bgr ? 0 : 2;
  uint8_t *py = e->in.img.plane[0], *puv = e->in.img.plane[1];
  const int sy = e->in.img.i_stride[0], suv = e->in.img.i_stride[1];
  for (int y = 0; y < height; y++) {
    const uint8_t *s = rgba + y * stride;
    for (int x = 0; x < width; x++, s += 4)
      py[y * sy + x] = (uint8_t)(((47 * s[ri] + 157 * s[1] + 16 * s[bi] + 128) >> 8) + 16);
  }
  for (int y = 0; y < height / 2; y++) {
    const uint8_t *a = rgba + 2 * y * stride, *b = a + stride;
    uint8_t *d = puv + y * suv;
    for (int x = 0; x < width / 2; x++, a += 8, b += 8) {
      int r = a[ri] + a[ri + 4] + b[ri] + b[ri + 4];
      int g = a[1] + a[5] + b[1] + b[5];
      int bl = a[bi] + a[bi + 4] + b[bi] + b[bi + 4];
      d[2 * x] = (uint8_t)(((-26 * r - 86 * g + 112 * bl + 512) >> 10) + 128);
      d[2 * x + 1] = (uint8_t)(((112 * r - 102 * g - 10 * bl + 512) >> 10) + 128);
    }
  }
}

// 16-bit planar 4:2:0 (10- or 12-bit samples) to the NV12 input planes, rounding to 8 bits.
EMSCRIPTEN_KEEPALIVE void enc_import_p16(Encoder *e, const uint16_t *py, const uint16_t *pu, const uint16_t *pv,
                                         int sy, int su, int sv, int width, int height, int bits) {
  const int shift = bits - 8, round = 1 << (shift - 1);
  uint8_t *dy = e->in.img.plane[0], *duv = e->in.img.plane[1];
  const int ty = e->in.img.i_stride[0], tuv = e->in.img.i_stride[1];
  for (int y = 0; y < height; y++)
    for (int x = 0; x < width; x++) {
      int v = (py[y * sy + x] + round) >> shift;
      dy[y * ty + x] = (uint8_t)(v > 255 ? 255 : v);
    }
  for (int y = 0; y < height / 2; y++)
    for (int x = 0; x < width / 2; x++) {
      int u = (pu[y * su + x] + round) >> shift, v = (pv[y * sv + x] + round) >> shift;
      duv[y * tuv + 2 * x] = (uint8_t)(u > 255 ? 255 : u);
      duv[y * tuv + 2 * x + 1] = (uint8_t)(v > 255 ? 255 : v);
    }
}
