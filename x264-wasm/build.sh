#!/bin/bash
# Builds src/lib/x264/x264.{mjs,wasm} and the threaded x264-mt.{mjs,wasm}: x264 at X264_COMMIT plus the WebAssembly
# series in patches/ (prepared for upstream: build support in configure, and SIMD128 kernels in common/wasm), with the
# pare_x264.c binding. Needs an activated Emscripten SDK (emcc on PATH) and Node. Also builds and runs x264's checkasm
# to verify every SIMD kernel bit-for-bit against the C reference.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=${WORK:-$(mktemp -d)}
git clone -q https://code.videolan.org/videolan/x264.git "$work/x264"
cd "$work/x264"
git checkout -q "$(cat "$here/X264_COMMIT")"
git -c user.name=build -c user.email=build@localhost am -q "$here"/patches/*.patch
host=--host=wasm32-unknown-emscripten
tools="CC=emcc AR=emar RANLIB=emranlib STRINGS=$(dirname "$(which emcc)")/../bin/llvm-strings"

# checkasm, on a build with the CLI's link settings.
env $tools ./configure $host --extra-ldflags="-sSTACK_SIZE=4MB -sALLOW_MEMORY_GROWTH -sNODERAWFS -sEXIT_RUNTIME" >/dev/null
make -j"$(nproc)" checkasm >/dev/null
node checkasm8

exports=_enc_import_rgba,_enc_import_p16,_scale_plane,_enc_open,_enc_plane,_enc_stride,_enc_headers,_enc_headers_ptr,_enc_encode,_enc_flush,_enc_payload,_enc_out_pts,_enc_out_dts,_enc_out_keyframe,_enc_out_ssim,_enc_close,_malloc,_free
out="$here/../src/lib/x264"

# One thread per encoder.
make distclean >/dev/null
env $tools ./configure $host --disable-cli --enable-static --disable-thread --bit-depth=8 --chroma-format=420 \
  --extra-cflags=-O3 >/dev/null
make -j"$(nproc)" lib-static >/dev/null
emcc "$here/pare_x264.c" -I. libx264.a -O3 -msimd128 \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createX264 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=$exports -sEXPORTED_RUNTIME_METHODS=HEAPU8,stringToNewUTF8 \
  -o "$out/x264.mjs"

# The threaded build: x264 with its own frame threads, which run as Web Workers sharing the module's memory. The
# pool size comes from createX264({ threads }), and the thread workers load the glue from its own URL, so Vite's
# hashed asset name still resolves.
make distclean >/dev/null
env $tools ./configure $host --disable-cli --enable-static --bit-depth=8 --chroma-format=420 \
  --extra-cflags="-O3 -pthread" --extra-ldflags=-pthread >/dev/null
make -j"$(nproc)" lib-static >/dev/null
emcc "$here/pare_x264.c" -I. libx264.a -O3 -msimd128 -pthread \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createX264 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH -sGROWABLE_ARRAYBUFFERS=2 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB \
  -sPTHREAD_POOL_SIZE=Module.threads \
  -sEXPORTED_FUNCTIONS=$exports -sEXPORTED_RUNTIME_METHODS=HEAPU8,stringToNewUTF8 \
  -o "$out/x264-mt.mjs"
sed -i 's#new URL("x264-mt.mjs",import.meta.url)#import.meta.url#' "$out/x264-mt.mjs"
