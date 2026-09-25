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
  straight into x264's input planes. The encoder module is 830 KB; ffmpeg.wasm is 32 MB.
- **Every core.** The video is split at source keyframes into chunks, each core encodes its own, and the chunks are
  joined at the original frame timestamps. Each encoder also runs two of x264's own frame threads, from a second
  build compiled with pthreads. The second thread keeps x264 working while the encoder waits for decoded frames,
  which makes encoding 13% faster on the same cores. Machines with more than 8 cores, and refits that redo only a
  few chunks, get more threads per encoder.
- **A size promise that gets checked.** Short test encodes estimate how size falls as quality drops. Each chunk gets
  its quality setting from what the finished chunks actually cost, and the final file is weighed. If it isn't at
  least 50% smaller, the busiest chunks are encoded again.
- **Every frame is scored.** x264 computes SSIM for each frame against its input as it encodes. The result screen
  reports the average and the worst frame, and opens a side-by-side view on the weakest ones.

The encoder settings came out of a quality lab. Every candidate was swept over rate factors on a test corpus and
scored with VMAF, VMAF NEG, SSIM and PSNR. The winner (`faster` with a 40-frame lookahead, 3 references and weighted
prediction) needs about 30% fewer bits than `veryfast` for the same VMAF NEG, and costs no speed. The details, and the
ideas that didn't make it, are in [research/RESEARCH.md](research/RESEARCH.md).

## Numbers

Visually lossless with the 50% target, in Chrome on a 4-core, 8-thread cloud machine with no GPU. Time runs from
clicking Compress to the finished file.

| Video | Original | Pare | Time | SSIM, every frame |
| --- | --- | --- | --- | --- |
| Camera footage, 1080p30, 10 s | 77.9 MB | 15.3 MB (−80%) | 26 s | 0.9942 |
| Phone clips, 1080p50, 20 s | 65.5 MB | 29.4 MB (−55%) | 53 s | 0.9505 |
| Big Buck Bunny, 1080p30, 10 s | 30.7 MB | 13.9 MB (−55%) | 33 s | 0.9825 |
| Screen recording, 1080p30, 8 s | 10.8 MB | 3.33 MB (−69%) | 10 s | 0.9996 |
| Phone clips, 1080p50, 2 min | 392 MB | 193 MB (−51%) | 4 min 20 s | 0.9535 |

Footage that compresses well keeps x264's CRF 15, where extra bits stop being visible, and lands well past half.
Noisy footage gets exactly as much quality as fits in half the size. The phone clips are the hard case. They're
already noisy 25 Mbps re-encodes, and at half the size they score "Excellent" rather than "Visually identical". I
haven't found a setting that closes that gap without a bigger file or about 50% more encoding time.

## Settings

- **Quality:** visually lossless, high, compact, or an exact copy (the original streams in a new container, every
  frame bit-identical).
- **Size:** at least 50% smaller (default), or no limit.
- **More options:** the encoder (x264, or the browser's own WebCodecs encoder, which is faster but less efficient and
  can also produce HEVC or AV1), resolution, and audio.

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
| `src/lib/x264.ts` | Size plan, chunking, per-chunk budget, refit, joining, audio |
| `src/lib/encode-worker.ts` | One x264 encoder per worker, fed by WebCodecs through Mediabunny |
| `src/lib/media.ts` | Probing, the WebCodecs encoder path, the frame-by-frame quality check |
| `x264-wasm/` | The SIMD patch, the pinned x264 commit, the C binding, and the build script |
| `research/` | Write-up, benchmark scripts, corpus builder, and every measurement in `results.jsonl` |

## Limits

- The x264 path writes H.264 in MP4. HDR sources come out as SDR.
- Each 1080p encoder needs about 400 MB, and Pare uses at most 40% of the memory the device reports, so memory caps
  the encoder count.
- A refit, when the first pass misses the target, encodes the biggest chunks again on every core. It still adds time,
  about 7 s on a 20-second clip.
- Threads need a cross-origin isolated page (the site sends COOP and COEP headers). Without them, or if the threaded
  build fails to start, each encoder runs on one thread.
- Needs a browser with WebCodecs and WebAssembly SIMD: current Chrome, Edge, Firefox, or Safari 17 and later.

## License

Pare is free software under the GNU General Public License, version 2 or later, because x264 is. See
[LICENSE](LICENSE). The x264 changes are in `x264-wasm/x264-simd128.patch`.

H.264 is covered by patents in some countries. x264's own licensing notes apply to anyone distributing encoders
built from it.
