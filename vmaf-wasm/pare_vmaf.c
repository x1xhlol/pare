// VMAF NEG in the browser, for choosing a codec from the size plan's test encodes. JS writes a source frame's and the
// decoded test frame's luma into the two staging planes and calls score_add; score_finish returns the mean score from
// frame `first` on, so a leading frame can prime VMAF's motion feature without being counted. VMAF reads luma only,
// so the pictures carry flat chroma.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include <libvmaf/libvmaf.h>
#include <libvmaf/model.h>

typedef struct {
  VmafContext *ctx;
  VmafModel *model;
  int width, height;
  unsigned frames;
  uint8_t *ref, *dist;
} Scorer;

static int picture(VmafPicture *pic, const uint8_t *luma, int width, int height) {
  if (vmaf_picture_alloc(pic, VMAF_PIX_FMT_YUV420P, 8, width, height)) return -1;
  for (int y = 0; y < height; y++) memcpy((uint8_t *)pic->data[0] + y * pic->stride[0], luma + y * width, width);
  for (int p = 1; p < 3; p++) memset(pic->data[p], 128, pic->stride[p] * pic->h[p]);
  return 0;
}

EMSCRIPTEN_KEEPALIVE
Scorer *score_open(int width, int height) {
  Scorer *s = calloc(1, sizeof(Scorer));
  VmafConfiguration cfg = { .log_level = VMAF_LOG_LEVEL_NONE, .n_threads = 0 };
  VmafModelConfig model = { .name = "vmaf_neg", .flags = VMAF_MODEL_FLAGS_DEFAULT };
  if (vmaf_init(&s->ctx, cfg) || vmaf_model_load(&s->model, &model, "vmaf_v0.6.1neg") ||
      vmaf_use_features_from_model(s->ctx, s->model)) {
    free(s);
    return NULL;
  }
  s->width = width;
  s->height = height;
  s->ref = malloc((size_t)width * height);
  s->dist = malloc((size_t)width * height);
  return s;
}

EMSCRIPTEN_KEEPALIVE uint8_t *score_ref(Scorer *s) { return s->ref; }
EMSCRIPTEN_KEEPALIVE uint8_t *score_dist(Scorer *s) { return s->dist; }

/** Scores the frame pair in the staging planes. */
EMSCRIPTEN_KEEPALIVE
int score_add(Scorer *s) {
  VmafPicture ref, dist;
  if (picture(&ref, s->ref, s->width, s->height)) return -1;
  if (picture(&dist, s->dist, s->width, s->height)) return -1;
  return vmaf_read_pictures(s->ctx, &ref, &dist, s->frames++);
}

/** Mean VMAF NEG over the frames added from `first` on, or -1. */
EMSCRIPTEN_KEEPALIVE
double score_finish(Scorer *s, unsigned first) {
  double score = -1;
  if (first >= s->frames || vmaf_read_pictures(s->ctx, NULL, NULL, 0)) return -1;
  if (vmaf_score_pooled(s->ctx, s->model, VMAF_POOL_METHOD_MEAN, &score, first, s->frames - 1)) return -1;
  return score;
}

EMSCRIPTEN_KEEPALIVE
void score_close(Scorer *s) {
  vmaf_model_destroy(s->model);
  vmaf_close(s->ctx);
  free(s->ref);
  free(s->dist);
  free(s);
}
