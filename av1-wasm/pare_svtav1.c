// SVT-AV1 binding for the browser, with the same C API as x264-wasm/pare_x264.c so Pare's encode worker drives
// either encoder unchanged. JS writes frames into the input planes, calls enc_encode, and reads temporal units back
// out of WebAssembly memory, one per call.
//
// Differences from x264 that this file hides:
// - SVT-AV1 takes planar 4:2:0 only. For NV12 input, plane 1 is an interleaved chroma buffer that enc_encode splits.
// - Output packets start with a temporal delimiter OBU, which MP4 samples must not contain; it's dropped.
// - Per-frame SSIM comes from SVT-AV1's stat report (enable-stat-report=1 in the options).
// - SVT-AV1 may hold several finished frames; enc_encode returns at most one and enc_flush drains the rest.
// - With input-depth=10 in the options, the input planes hold 16-bit samples (10-bit values) and must be I420; strides
//   are reported in bytes either way.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "EbSvtAv1Enc.h"
#include "../x264-wasm/pare_scale.h"

#define CSP_I420 0x0002
#define CSP_NV12 0x0004

typedef struct {
  EbComponentType *h;
  EbSvtAv1EncConfiguration cfg;
  EbBufferHeaderType in;
  EbSvtIOFormat io;
  uint8_t *y, *u, *v, *uv; // uv: interleaved chroma for NV12 input
  int width, height, csp;
  int bytes; // per sample: 2 when encoding 10-bit
  int64_t frames_in;
  int eos_sent, done;
  EbBufferHeaderType *out;
  uint8_t *payload;
  int payload_size;
  uint8_t headers[256];
  int headers_size;
} Encoder;

// `options` is "preset;tune;key=value;..." like the x264 binding. The first two fields are the SVT-AV1 preset and
// an optional tune; the rest go to svt_av1_enc_parse_parameter, which takes SvtAv1EncApp's option names.
EMSCRIPTEN_KEEPALIVE
Encoder *enc_open(int width, int height, int fps_num, int fps_den, int csp, const char *options) {
  Encoder *e = calloc(1, sizeof(Encoder));
  e->width = width;
  e->height = height;
  e->csp = csp;
  if (svt_av1_enc_init_handle(&e->h, &e->cfg) != EB_ErrorNone) goto fail;
  e->cfg.source_width = width;
  e->cfg.source_height = height;
  e->cfg.frame_rate_numerator = fps_num;
  e->cfg.frame_rate_denominator = fps_den;
  e->cfg.encoder_bit_depth = 8;
  e->cfg.level_of_parallelism = 1; // one thread: Pare runs one encoder per core

  char *copy = strdup(options), *rest = copy;
  char *preset = strsep(&rest, ";");
  char *tune = strsep(&rest, ";");
  int ok = (!preset || !*preset || svt_av1_enc_parse_parameter(&e->cfg, "preset", preset) == EB_ErrorNone) &&
           (!tune || !*tune || svt_av1_enc_parse_parameter(&e->cfg, "tune", tune) == EB_ErrorNone);
  for (char *pair = strsep(&rest, ";"); ok && pair; pair = strsep(&rest, ";")) {
    if (!*pair) continue;
    char *value = strchr(pair, '=');
    if (!value) { ok = 0; break; }
    *value++ = 0;
    // "threads" and "ssim" are x264 options Pare adds for every encoder; SVT-AV1 has its own equivalents.
    if (!strcmp(pair, "threads")) continue;
    if (!strcmp(pair, "ssim")) {
      e->cfg.stat_report = atoi(value);
      continue;
    }
    ok = svt_av1_enc_parse_parameter(&e->cfg, pair, value) == EB_ErrorNone;
  }
  free(copy);
  if (!ok) goto fail;
  if (svt_av1_enc_set_parameter(e->h, &e->cfg) != EB_ErrorNone) goto fail;
  if (svt_av1_enc_init(e->h) != EB_ErrorNone) goto fail;

  EbBufferHeaderType *header = NULL;
  if (svt_av1_enc_stream_header(e->h, &header) == EB_ErrorNone && header) {
    e->headers_size = header->n_filled_len < sizeof e->headers ? header->n_filled_len : 0;
    memcpy(e->headers, header->p_buffer, e->headers_size);
    svt_av1_enc_stream_header_release(header);
  }

  const int cw = (width + 1) / 2, ch = (height + 1) / 2;
  e->bytes = e->cfg.encoder_bit_depth > 8 ? 2 : 1;
  if (e->bytes == 2 && csp == CSP_NV12) goto fail_init;
  e->y = malloc((size_t)width * height * e->bytes);
  e->u = malloc((size_t)cw * ch * e->bytes);
  e->v = malloc((size_t)cw * ch * e->bytes);
  if (csp == CSP_NV12) e->uv = malloc((size_t)cw * 2 * ch);
  e->io.luma = e->y;
  e->io.cb = e->u;
  e->io.cr = e->v;
  e->io.y_stride = width;
  e->io.cb_stride = cw;
  e->io.cr_stride = cw;
  e->in.size = sizeof(EbBufferHeaderType);
  e->in.p_buffer = (uint8_t *)&e->io;
  e->in.n_filled_len = (uint32_t)(width * height + 2 * cw * ch) * e->bytes;
  e->in.n_alloc_len = e->in.n_filled_len;
  e->in.pic_type = EB_AV1_INVALID_PICTURE;
  return e;

fail_init:
  svt_av1_enc_deinit(e->h);
fail:
  if (e->h) svt_av1_enc_deinit_handle(e->h);
  free(e);
  return NULL;
}

// Plane 0 is luma. With I420 input, planes 1 and 2 are cb and cr; with NV12, plane 1 is interleaved chroma.
EMSCRIPTEN_KEEPALIVE uint8_t *enc_plane(Encoder *e, int i) {
  return i == 0 ? e->y : e->csp == CSP_NV12 ? (i == 1 ? e->uv : NULL) : (i == 1 ? e->u : e->v);
}
EMSCRIPTEN_KEEPALIVE int enc_stride(Encoder *e, int i) {
  const int cw = (e->width + 1) / 2;
  return (i == 0 ? e->width : e->csp == CSP_NV12 ? 2 * cw : cw) * e->bytes;
}

// The sequence header OBU (Pare reads the level and tier from it for the MP4 codec string).
EMSCRIPTEN_KEEPALIVE int enc_headers(Encoder *e) { return e->headers_size; }
EMSCRIPTEN_KEEPALIVE uint8_t *enc_headers_ptr(Encoder *e) { return e->headers; }

static void release(Encoder *e) {
  if (e->out) svt_av1_enc_release_out_buffer(&e->out);
  e->out = NULL;
}

// Takes one finished temporal unit if there is one. Returns its size, 0 if none is ready, -1 at end of stream.
static int receive(Encoder *e, int done_sending) {
  release(e);
  if (e->done) return -1;
  EbBufferHeaderType *out = NULL;
  EbErrorType err = svt_av1_enc_get_packet(e->h, &out, (uint8_t)done_sending);
  if (err == EB_NoErrorEmptyQueue || !out) return 0;
  if (err != EB_ErrorNone) return -2;
  e->out = out;
  if (out->flags & EB_BUFFERFLAG_EOS) e->done = 1;
  uint8_t *p = out->p_buffer;
  int size = (int)out->n_filled_len;
  // Drop a leading temporal delimiter (OBU type 2 with obu_has_size_field: 0x12 0x00).
  if (size >= 2 && (p[0] >> 3 & 15) == 2 && p[1] == 0) p += 2, size -= 2;
  e->payload = p;
  e->payload_size = size;
  if (size == 0 && e->done) return -1;
  return size;
}

static void split_chroma(Encoder *e) {
  const int cw = (e->width + 1) / 2, ch = (e->height + 1) / 2;
  for (int y = 0; y < ch; y++) {
    const uint8_t *s = e->uv + (size_t)y * 2 * cw;
    uint8_t *u = e->u + (size_t)y * cw, *v = e->v + (size_t)y * cw;
    for (int x = 0; x < cw; x++) u[x] = s[2 * x], v[x] = s[2 * x + 1];
  }
}

// Encodes the frame in the input planes. Returns the size of an output temporal unit (0 if none is ready yet).
EMSCRIPTEN_KEEPALIVE int enc_encode(Encoder *e, double pts) {
  if (e->csp == CSP_NV12) split_chroma(e);
  e->in.pts = (int64_t)pts;
  e->in.flags = 0;
  if (svt_av1_enc_send_picture(e->h, &e->in) != EB_ErrorNone) return -2;
  e->frames_in++;
  return receive(e, 0);
}

// Drains one delayed temporal unit. Returns its size, 0 if nothing was emitted, or -1 when fully drained.
EMSCRIPTEN_KEEPALIVE int enc_flush(Encoder *e) {
  if (!e->eos_sent) {
    EbBufferHeaderType eos = {0};
    eos.size = sizeof(EbBufferHeaderType);
    eos.flags = EB_BUFFERFLAG_EOS;
    eos.pic_type = EB_AV1_INVALID_PICTURE;
    svt_av1_enc_send_picture(e->h, &eos);
    e->eos_sent = 1;
  }
  int size;
  // Blocking once everything is sent: SVT-AV1 returns a packet or the end of stream.
  while ((size = receive(e, 1)) == 0 && !e->done) {}
  return size;
}

EMSCRIPTEN_KEEPALIVE uint8_t *enc_payload(Encoder *e) { return e->payload; }
EMSCRIPTEN_KEEPALIVE double enc_out_pts(Encoder *e) { return e->out ? (double)e->out->pts : 0; }
EMSCRIPTEN_KEEPALIVE double enc_out_dts(Encoder *e) { return e->out ? (double)e->out->dts : 0; }
EMSCRIPTEN_KEEPALIVE int enc_out_keyframe(Encoder *e) { return e->out && e->out->pic_type == EB_AV1_KEY_PICTURE; }
EMSCRIPTEN_KEEPALIVE double enc_out_ssim(Encoder *e) { return e->out ? e->out->luma_ssim : 0; }

EMSCRIPTEN_KEEPALIVE void enc_close(Encoder *e) {
  release(e);
  svt_av1_enc_deinit(e->h);
  svt_av1_enc_deinit_handle(e->h);
  free(e->y);
  free(e->u);
  free(e->v);
  free(e->uv);
  free(e);
}

// RGBA/RGBX (or BGRA/BGRX when bgr != 0) to the input planes, BT.709 limited range, as in pare_x264.c.
static void widen(Encoder *e);

EMSCRIPTEN_KEEPALIVE void enc_import_rgba(Encoder *e, const uint8_t *rgba, int stride, int width, int height, int bgr) {
  const int ri = bgr ? 2 : 0, bi = bgr ? 0 : 2;
  for (int y = 0; y < height; y++) {
    const uint8_t *s = rgba + y * stride;
    for (int x = 0; x < width; x++, s += 4)
      e->y[y * e->width + x] = (uint8_t)(((47 * s[ri] + 157 * s[1] + 16 * s[bi] + 128) >> 8) + 16);
  }
  uint8_t *uvp = e->csp == CSP_NV12 ? e->uv : NULL;
  const int cw = (e->width + 1) / 2;
  for (int y = 0; y < height / 2; y++) {
    const uint8_t *a = rgba + 2 * y * stride, *b = a + stride;
    for (int x = 0; x < width / 2; x++, a += 8, b += 8) {
      int r = a[ri] + a[ri + 4] + b[ri] + b[ri + 4];
      int g = a[1] + a[5] + b[1] + b[5];
      int bl = a[bi] + a[bi + 4] + b[bi] + b[bi + 4];
      uint8_t cb = (uint8_t)(((-26 * r - 86 * g + 112 * bl + 512) >> 10) + 128);
      uint8_t cr = (uint8_t)(((112 * r - 102 * g - 10 * bl + 512) >> 10) + 128);
      if (uvp) uvp[y * 2 * cw + 2 * x] = cb, uvp[y * 2 * cw + 2 * x + 1] = cr;
      else e->u[y * cw + x] = cb, e->v[y * cw + x] = cr;
    }
  }
  if (e->bytes == 2) widen(e);
}

// A 10-bit encoder's planes after an 8-bit import: each sample moved to 16 bits and scaled to 10, from the end so the
// 8-bit samples aren't overwritten before they're read.
static void widen(Encoder *e) {
  const int cw = (e->width + 1) / 2, ch = (e->height + 1) / 2;
  uint8_t *planes[3] = {e->y, e->u, e->v};
  const size_t counts[3] = {(size_t)e->width * e->height, (size_t)cw * ch, (size_t)cw * ch};
  for (int p = 0; p < 3; p++)
    for (size_t i = counts[p]; i-- > 0;) ((uint16_t *)planes[p])[i] = (uint16_t)(planes[p][i] << 2);
}

// 16-bit planar 4:2:0 (10- or 12-bit samples) to the input planes: as 10-bit samples for a 10-bit encoder, otherwise
// rounded to 8 bits.
EMSCRIPTEN_KEEPALIVE void enc_import_p16(Encoder *e, const uint16_t *py, const uint16_t *pu, const uint16_t *pv,
                                         int sy, int su, int sv, int width, int height, int bits) {
  if (e->bytes == 2) {
    const int s10 = bits - 10, r10 = s10 > 0 ? 1 << (s10 - 1) : 0, cw = (e->width + 1) / 2;
    uint16_t *dy = (uint16_t *)e->y, *du = (uint16_t *)e->u, *dv = (uint16_t *)e->v;
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x++) {
        int v = (py[y * sy + x] + r10) >> s10;
        dy[y * e->width + x] = (uint16_t)(v > 1023 ? 1023 : v);
      }
    for (int y = 0; y < height / 2; y++)
      for (int x = 0; x < width / 2; x++) {
        int u = (pu[y * su + x] + r10) >> s10, v = (pv[y * sv + x] + r10) >> s10;
        du[y * cw + x] = (uint16_t)(u > 1023 ? 1023 : u), dv[y * cw + x] = (uint16_t)(v > 1023 ? 1023 : v);
      }
    return;
  }
  const int shift = bits - 8, round = 1 << (shift - 1), cw = (e->width + 1) / 2;
  for (int y = 0; y < height; y++)
    for (int x = 0; x < width; x++) {
      int v = (py[y * sy + x] + round) >> shift;
      e->y[y * e->width + x] = (uint8_t)(v > 255 ? 255 : v);
    }
  uint8_t *uvp = e->csp == CSP_NV12 ? e->uv : NULL;
  for (int y = 0; y < height / 2; y++)
    for (int x = 0; x < width / 2; x++) {
      int u = (pu[y * su + x] + round) >> shift, v = (pv[y * sv + x] + round) >> shift;
      u = u > 255 ? 255 : u, v = v > 255 ? 255 : v;
      if (uvp) uvp[y * 2 * cw + 2 * x] = (uint8_t)u, uvp[y * 2 * cw + 2 * x + 1] = (uint8_t)v;
      else e->u[y * cw + x] = (uint8_t)u, e->v[y * cw + x] = (uint8_t)v;
    }
}
