/*
 * Emscripten's <smmintrin.h> for Pare's WebAssembly build of SVT-AV1, with MPSADBW and PHMINPOSUW in SIMD128.
 *
 * Emscripten emulates both with scalar loops, and SVT-AV1's motion search is built on them: every MPSADBW (32 byte
 * extractions in the scalar version, and AVX2's _mm256_mpsadbw_epu8 is two of them) is followed by a PHMINPOSUW to
 * pick the best of its eight positions. Here MPSADBW builds each byte-shifted operand with one shuffle that also
 * zero-extends to 16 bits (eight shuffles, four subtractions, four absolute values, three additions), and
 * PHMINPOSUW is a three-step min reduction plus a bitmask. Results are identical to the originals.
 */
#ifndef PARE_SMMINTRIN_H
#define PARE_SMMINTRIN_H

#define _mm_mpsadbw_epu8 __emscripten_scalar_mpsadbw_epu8
#define _mm_minpos_epu16 __emscripten_scalar_minpos_epu16
#include_next <smmintrin.h>
#undef _mm_mpsadbw_epu8
#undef _mm_minpos_epu16

/* PHMINPOSUW: the smallest of eight u16 lanes and the lowest lane holding it, as value | index << 16 in lane 0.
 * Emscripten's version is a scalar loop; SVT-AV1 runs it on every MPSADBW result to find the best position. */
static __inline__ __m128i __attribute__((__always_inline__, __nodebug__)) _mm_minpos_epu16(__m128i __a) {
    v128_t v = (v128_t)__a;
    v128_t m = wasm_u16x8_min(v, wasm_i32x4_shuffle(v, v, 2, 3, 0, 1));
    m = wasm_u16x8_min(m, wasm_i32x4_shuffle(m, m, 1, 0, 3, 2));
    m = wasm_u16x8_min(m, wasm_i16x8_shuffle(m, m, 1, 0, 3, 2, 5, 4, 7, 6));
    unsigned index = __builtin_ctz(wasm_i16x8_bitmask(wasm_i16x8_eq(v, m)));
    return (__m128i)wasm_i32x4_make((int)(wasm_u16x8_extract_lane(m, 0) | (index << 16)), 0, 0, 0);
}

/* Bytes o..o+7 of v, each zero-extended into a 16-bit lane. */
#define __PARE_U16_BYTES(v, o)                                                                              \
    wasm_i8x16_shuffle((v), wasm_i64x2_const(0, 0), (o) + 0, 16, (o) + 1, 16, (o) + 2, 16, (o) + 3, 16, \
                       (o) + 4, 16, (o) + 5, 16, (o) + 6, 16, (o) + 7, 16)
/* Byte o of v in every 16-bit lane. */
#define __PARE_U16_SPLAT(v, o) \
    wasm_i8x16_shuffle((v), wasm_i64x2_const(0, 0), o, 16, o, 16, o, 16, o, 16, o, 16, o, 16, o, 16, o, 16)
#define __PARE_ABSDIFF(a, b, ao, bo, k) \
    wasm_i16x8_abs(wasm_i16x8_sub(__PARE_U16_BYTES(a, (ao) + (k)), __PARE_U16_SPLAT(b, (bo) + (k))))

/* result[i] = sum over k < 4 of |a[i + k + ao] - b[bo + k]|, ao = imm & 4, bo = (imm & 3) * 4. */
#define _mm_mpsadbw_epu8(__A, __B, __imm)                                                          \
    __extension__({                                                                                \
        v128_t __pa = (v128_t)(__A), __pb = (v128_t)(__B);                                         \
        (__m128i) wasm_i16x8_add(                                                                  \
            wasm_i16x8_add(__PARE_ABSDIFF(__pa, __pb, (__imm) & 4, ((__imm) & 3) << 2, 0),          \
                           __PARE_ABSDIFF(__pa, __pb, (__imm) & 4, ((__imm) & 3) << 2, 1)),         \
            wasm_i16x8_add(__PARE_ABSDIFF(__pa, __pb, (__imm) & 4, ((__imm) & 3) << 2, 2),          \
                           __PARE_ABSDIFF(__pa, __pb, (__imm) & 4, ((__imm) & 3) << 2, 3)));        \
    })

#endif
