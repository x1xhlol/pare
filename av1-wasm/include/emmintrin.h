/*
 * Emscripten's <emmintrin.h> for Pare's WebAssembly build of SVT-AV1, with a shorter PSADBW.
 *
 * _mm_sad_epu8 sums |a - b| over each 8-byte half into a 64-bit lane. WebAssembly's pairwise extending adds do the
 * 16- and 32-bit steps directly, which saves three instructions over Emscripten's shift-and-add version.
 */
#ifndef PARE_EMMINTRIN_H
#define PARE_EMMINTRIN_H

#define _mm_sad_epu8 __emscripten_sad_epu8
#include_next <emmintrin.h>
#undef _mm_sad_epu8

static __inline__ __m128i __attribute__((__always_inline__, __nodebug__)) _mm_sad_epu8(__m128i __a, __m128i __b) {
    v128_t diff = wasm_v128_or(wasm_u8x16_sub_sat((v128_t)__a, (v128_t)__b), wasm_u8x16_sub_sat((v128_t)__b, (v128_t)__a));
    v128_t quads = wasm_u32x4_extadd_pairwise_u16x8(wasm_u16x8_extadd_pairwise_u8x16(diff));
    /* Lanes 0 and 2 get the sum of their 64-bit half; lanes 1 and 3 are cleared. */
    v128_t sums = wasm_i32x4_add(quads, wasm_u64x2_shr(quads, 32));
    return (__m128i)wasm_v128_and(sums, wasm_i64x2_const(0xffffffff, 0xffffffff));
}

#endif
