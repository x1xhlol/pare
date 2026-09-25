# Faster, better x264 in the browser

Goal: keep Pare's output sizes, raise quality, and cut encode time. Everything runs client-side.

## Where the time went

Pare used ffmpeg.wasm (x264 with no SIMD at all, since x264's hand-written assembly is x86/ARM only) and decoded in
WebAssembly too. Profiling the C-only x264 build (`perf`, then V8's `--cpu-prof` on the WebAssembly build) showed
70-80% of encode time in a handful of pixel kernels:

| Kernel family | veryfast | medium |
| --- | --- | --- |
| SAD (motion search) | ~33% | ~24% |
| SATD / SA8D (Hadamard cost) | ~19% | ~18% |
| `get_ref` (sub-pel motion compensation) | 9.5% | 15.6% |
| quant, DCT, hpel filter, chroma MC, hadamard_ac | ~10% | ~13% |

## What changed

**WebAssembly SIMD128 kernels for x264** (`x264-wasm/x264-simd128.patch`, ~1,500 lines of kernels):
SAD/SAD×3/×4, SATD/×3/×4, SA8D, SSD, variance, var2, hadamard_ac, intra mode costs, get_ref/mc_luma, bi-pred
averaging, the 6-tap half-pel filter, chroma MC, lookahead downscaling, NV12 (de)interleaving, quantization,
4×4/8×8 DCT and IDCT, and luma/chroma deblocking. Notes:

- Hadamard costs use x264's own identity `|a+b| + |a−b| = 2·max(|a|,|b|)` to skip the last butterfly stage.
- Transforms run lane-wise across row vectors with shuffle transposes, two 4×4 blocks per register.
- Quantization computes in 32-bit lanes so it matches the C for all inputs (the SSE/NEON versions saturate).
- Every kernel passes x264's `checkasm` against the C reference (patched with a WebAssembly timer), and full
  encodes are byte-identical to the scalar build at every preset tested.

Result: **2.0–2.3× faster encoding per core**, identical output.

**A new pipeline** (`src/lib/x264.ts`, `src/lib/encode-worker.ts`): decoding moves to WebCodecs (usually hardware)
inside each worker, frames are copied straight into x264's input planes (NV12/I420, no conversion), one worker per
core within a memory budget, frame-exact chunks stitched at source timestamps, audio copied or transcoded with
Mediabunny. The encoder module is 821 KB (vs. 32 MB for ffmpeg.wasm), compiled once and shared by all workers.

## Quality at equal size

Test corpus: four Xiph 1080p50 sequences (town, park, tree, ducks) re-encoded as 25 Mbps "phone" sources, Big Buck
Bunny (24 Mbps animation) and a scrolling screen recording. Each configuration is swept over CRF 16–24 and scored
against the decoded source with VMAF, VMAF NEG (no enhancement gain, so sharpening can't game it), SSIM and PSNR-Y.
Numbers are Bjøntegaard delta rate against Pare's previous setting (`veryfast`): the average change in bits at
equal quality, using monotone (PCHIP) interpolation because VMAF saturates near 100.

| x264 setting | VMAF | VMAF NEG | SSIM | PSNR-Y |
| --- | --- | --- | --- | --- |
| veryfast (previous) | 0 | 0 | 0 | 0 |
| **faster (new default)** | **−29.9%** | **−27.8%** | **−18.4%** | **−17.6%** |
| fast | −30.4% | −28.0% | −17.4% | −16.9% |
| medium | −37.0% | −33.6% | −16.7% | −19.3% |
| faster + aq-mode 3 | −22.9% | −20.7% | −19.2% | −13.0% |
| faster + tune film | −31.4% | −27.0% | −15.9% | −14.2% |
| faster + tune grain | n/a | −28.9% | −6.4% | −10.5% |
| faster + rc-lookahead 40 | −31.6% | −29.2% | −18.4% | −18.5% |
| faster + ref 3 | −30.5% | −28.3% | −18.8% | −18.2% |
| faster + weightp 2 | −30.1% | −28.0% | −18.5% | −18.0% |
| **faster + lookahead 40 + ref 3 + weightp 2 (shipped)** | **−32.3%** | **−29.7%** | **−18.8%** | **−19.2%** |
| slow | −39.1% | −35.4% | −17.4% | −21.8% |
| faster + hqdn3d temporal denoise | −28.2% | −26.2% | −12.4% | −16.1% |

`faster` gets most of `medium`'s gain at about half its cost; `fast` is no better than `faster` and slower. The film
and grain tunes only win on the metric that rewards texture, and aq-mode 3 loses outright.

CRFs were then recalibrated so `faster` lands on the file sizes `veryfast` produced (CRF 18/22/26 → 18.3/22.4/26.4).
At those sizes VMAF NEG rises on every clip, by 1–5.5 points (e.g. ducks 93.4 → 96.6 at the visually lossless level).

The three additions cost no measurable speed in the WebAssembly build (4.68 → ~4.75 fps per core at 1080p); the
longer lookahead raises memory to ~400 MB per 1080p encoder, so it is only used up to 1080p.

## Denoising before encoding

hqdn3d (ported to WebAssembly, bit-exact with FFmpeg's filter) was tested as an "auto-enhance" step. At a fixed file
size it changed nothing measurable, against either the noisy source or, on a clip with synthetic sensor noise, the
clean original: once bits are constrained, x264's quantizer already discards the noise. Over the corpus it lowered
efficiency slightly (above). It is not used.

## At least 50% smaller

A fixed "visually lossless" rate factor has no size discipline: on a noisy 25 Mbps source it re-encodes the noise and
comes out 63% *larger*. So with the size target on, Pare treats "at least 50% smaller" as a promise and checks it.

**Plan.** While the settings screen is open, 4 windows of 24 frames are encoded at the quality ceiling (CRF 15) and at
CRF 25, on half the cores each. Windows start on source keyframes, so no decoder works through frames it won't use.
Keyframes and scene cuts are priced separately, and log size is interpolated in the rate factor to hit 47% of the
original. If CRF 15 already fits, that's the answer.

**Budget.** The plan is often off, in both directions. Sizes don't fall at a constant rate: on noisy footage they
fall slowly until x264 stops spending bits on the noise and then collapse (town halves between CRF 20 and 22), so a
straight line between CRF 15 and 25 misses the middle by up to 40%. Short windows also sample content unevenly. So
each chunk gets its rate factor when a worker picks it up: every finished frame is converted to what it would have
cost at CRF 15, the rest of the video is priced from those averages, and the chunk gets the rate factor that lands
the total on the goal. Long videos are cut into ~8-second chunks (x264 starts a keyframe about that often anyway), so
there are several rounds and later ones correct earlier ones. Each new rate factor stays within 1.5 of the
frame-weighted average so far, which keeps quality even and absorbs a wrong slope.

**Check and refit.** The finished video is weighed. If it's over half the original, the biggest chunks are encoded
again: they save the most bytes per step, and busy footage hides the change best. The rise comes from the local slope,
between the real total and the plan's test point on the far side. A total far under the goal means the plan was
pessimistic, and every chunk comes down to spend the room on quality. x264's `stitchable=1` keeps the picture
parameter set independent of the rate factor, so chunks encoded at different ones can share one; without it, joined
chunks decode wrong.

Plan errors on the test corpus, and what the budget and refit did with them:

| Clip | Plan's CRF | Plan vs. real size | Result |
| --- | --- | --- | --- |
| town (1080p50 noisy phone clip) | 20.5 | +39% | 4 of 8 chunks refit to 22.9; −58% |
| tree | 21.9 | +43% | 4 of 8 refit to 24.2; −55% |
| phone clip with PCM audio | 20.9 | +8.5% | 1 chunk refit to 23.3; −53% |
| mix (4 scenes, 20 s) | 25.0 | −4.7% | none; −55% |
| Big Buck Bunny | 18.9 | −3.5% | none; −55% |
| noisy (synthetic sensor noise) | 26.9 | −51% | all refit down to 25.9; −52%, SSIM 0.80 → 0.87 |
| 2 minutes of mix | 26.1 | −19% | later rounds 24.6 → 23.0, no refit; −51% |
| camera footage, screen recording | 15 | fits | none; −80%, −69% |

Every clip ends between 51% and 80% smaller. A refit costs time when it happens: the phone clip's one chunk took 18 s
on a single core, and 7 s once refits got the idle cores as x264 threads (see Threads).

## What chunking costs

Every chunk starts with a keyframe. On long videos that's free, since x264 inserts one every 250 frames anyway, but
short clips pay for it. Native x264, same settings, same CRF, the whole clip vs. split into equal chunks:

| Clip | 4 chunks | 8 chunks |
| --- | --- | --- |
| Big Buck Bunny (10 s) | −0.3% | +5.6% |
| town (5 s) | +1.5% | +4.6% |
| park (5 s) | +1.7% | +3.9% |
| screen recording (8 s) | +10% | +45% |

## Threads

x264 has its own frame threading, and Emscripten can compile it with pthreads (it needs `SharedArrayBuffer`, so the
page must be cross-origin isolated). One change was needed: `slicetype_slice_cost` runs as a thread-pool job but
returns `void`, and WebAssembly traps on the mismatched indirect call, so it now returns `void *`. The thread workers
must exist before x264 starts its threads (the encoder's worker blocks while x264 waits on them, so a thread started
later never runs), and they load the glue from its own URL so Vite's hashed file names resolve. In Chrome, one
encoder with 8 threads runs at 16.8 fps on park: 3.95× one thread (native x264 scales 4.07×).

On the 4-core, 8-thread test machine, the same 240 frames split different ways:

| Layout | Speed | Size |
| --- | --- | --- |
| 8 encoders × 1 thread | 19.7 fps | 24.70 MB |
| 4 encoders × 2 threads | 18.4 fps | 24.43 MB |
| 2 encoders × 4 threads | 17.7 fps | 24.07 MB |

Fewer chunks compress a little better (fewer keyframes) but run slower, so independent encoders stay the default.
Threads are used where they're free: cores beyond the 8 encoders memory allows, and refits, which usually redo fewer
chunks than there are cores (the phone clip's one-chunk refit went from 18 s on one core to 7 s on four).

One stream with no chunks at all would need size control without chunks. x264's one-pass average bitrate mode was
tested on the mix clip, whose four scenes differ a lot: it spent early (VMAF NEG by scene: 92.8, 86.7, 89.5, 77.6),
overshot to 50.2% of the original, and scored 86.65 overall, where chunked constant quality scored 87.7 at a 10%
smaller file (by scene: 87.6, 92.5, 86.7, 84.0). A tighter `ratetol` fixes most of the overshoot but not the uneven
spending.

## Slower tools that might be worth it

Each of `medium`'s tools added alone to the shipped setting, BD-rate over the corpus, and encode speed in the
WebAssembly build (park, one encoder):

| Added | VMAF NEG | SSIM | Speed |
| --- | --- | --- | --- |
| `subme 5` | −1.6% | −1.8% | −10% |
| `subme 6` | +0.3% | +1.2% | |
| `subme 7` | −7.6% | +3.2% | −32% |
| `mixed-refs` (with subme 5) | −0.6% | −0.5% | −20% |
| `partitions all` | +0.7% | +0.5% | |
| `me umh` | +0.1% | −0.5% | |
| `b-adapt 2` | −1.1% | −0.4% | |

`subme 7` is the interesting one: at the same size it scores up to 0.8 VMAF NEG higher on noisy footage (town at CRF
20: 92.73 → 93.51) while SSIM dips, which is psychovisual RD keeping grain that SSIM counts as error. It costs a third
of the speed, so it isn't the default; it's the obvious candidate for a "best quality" setting.

## Where the time goes now

Profile of the SIMD build (park, 1080p, shipped settings), top functions by self time:

| Function | Share | Notes |
| --- | --- | --- |
| `avg2_wxh` (sub-pixel averaging) | 10.5% | SIMD, 8.6× the C per call; it's the first read of each candidate's reference pixels, so it takes the cache misses |
| `me_search_ref`, `refine_subpel` | 12% | motion search control flow, scalar in native x264 too |
| SATD 16×16 / 8×8 | 10.7% | SIMD |
| SAD and SAD×3/×4 | ~17% | SIMD |
| `quant_4x4_trellis` and helpers | ~6% | scalar in x264's C; the x86-64 assembly for it is a specialised rewrite |
| CABAC | ~3.3% | scalar by nature |

Two more kernels since the first round: per-frame SSIM (`ssim_4x4x2_core`, `ssim_end4`) and explicit weighted
prediction (`mc_weight`, whose chroma scales reach 255, so products use unsigned 16-bit lanes and saturate before the
offset). SSIM went from 2.3–3.2% of the time to 0.4%, and encodes got ~4% faster, byte-identical as before. Link-time
optimisation (`-flto`) changed nothing (4.05 vs. 4.07 fps). The single-thread WebAssembly build runs at 54% of native
x264 with the same settings (4.25 vs. 7.85 fps on park).

## A faster plan that wasn't

The plan costs 10–14 s before the encode starts, all of it encoding test windows (24 frames per window at ~2.7 fps per
worker when 8 share 4 cores). A two-round version was tried: 8 windows of 12 frames at CRF 15, then, only if that
didn't fit, the same windows at a rate factor estimated from the first round. Easy footage finished planning in 6.5 s
instead of 10, but 12-frame windows underestimate the finished size by 20–100% (most of a 12-frame window is the
cheap stretch right after its keyframe), so hard clips needed refits and got slower overall. Reverted.

## End to end in the browser

Same headless Chrome, same files, production builds:

| Clip | ffmpeg.wasm build | SIMD build, first size target | Now |
| --- | --- | --- | --- |
| 20 s 1080p50 phone-style (65.5 MB) | 105.2 s, no size target | 75 s, −61%, SSIM 0.943 | 60 s, −55%, SSIM 0.951 |
| 10 s 1080p30 camera (77.9 MB) | 27.3 s | 31 s, −80% | 27 s, −80%, SSIM 0.994 |
| 10 s Big Buck Bunny (30.7 MB) | | 41 s, −60%, SSIM 0.980 | 34 s, −55%, SSIM 0.983 |

"Now" includes the size plan when Compress is clicked a second after the file loads. The ffmpeg.wasm build had no
size target, and the middle column aimed at 44% of the original and often landed far below it; aiming at 47% and
checking the result spends the allowance on quality.

## Reproducing

- `x264-wasm/build.sh` rebuilds `src/lib/x264/x264.{mjs,wasm}` from the pinned x264 commit plus the patch, and runs
  `checkasm`.
- `research/evaluate.py` / `research/experiments.py` run the rate-quality sweeps (native x264 build, ffmpeg with
  libvmaf, corpus in `corpus/ref/*.y4m`).
- `research/corpus.sh` downloads the Xiph clips and builds the "phone" versions and `mix.mp4`.
- `research/results.jsonl` holds every rate-quality point measured (native x264, VMAF/VMAF NEG/SSIM/PSNR-Y).
- `research/wasm-bench.mjs` times the WebAssembly encoder on raw frames in Node; `research/browser-ab.mjs` times a
  full compression in the browser against any deployment.

## Licensing

x264 is GPL-2.0-or-later, and the WebAssembly build is served to users, so the corresponding source (x264 at
`X264_COMMIT` plus `x264-simd128.patch` and `pare_x264.c`) has to be offered to them. The previous ffmpeg.wasm build
had the same obligation.
