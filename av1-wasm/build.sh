#!/bin/bash
# Builds SVT-AV1 for WebAssembly with SIMD and runs its checks. Needs an activated Emscripten SDK and python3.
#
#   ISA=x86  (default) SSE2..AVX2 intrinsics translated by Emscripten, with the replacement headers in include/
#            and the kernels written for WebAssembly in the patch's Source/Lib/ASM_WASM
#   ISA=neon Arm Neon intrinsics translated through SIMDe (Emscripten's arm_neon.h)
#
# Output: build/Bin/Release/SvtAv1EncApp.{js,wasm} (a Node build of the command-line encoder, for benchmarks),
# src/lib/av1/av1.{mjs,wasm} (the browser module), and
# SvtAv1UnitTests.js with TESTS=1. Both builds produce output byte-identical to native SVT-AV1.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
isa=${ISA:-x86}
work=${WORK:-$(mktemp -d)}
[ -d "$work/svt-av1" ] || git clone -q https://gitlab.com/AOMediaCodec/SVT-AV1.git "$work/svt-av1"
cd "$work/svt-av1"
git checkout -q "$(cat "$here/SVT_AV1_COMMIT")"
git apply "$here/svt-av1-wasm.patch"

# Dispatch entries that would reach NASM/.S assembly fall back to the next implementation in line.
python3 "$here/gen_fallbacks.py" . "$here/asm_symbols_$isa.txt" "$isa"

flags="-pthread -msimd128"
[ "$isa" = x86 ] && flags="$flags -msse4.1 -I$here/include"
opts=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=ON -DBUILD_TESTING="${TESTS:-OFF}"
      -DSVT_AV1_LTO=OFF -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags"
      -DCMAKE_EXE_LINKER_FLAGS="-pthread -sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
-sPTHREAD_POOL_SIZE=64 -sSTACK_SIZE=4MB -sEXIT_RUNTIME=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=0")
[ "$isa" = neon ] && opts+=(-DSVT_WASM_NEON=ON)
emcmake cmake -S . -B build "${opts[@]}" >/dev/null
cmake --build build -j"$(nproc)" --target SvtAv1EncApp
[ "${TESTS:-OFF}" = ON ] && cmake --build build -j"$(nproc)" --target SvtAv1UnitTests
ls -la Bin/Release/

# The browser module: the library again without pthreads (Pare runs one encoder per worker, one thread each), linked
# with the binding in pare_svtav1.c into src/lib/av1/av1.{mjs,wasm}. The one symbol left undefined is the SSE4.2
# CRC32 hash, which the dispatch fallbacks never call.
flags_st="-msimd128"
[ "$isa" = x86 ] && flags_st="$flags_st -msse4.1 -I$here/include"
opts_st=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF -DBUILD_TESTING=OFF -DSVT_AV1_LTO=OFF
         -DCMAKE_C_FLAGS="$flags_st" -DCMAKE_CXX_FLAGS="$flags_st")
[ "$isa" = neon ] && opts_st+=(-DSVT_WASM_NEON=ON)
emcmake cmake -S . -B build-web "${opts_st[@]}" >/dev/null
cmake --build build-web -j"$(nproc)" --target SvtAv1Enc
exports=_enc_open,_enc_plane,_enc_stride,_enc_headers,_enc_headers_ptr,_enc_encode,_enc_flush,_enc_payload,_enc_out_pts,_enc_out_dts,_enc_out_keyframe,_enc_out_ssim,_enc_close,_enc_import_rgba,_enc_import_p16,_malloc,_free
emcc "$here/pare_svtav1.c" -I Source/API Bin/Release/libSvtAv1Enc.a -O3 -msimd128 \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createAv1 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_FUNCTIONS=$exports -sEXPORTED_RUNTIME_METHODS=HEAPU8,stringToNewUTF8 \
  -o "$here/../src/lib/av1/av1.mjs"
