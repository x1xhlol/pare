#!/bin/bash
# Builds libvmaf for WebAssembly, with its AVX2 feature kernels translated to WebAssembly SIMD by Emscripten, and
# links Pare's binding into src/lib/vmaf/vmaf.{mjs,wasm}. Needs an activated Emscripten SDK, meson and ninja.
#
# Scores match native libvmaf (VMAF NEG 89.34677 against 89.34658 on a 1080p x264 test window).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../src/lib/vmaf"
work=${WORK:-$(mktemp -d)}
[ -d "$work/vmaf" ] || git clone -q https://github.com/Netflix/vmaf.git "$work/vmaf"
cd "$work/vmaf"
git checkout -q "$(cat "$here/LIBVMAF_COMMIT")"
git apply "$here/libvmaf-wasm.patch"
cd libvmaf
cat > "$work/emscripten.cross" <<CROSS
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'

[built-in options]
c_args = ['-O3', '-msimd128']
cpp_args = ['-O3', '-msimd128']

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
CROSS
meson setup build-wasm --cross-file "$work/emscripten.cross" --buildtype=release -Ddefault_library=static \
  -Denable_tests=false -Denable_docs=false -Denable_asm=true -Denable_avx512=false -Dbuilt_in_models=true \
  -Denable_float=false >/dev/null
ninja -C build-wasm src/libvmaf.a >/dev/null
emcc -c "$here/pare_vmaf.c" -Iinclude -Ibuild-wasm/include -O3 -msimd128 -o build-wasm/pare_vmaf.o
mkdir -p "$out"
em++ build-wasm/pare_vmaf.o build-wasm/src/libvmaf.a -O3 -msimd128 \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createVmaf -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_score_open,_score_ref,_score_dist,_score_add,_score_finish,_score_close \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 -o "$out/vmaf.mjs"
ls -la "$out"
