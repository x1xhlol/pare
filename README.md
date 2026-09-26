# Pare

Pare makes a video at least half its size and keeps it looking like the original. It runs in the browser tab, so the
file never leaves your computer and there's nothing to install.

**Try it:** https://pare-eight.vercel.app

![A finished compression: 30.7 MB to 13.9 MB, visually identical, with a side-by-side frame comparison](docs/result.jpg)

## Why it's different

Most in-browser video compressors run ffmpeg.wasm. That's x264 with its assembly stripped out, on one thread, and it
works, slowly. Pare started there too, and it took 105 seconds to compress a 20-second phone clip.

Pare now runs its own build of x264:

- **WebAssembly SIMD kernels.** x264 is fast because of hand-written x86 and ARM assembly, which a browser can't run.
  Pare adds about 1,500 lines of WebAssembly SIMD128 in its place: SAD and SATD for motion search, sub-pixel
  interpolation, DCT, quantization, deblocking and more. Each kernel passes x264's own `checkasm` against the C code,
  and whole encodes come out byte-identical to the plain C build. Encoding is 2.0–2.3× faster per core, and the
  result runs at 54% of native x264 with the same settings.
- **The browser decodes.** WebCodecs decodes the source, in hardware when there's a GPU, and frames are copied
  straight into x264's input planes. The encoder module is 830 KB; ffmpeg.wasm is 32 MB. Each chunk's decoder has
  to start at the source keyframe before it, which in a file with a keyframe every 250 frames can be hundreds of
  frames early; H.264 frames that nothing refers to are skipped on the way, about half of them with B-frames.
- **Every core, busy to the end.** The video is split into chunks of equal cost, counting the frames each decoder
  has to work through from the source keyframe before its chunk starts. Each core encodes its own, and the chunks
  are joined at the original frame timestamps. Busy footage still encodes up to 1.5× slower than calm footage, so
  once every chunk has shown its speed, the ones that will finish last hand their final frames to the encoders that
  will finish first, at the cost of a keyframe each. Each encoder also runs two of x264's own frame threads, from a
  second build compiled with pthreads. The second thread keeps x264 working while the encoder waits for decoded frames,
  which makes encoding 13% faster on the same cores. Machines with more than 8 cores, and refits that redo only a
  few chunks, get more threads per encoder.
- **Few keyframes on short videos.** Every chunk starts with a keyframe, and on a 10-second clip 8 chunks cost up to
  a third more bits than one encode at the same quality. Short videos get fewer, longer x264 chunks with more threads
  each (Big Buck Bunny: faster, and VMAF NEG 92.8 → 93.1 at the same size), and AV1's keyframes are made cheaper to
  suit chunks this short (1.9–6.1% fewer bits).
- **A head start.** Once the size plan and the format are settled, Pare starts compressing while the settings are
  still on screen, and Compress picks it up wherever it got to. Clicking 15 seconds after loading, camera footage was
  ready 0.1 s after the click instead of 16.9 s: it had finished while the settings were on screen.
- **Room to spare goes to speed.** When a high-bitrate source would fit in half its size even at x264's `superfast`
  preset, which does about half the work, Pare test-encodes that first and uses it if its VMAF NEG is still 95 or
  more. Camera footage went from 28.7 s to 10.0 s at the same VMAF NEG (97.8), in a file 69% smaller instead of 79%.
- **A size promise that gets checked.** Short test encodes estimate how size falls as quality drops. Each chunk gets
  its quality setting from what the finished chunks actually cost, and the final file is weighed. If it isn't at
  least 50% smaller, the busiest chunks are encoded again.
- **Every frame is scored.** x264 computes SSIM for each frame against its input as it encodes. The result screen
  reports the average and the worst frame, and opens a side-by-side view on the weakest ones.
- **AV1, with SIMD.** SVT-AV1 compiled to WebAssembly with its x86 SIMD kernels translated automatically, the worst
  emulations replaced, and motion-search kernels rewritten for WebAssembly (`av1-wasm/`). Its output is
  byte-identical to native SVT-AV1. At the same size target it usually scores 0.7–1.4 VMAF NEG points higher than
  x264, and on the benchmark clips it takes 0.85× to 1.6× as long.
- **Auto picks the format by measuring.** Pare compiles Netflix's libvmaf to WebAssembly too (`vmaf-wasm/`). The size
  plan's test encodes are decoded and scored with VMAF NEG in the browser, and AV1 is used when it looks at least a
  point better at the target size and the device can play it, or when it's the only way to half the size. On the test
  corpus that picked the better encoder in 28 of 30 cases, where SSIM would have agreed with VMAF in 21. The AV1 test
  runs while you look at the settings; start sooner and Pare goes ahead with H.264 unless AV1 is likely to matter
  (a steep size curve, the mark of fine noise, where AV1 added 4 to 6 points, or H.264 near its limit).

The encoder settings came out of a quality lab. Every candidate was swept over rate factors on a test corpus and
scored with VMAF, VMAF NEG, SSIM and PSNR. `faster` with a 40-frame lookahead and weighted prediction needs about 30%
fewer bits than `veryfast` for the same VMAF NEG; a second sweep, for speed, found that diamond motion search and no
8×8-and-smaller inter partitions keep that quality per byte (−0.4% BD-rate) with two thirds of the CPU time. The
details, and the ideas that didn't make it, are in [research/RESEARCH.md](research/RESEARCH.md), and every benchmark
with its method in [research/BENCHMARKS.md](research/BENCHMARKS.md).

## Numbers

Visually lossless with the 50% target and format Auto, in Chrome on a 4-core, 8-thread cloud machine with no GPU.
Time runs from clicking Compress, a second after the file loads, to the finished file. VMAF NEG is measured afterwards
with native libvmaf over every frame; around 93 to 95 a re-encode stops looking different from its source.

| Video | Original | Pare | Time | VMAF NEG (worst frame) |
| --- | --- | --- | --- | --- |
| Camera footage, 1080p30, 10 s | 77.9 MB | 24.4 MB (−69%) | 10 s | 97.8 (95.6) |
| Screen recording, 1080p30, 8 s | 10.8 MB | 4.1 MB (−62%) | 9 s | 99.0 (95.6) |
| Big Buck Bunny, 1080p30, 10 s | 30.7 MB | 14.0 MB (−54%) | 27 s | 92.8 (89.4) |
| Phone clips, 1080p50, 20 s | 65.5 MB | 30.1 MB (−54%) | 42 s | 87.9 (71.9) |
| Phone clips, 1080p50, 2 min | 392 MB | 188 MB (−52%) | 3 min 16 s | 88.4 (67.1) |

Twelve videos, their before and after, and the noisy clips where AV1 takes over are in
[research/BENCHMARKS.md](research/BENCHMARKS.md).

Footage that compresses well keeps x264's CRF 15, where extra bits stop being visible, and lands well past half; when
there's room even at the `superfast` preset, the room goes to speed instead.
Noisy footage gets exactly as much quality as fits in half the size. The phone clips are the hard case: they're built
from noisy 25 Mbps re-encodes, and for some of that footage VMAF NEG 93 would take 84% to 171% of the original size
with either encoder, so at half the size they score "Excellent" rather than "Visually identical". Where AV1 can get
closer, Auto uses it: on the individual clips it lifted town from 90.3 to 93.9 and noisy from 80.9 to 87.3.

## Settings

- **Quality:** visually lossless, high, compact, or an exact copy (the original streams in a new container, every
  frame bit-identical).
- **Size:** at least 50% smaller (default), or no limit.
- **More options:** the encoder (Pare's own, or the browser's WebCodecs encoder, which is faster but less efficient),
  the format (Auto, H.264 or AV1; the browser's encoder can also make HEVC), resolution, and audio.

## Running it

```sh
bun install
bun dev
```

The x264 module is checked in at `src/lib/x264/`. To rebuild it from source you need an activated
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html):

```sh
x264-wasm/build.sh
```

The script clones x264 at the commit in `x264-wasm/X264_COMMIT`, applies `x264-simd128.patch`, builds it with
`-msimd128`, runs `checkasm` to verify every SIMD kernel against the C reference, and links the binding in
`pare_x264.c`.

## Layout

| Path | What's there |
| --- | --- |
| `src/App.tsx` | The whole interface: landing, settings, progress, result |
| `src/lib/x264.ts` | Size plan, Auto's format choice, chunking and cuts, per-chunk budget, refit, joining, audio |
| `src/lib/encode-worker.ts` | One encoder per worker, fed by WebCodecs through Mediabunny; scores test encodes with VMAF |
| `src/lib/media.ts` | Probing, the WebCodecs encoder path, the frame-by-frame quality check |
| `x264-wasm/` | The SIMD patch, the pinned x264 commit, the C binding, and the build script |
| `av1-wasm/` | The SVT-AV1 patch, dispatch-fallback generator, replacement intrinsic header, C binding, build script |
| `vmaf-wasm/` | The libvmaf patch (AVX2 kernels under Emscripten), the scoring binding, and the build script |
| `research/` | Write-up, benchmark scripts, corpus builder, and every measurement in `results.jsonl` |

## Limits

- The x264 path writes H.264 in MP4. HDR sources come out as SDR.
- Each 1080p encoder needs about 400 MB, and Pare uses at most 40% of the memory the device reports, so memory caps
  the encoder count.
- A refit, when the first pass misses the target, encodes the biggest chunks again on every core. It still adds time,
  about 7 s on a 20-second clip.
- Noisy footage that's already tightly compressed can't be halved at about 1:1 by x264 or SVT-AV1: two of the test
  clips would need 84–204% of their original size for VMAF NEG 93–95. Pare still halves them and picks the encoder that
  looks best, and says "Good" or "Excellent" instead of "Visually identical".
- The head start uses the CPU while the settings are on screen; changing a setting stops it.
- Threads need a cross-origin isolated page (the site sends COOP and COEP headers). Without them, or if the threaded
  build fails to start, each encoder runs on one thread.
- Needs a browser with WebCodecs and WebAssembly SIMD: current Chrome, Edge, Firefox, or Safari 17 and later.

## License

Pare is free software under the GNU General Public License, version 2 or later, because x264 is. See
[LICENSE](LICENSE). The x264 changes are in `x264-wasm/x264-simd128.patch`. SVT-AV1 (BSD-3-Clause-Clear) and libvmaf
(BSD-2-Clause-Patent) keep their own licenses; Pare's changes to them are in `av1-wasm/` and `vmaf-wasm/`.

H.264 is covered by patents in some countries. x264's own licensing notes apply to anyone distributing encoders
built from it.
