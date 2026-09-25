#!/bin/bash
# Builds src/lib/x264/x264.{mjs,wasm} and the threaded x264-mt.{mjs,wasm}: x264 at X264_COMMIT +
# x264-simd128.patch, with the pare_x264.c binding.
# Needs an activated Emscripten SDK (emcc on PATH). Also builds and runs x264's checkasm to verify every
# SIMD kernel bit-for-bit against the C reference.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=${WORK:-$(mktemp -d)}
git clone -q https://code.videolan.org/videolan/x264.git "$work/x264"
cd "$work/x264"
git checkout -q "$(cat "$here/X264_COMMIT")"
git apply "$here/x264-simd128.patch"
CC=emcc AR=emar RANLIB=emranlib STRINGS="$(dirname "$(which emcc)")/../bin/llvm-strings" ./configure \
  --host=i686-gnu --disable-asm --disable-cli --enable-static --disable-thread --disable-opencl \
  --bit-depth=8 --chroma-format=420 --extra-cflags="-O3 -msimd128 -DHAVE_SIMD128=1" >/dev/null
make -j"$(nproc)" >/dev/null

emcc -O2 -msimd128 -DHAVE_SIMD128=1 -DBIT_DEPTH=8 -DHIGH_BIT_DEPTH=0 -I. tools/checkasm.c libx264.a \
  -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=4MB -o checkasm.cjs
node checkasm.cjs

exports=_enc_import_rgba,_enc_import_p16,_enc_open,_enc_plane,_enc_stride,_enc_headers,_enc_headers_ptr,_enc_encode,_enc_flush,_enc_payload,_enc_out_pts,_enc_out_dts,_enc_out_keyframe,_enc_out_ssim,_enc_close,_malloc,_free
out="$here/../src/lib/x264"
emcc "$here/pare_x264.c" -I. libx264.a -O3 -msimd128 \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createX264 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=$exports -sEXPORTED_RUNTIME_METHODS=HEAPU8,stringToNewUTF8 \
  -o "$out/x264.mjs"

# The threaded build: x264 with its own frame threads, which run as Web Workers sharing the module's memory. The
# pool size comes from createX264({ threads }), and the thread workers load the glue from its own URL, so Vite's
# hashed asset name still resolves.
make distclean >/dev/null
CC=emcc AR=emar RANLIB=emranlib STRINGS="$(dirname "$(which emcc)")/../bin/llvm-strings" ./configure \
  --host=i686-gnu --disable-asm --disable-cli --enable-static --disable-opencl \
  --bit-depth=8 --chroma-format=420 --extra-cflags="-O3 -msimd128 -DHAVE_SIMD128=1 -pthread" \
  --extra-ldflags="-pthread" >/dev/null
make -j"$(nproc)" >/dev/null
emcc "$here/pare_x264.c" -I. libx264.a -O3 -msimd128 -pthread \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createX264 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH -sGROWABLE_ARRAYBUFFERS=2 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB \
  -sPTHREAD_POOL_SIZE=Module.threads \
  -sEXPORTED_FUNCTIONS=$exports -sEXPORTED_RUNTIME_METHODS=HEAPU8,stringToNewUTF8 \
  -o "$out/x264-mt.mjs"
sed -i 's#new URL("x264-mt.mjs",import.meta.url)#import.meta.url#' "$out/x264-mt.mjs"
