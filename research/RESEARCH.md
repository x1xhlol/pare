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

## Keeping every encoder busy

Every encoder waits for the slowest chunk, and the chunks weren't even. On the 20-second phone clip the encode's
wall time was 36% longer than the average chunk's working time with AV1, and 18% longer with x264. Three changes
brought that to 6% and 5%.

**Chunks of equal cost, not chunks that start on keyframes.** Boundaries used to move to the nearest source keyframe
within a third of a chunk, so each decoder started exactly on its chunk's first frame. Phones write a keyframe every
50 frames, and the phone clip came out as 100- and 150-frame chunks for 8 encoders. Now every chunk costs the same,
counting its frames plus the frames its decoder has to work through from the previous source keyframe, at a tenth of
a frame each (30 ms to decode against about 310 ms to encode with every core busy; `decodeShare` in the codec
profiles). A binary search finds the smallest cost that covers the video, and each chunk reaches as far as that cost
allows. That greedy fill is optimal here, because moving a frame into a chunk costs a whole frame, while starting the
next chunk later costs at most a tenth of one in decoding. Big Buck Bunny, with a keyframe every 250 frames, gains
the other way. Its later chunks spent up to 8 s decoding frames they never encoded, and now they get fewer frames to
make up for it.

**Cutting chunks that will finish late.** Equal cost on paper isn't equal time. At one rate factor, busy footage took
up to 1.5× longer per frame than calm footage: 38 s against 58 s for two 124-frame AV1 chunks of the phone clip.
The source doesn't predict it, since phones record at a nearly constant bitrate. The obvious fix, splitting a busy
chunk when an encoder runs out of work, never fired. By then the slow chunks had fed their last frames into the
encoder (x264 holds 40 in its lookahead, SVT-AV1 41), and there was nothing left to hand over. So the decision
happens early. Once every chunk has put out 16 frames, Pare predicts each one's finish from its speed so far, pairs
the chunks that will finish last with the encoders that will finish first, and asks each slow chunk's worker to stop
where both sides should finish together. The worker checks between frames and agrees if that frame hasn't gone into
the encoder yet. The rest becomes a new chunk for the first free encoder, with a rate factor from the size budget like
any other. Each cut costs a keyframe, about 150 KB in AV1 and 110 KB in x264 on the phone clip, or 0.4% of the file.
Pare cuts only when it saves at least a second.

**Refits in pieces.** When the first pass misses the size limit, the biggest chunks are encoded again. x264 gives
them the idle cores as threads, but SVT-AV1 runs one thread per encoder, so a two-chunk refit used 2 of 7 encoders
and took as long as the first pass. Refit chunks are now cut into pieces of at least 30 frames, so every encoder
works, and the refit budgets for the extra keyframes. Shorter pieces were slower. At a high-quality rate factor an
AV1 keyframe costs about 250 KB, and budgeting for four more of them pulled a third chunk into the refit. On a
10-second phone clip with PCM audio, AV1 went from 50 s to 41 s.

Before and after in the browser, clicking Compress a second after the file loads, alternating the two builds. The
machine was shared with other work during these runs (load average 8 to 13 on 8 threads), so differences under about
5% are noise:

| Clip | x264, before → after | AV1, before → after |
| --- | --- | --- |
| Camera footage, 10 s | 27.1 → 27.7 s | 35.2 → 23.5 s |
| Phone clips, 20 s | 54.6 → 56.5 s | 95.3 → 72.5 s |
| Big Buck Bunny, 10 s | 32.2 → 31.6 s | 41.6 → 37.0 s |
| Screen recording, 8 s | 9.7 → 9.6 s | 22.1 → 15.7 s |

AV1 gained 11–33%. Its frames take longer, so the same imbalance cost it more seconds, and it was the codec hit by the
canceled-plan bug below. For x264 the change is inside the noise of these runs. With the plan already finished before
the click, the phone clip went from 45.9 s to 43.4 s. AV1 now takes 0.85× to 1.6× as long as x264, against 1.3× to
2.3× before.

Refits also stop when no chunk's rate factor would change. A source that x264 can't halve even at its highest rate
factor (a 5 MB clip that was already tightly compressed) used to get two more identical passes, 64 s instead of 30.

## AV1: SVT-AV1 in WebAssembly, with SIMD

The biggest quality lever left is the codec. At preset 8, SVT-AV1 needs 29.9% fewer bits than Pare's x264 setting
for the same VMAF NEG on the corpus (native builds, same scoring): −54.9% on town, −52.4% on tree, −44.3% on Big Buck
Bunny, −68.5% on the screen recording, +6.6% on park and +34.4% on ducks, where AV1 smooths the rippling water that
x264's psychovisual tuning keeps. None of SVT-AV1's tuning switches fixed ducks (tune 0, temporal filtering off,
variance boost: +31% to +40%). SVT-AV1 had only been compiled to WebAssembly as plain C before (its own merge
request !2571 notes the "lack of simd"). `av1-wasm/` builds it with SIMD:

- **Translate, don't port.** SVT-AV1 writes its speed-critical code as C intrinsics: 108 files of SSE2 to AVX2 and
  63 of Arm Neon. Emscripten translates x86 intrinsics to WebAssembly SIMD (AVX2 as pairs of 128-bit operations), and
  its `arm_neon.h` is SIMDe, which does the same for Neon. Every one of those 171 files compiles; the only exception
  is a CRC32 hash with no WebAssembly instruction, which keeps its C version.
- **Route around the assembly.** 20 NASM files (and 3 `.S` files on Arm) can't be built. `gen_fallbacks.py`
  preprocesses every intrinsic file, since several build the names of the functions they call with `##`, finds the
  95 functions that reach assembly directly or through helpers, and points each of the 109 affected dispatch entries
  at the next implementation in the same line.
- **Let the unit tests find what translation breaks.** SVT-AV1's own tests, which compare every SIMD kernel with its
  C version, build for WebAssembly too. 127 AVX2 test groups pass. One failed: `svt_copy_mi_map_grid_avx2` (and its
  Neon twin) broadcasts a pointer as a 64-bit value, which corrupts memory where pointers are 32 bits. It's excluded.
- **Fix the emulations that are really scalar loops.** Emscripten implements `_mm_mpsadbw_epu8` as 32 byte
  extractions and `_mm_minpos_epu16` as a loop, and SVT-AV1's motion search uses them 543 and 112 times.
  `av1-wasm/include/` replaces both with SIMD versions, checked against the originals on a million random inputs
  and 1.6× and 1.7× faster on their own. A version of `_mm_sad_epu8` with fewer WebAssembly instructions (pairwise
  widening adds) turned out 18% slower, since V8 lowers those adds to several x86 instructions, so it was dropped.
  The two that help are being offered to Emscripten.
- **Write WebAssembly kernels where emulation still loses.** Full-search SAD (hierarchical motion estimation) and the
  8x8/16x16 all-position SAD were 3.4% and 2.0% of native encode time but 20% and 8% in WebAssembly. Both are
  rewritten around WebAssembly's own strengths (eight shifted loads per source chunk, saturating subtractions,
  pairwise-widening adds) and checked against the C semantics on 18,000 and 3,000 random cases.

Every build below produces output byte-identical to native SVT-AV1 (150 frames of park, 1080p, preset 8, CRF 35):

| Build | Speed, one thread |
| --- | --- |
| x86 intrinsics translated | 2.18 fps |
| Arm Neon intrinsics via SIMDe | 2.38 fps |
| x86, with SIMD MPSADBW and PHMINPOSUW | 2.85 fps |
| x86, plus the WebAssembly SAD loop | 3.37 fps |
| x86, plus the WebAssembly all-position SAD | **3.42 fps** (50% of native's 6.9) |

For scale, plain C is hopeless: 30 frames at preset 10 take 20.2 s in WebAssembly and 17.5 s natively, against 2.0 s
for native SIMD.

Where the single-thread build's time goes now (park, preset 8, CRF 35): the two WebAssembly SAD kernels take 16%,
`svt_aom_quantize_inv_quantize` 9%, and the 6-tap convolutions about 7%. The quantizer isn't a SIMD gap. It inlines
SVT-AV1's rate-distortion quantizer (`svt_av1_optimize_b`), which is scalar natively too and takes 16% there. The
all-position SAD is the clearest gap left. Native AVX2 spends 2.0% of its time in it, WebAssembly 7.3% of a run
twice as long, because MPSADBW does 32 absolute differences in one instruction and WebAssembly needs about six
instructions per 16. Turning off the stack protector or turning on link-time optimisation changed nothing (16.5 s
for 60 frames either way, identical output).

With SVT-AV1's own threading (`--lp 8`) the WebAssembly build encodes 1080p at 11.8 fps on the 4-core, 8-thread
test machine, against about 24 fps for Pare's chunked x264. Output is identical at every thread count. At `--lp 1`,
though, SVT-AV1 runs entirely on the calling thread (at `--lp 2` it starts 48 threads), so Pare builds it without
pthreads and runs it exactly like x264: one encoder per core on its own chunk, with the same plan, budget and refit.
`av1-wasm/pare_svtav1.c` gives it the same C API as the x264 binding; it splits NV12 chroma, drops the temporal
delimiter OBUs MP4 doesn't want, and takes per-frame SSIM from SVT-AV1's stat report. Its rate factors are the ones
that scored like x264's on the corpus: ceiling 16 (x264 15), visually lossless 18 (16), high 36 (22.4), compact 42
(26.4).

In the app, same size target, scored against the source:

| Clip | x264: size, VMAF NEG (worst frame) | AV1: size, VMAF NEG (worst frame) | Time, x264 → AV1 |
| --- | --- | --- | --- |
| Camera footage, 10 s | 15.3 MB, 97.83 (93.87) | 11.3 MB, 96.76 (93.79) | 27 → 35 s |
| Phone clips, 20 s | 29.4 MB, 87.70 (73.38) | 31.0 MB, 89.08 (74.58) | 54 → 93 s |
| Big Buck Bunny, 10 s | 13.9 MB, 92.98 (89.86) | 12.9 MB, 93.72 (91.35) | 32 → 54 s |
| Phone clip with PCM audio, 10 s | 23.2 MB, 92.46 (84.63) | 24.2 MB, 93.17 (88.91) | 40 → 54 s |

Where the target binds, AV1 is 0.7–1.4 points better on average and up to 4.3 better on the worst frame. Where the
footage already fits, it's 26% smaller at a slightly lower score, so its quality ceiling could come down a step.

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

Fewer chunks compress a little better (fewer keyframes) but run slower, so there's still one encoder per core. What
does pay is giving each of those encoders two threads anyway, on the same 8 hardware threads: the 20-second mix clip
encodes in 41.1 s instead of 47.0 s (13% faster), with the same size and quality, and 3 or 4 threads per encoder add
nothing more. With one thread, a core sits idle whenever its worker waits for the decoder or copies a frame in; the
second thread keeps x264 busy through those gaps. Beyond that, threads take cores the 8 encoders memory allows can't,
and refits, which usually redo fewer chunks than there are cores (the phone clip's one-chunk refit went from 18 s on
one core to 7 s on four).

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

## Planning AV1

Two things made AV1's plan slow, and one was a bug. The plan starts as soon as a file loads, with the default
settings, and restarts when they change. A plan canceled while its encoders were still starting added its cancel
handler after the cancel had happened, so it never stopped. Choosing AV1 right after loading a file left x264's plan
running to the end in the background, and AV1's plan took 20 to 38 s. Now a canceled plan stops, and AV1's takes 8 to
13 s.

The other was the preset. SVT-AV1's preset 10 encodes 24-frame windows 1.7× faster in WebAssembly than preset 8 (2×
natively). The plan only needs sizes, so the question was whether preset 10's sizes predict preset 8's files as well.
On three 24-frame windows of each corpus clip at CRF 16, 28 and 40, preset 10 came out 1–6% bigger (median by rate
factor), with a 4–8% spread across clips, and the slope of size against rate factor was the same to within 0.004. Next
to the windows' own error, that doesn't show. Predicting each whole clip's size from its windows is off by 21% (the
spread of the log ratio) at either preset, with the same median bias (1.13 and 1.12).

## Auto: choosing the format by measuring

AV1 needs about 30% fewer bits than x264 on most of the corpus, and 34% more on the rippling water of ducks. It also
encodes slower, and older Apple devices can't play it. So the question per video is whether AV1 looks better at the
target size, by enough to be worth it. Answering that takes a quality metric the browser can compute on test encodes,
and it has to agree with the one that matters. VMAF NEG is the reference here; the encoders hand out SSIM and PSNR for
free.

Neither free metric is good enough. At the sizes x264 reaches at CRF 16 to 24 on the six corpus clips (30 cases,
whole-clip encodes), SSIM picks the same winner as VMAF NEG in 21 cases and PSNR in 23. Both lean against AV1 where it
smooths fine grain, which VMAF doesn't mind: on town at CRF 16, AV1 is 0.9 VMAF NEG points ahead and 0.9 dB behind on
PSNR, and 2.3 dB behind on SSIM.

`research/codec_choice.py` simulates the choice the way the app makes it: encode the size plan's four 24-frame
windows with both encoders at two rate factors, predict each one's whole-clip size and its score at the target size
(linear in log size between the two tests), pick AV1 when its prediction is ahead by a threshold, and score the pick
against whole-clip VMAF NEG:

| Choice | Picks the better encoder | VMAF NEG lost, mean | Worst |
| --- | --- | --- | --- |
| Always x264 | 9 of 30 | 0.91 | 2.93 |
| Always AV1 | 21 of 30 | 0.69 | 4.35 |
| PSNR on the windows | 22 of 30 | 0.38 | 2.91 |
| VMAF NEG on the windows, 2 frames each | 28 of 30 | 0.04 | 1.08 |
| The same, AV1 on two of the four windows | 24 of 30 | 0.10 | 1.08 |

Three things nearly broke it. Scoring every 8th frame, the obvious way to save time, lands on the top layers of
SVT-AV1's 16-frame hierarchy, its best frames, and flipped ducks to AV1. Skipping frames also inflates VMAF's motion
feature, which then forgives more distortion; a short run of consecutive frames, with one extra frame in front to
prime the motion feature, keeps both honest. And testing AV1 at the plan's faster preset 10 misjudged tree by up to 2
points, since preset 10 costs some footage more quality than others, so the test runs preset 8.

VMAF runs in the browser as libvmaf 3.0 compiled to WebAssembly (`vmaf-wasm/`), with its AVX2 feature kernels
translated to WebAssembly SIMD by Emscripten the same way as SVT-AV1's. It scores a 1080p test window 89.34677 where
native libvmaf says 89.34658, at 321 ms per frame. Three quarters of that is VIF's statistics, whose per-pixel stage is
a scalar loop of logarithms and 64-bit divisions that SIMD translation doesn't touch, which is why only two frames per
window get scored. Each plan worker decodes its own test encode with WebCodecs and scores it against source frames it
copied on the way into the encoder.

In the app, Auto (the default format) works like this:

- H.264's size plan runs with VMAF. If it already fits at its highest quality, or scores 95 at the target, H.264 is
  the answer: in the simulation AV1 never came out a point ahead there, and nothing else is tested.
- Otherwise AV1 is tested at preset 8 on the second and fourth of H.264's four windows. Four test encodes on four cores
  take about half as long as eight sharing them, and two windows chose as well as four. AV1's size estimate is scaled
  by how those two windows compare with all four in H.264's test, and its VMAF is compared with H.264's on the same
  two windows.
- AV1 wins when it's at least a point ahead and this device can play AV1, or when H.264 can't reach half the size at
  its highest rate factor and AV1 can. Half a point was tried too: in the simulation it gave up less (0.12 VMAF NEG on
  average against always picking the better encoder, against 0.20), but in the app it put Big Buck Bunny on AV1 for
  +0.85 (93.0 → 93.8, 1:1 either way) at 1.9× the time.
- The AV1 test runs while the settings are on screen, starting as soon as H.264's sizes show the target binds. A
  compression started before it ends waits for it only when H.264 is predicted under 93 and its size falls steeply near
  the target (local slope −0.18 or steeper), or when H.264 can't reach half the size (see "How close to 1:1 half the
  size can get" below).

| Clip | Auto | Predicted, AV1 − H.264 | Whole file, AV1 − H.264 |
| --- | --- | --- | --- |
| Camera footage, 10 s | H.264: fits at its highest quality | | |
| Screen recording, 8 s | H.264: fits at its highest quality | | |
| Jellyfish, 10 s, already 4.2 Mbps | AV1: H.264 stops at −30% | +1.5 | |
| Big Buck Bunny, 10 s | AV1 | +1.3 | +0.74 |
| Phone clips, 20 s | H.264 | +0.7 | +1.38 |
| Phone clip with PCM audio, 10 s | H.264 | −0.4 | +0.71 |

The phone clips are a miss: the test on all four windows said +1.0, the two-window test +0.7, and the whole file
came out 1.4 points better as AV1. The other decisions hold. The jellyfish is the one that matters most: H.264 at its
highest allowed rate factor made it 30% smaller, and the size target promises 50%.

Auto costs 2–4 s of scoring on top of H.264's plan, and 11–13 s for AV1's test when it runs, in the background. A
compression started a second after the file loads took 28, 56, 35 and 11 s on the four benchmark clips, the same as
H.264 alone within this machine's noise.

I haven't found this done before. vmaf.dev runs libvmaf in the browser to compare two files, ab-av1 searches rate
factors with sample encodes and VMAF on the command line, and per-title encoding services choose codecs on servers.
Measuring the test encodes of a client-side compressor to choose its format for a size target is new as far as I can
tell.

## A third less work for x264

Pare's x264 setting was chosen for quality per byte (`faster` plus 3 references, smart weighted prediction and a
40-frame lookahead), with no search for settings that are much faster at nearly the same quality.
`research/speed_sweep.py` sweeps candidates over the corpus at CRF 16, 20 and 24 with the native build on one thread,
scores them with VMAF NEG, and reports BD-rate against Pare's setting and CPU time (user plus system, which holds up
on a busy machine where wall time doesn't):

| Change | CPU | BD-rate, VMAF NEG |
| --- | --- | --- |
| `--preset veryfast` (with the same additions) | 0.65× | +39.6% |
| `--subme 2` | 0.77× | +20.0% |
| `--trellis 0` | 0.83× | +20.3% |
| `--subme 3` | 0.92× | +2.4% |
| `--rc-lookahead 20` | 0.94× | +3.4% |
| `--b-adapt 0` | 1.01× | +34.3% |
| `--bframes 2` | 0.88× | −1.2% (Big Buck Bunny +9.4%) |
| `--ref 2` | 0.91× | +0.5% |
| `--me dia` | 0.93× | −1.7% |
| `--partitions i8x8,i4x4` (no 8×8-and-smaller inter partitions) | 0.75× | +0.7% |
| `--me dia --partitions i8x8,i4x4` | 0.73× | −1.1% |
| **`--me dia --partitions i8x8,i4x4 --ref 2` (shipped)** | **0.66×** | **−0.4%** |

The three that ship give the same quality per byte on average (animation +6.2%, screen content −6.4%, the noisy
clips even or better) for two thirds of the CPU time. In the WebAssembly build the partition change alone took 28% off
(80 frames of park: 35.4 → 25.7 s of CPU).

SVT-AV1 got the same treatment (`research/av1_sweep.py`, preset 8, CRF 22 to 40). Natively, some switches look
almost free: `--fast-decode 1` took 12% off the CPU time for +0.2% BD-rate, and turning off motion-field motion
vectors 12% for +0.7%; loop restoration off saved 12% for +6.1%. In the WebAssembly build none of them moved the CPU
time beyond noise (40 frames of park: 26.4-27.7 s against 27.0-28.1 s), and two produced byte-identical files, since
preset 8 already sets them that way at 1080p. The native savings come from paths that are cheap in AVX-512 and not in
WebAssembly, so AV1 stays at plain preset 8. Faster presets were ruled out earlier (preset 10: +74% bits).

## How close to 1:1 half the size can get

VMAF NEG 93 to 95 is about where a re-encode stops looking different from its source at normal viewing distance.
From the whole-clip sweeps above, this is the file size each encoder needs to get there, against the 50% budget:

| Clip (source) | x264 at 93 | x264 at 95 | AV1 at 93 | AV1 at 95 |
| --- | --- | --- | --- | --- |
| Big Buck Bunny (24 Mbps animation) | 39% | over the tested range | 26% | 61% |
| town (25 Mbps "phone" re-encode) | 76% | 120% | 28% | 66% |
| tree | 99% | 134% | 50% | 107% |
| park | over the tested range | 100% | 84% | 99% |
| ducks (rippling water) | 124% | 142% | 171% | 204% |

So half the size at about 1:1 is out of reach for park and ducks with any encoder here: the source's noise is the
detail, and it needs more bits than the source already spends. On town and tree it's within reach, but only with AV1,
which is why Auto's shortcut changed: a compression started before AV1's test ends waits for it when H.264 is predicted
under 93 and its size falls steeply near the target, as it does on town and tree. Town went from 90.3 to 94.0 at the
same size, its worst frame from 84.2 to 90.6; tree from 88.2 to 92.3.

The same data says where AV1 usually lands: at equal size its rate factor is about 1.88 times x264's minus 10.7 (5.6
spread across clips). AV1's test now brackets that guess, 6 either side, instead of starting at its quality ceiling,
the slowest rate factor to encode.

## Plans that miss less

The size plan interpolates log size between two test rate factors, 15 and 25 for visually lossless. Noisy footage
doesn't follow a straight line there: bits fall off steeply once the noise stops being coded, and 5-second clips of
town and tree came out 46% and 52% bigger than planned, then noisy 46% smaller. Each miss cost a second encode of
most chunks. When the answer falls more than 1.5 steps from both tests, or past the higher one, the plan now runs a
third round of the same windows near it and fits between the two tests either side of the target. Town and tree then
landed within 2% and 6% with no second encode (31.3 → 27.0 s, 32.9 → 27.8 s), and noisy within 4% (38.5 → 29.8 s).

Auto's VMAF scoring used to hold the plan up by 3 to 4 s per round. Workers now hand each test encode over first and
score it afterwards, from copies, so a compression can start on the sizes alone; scoring only gates Auto's decision.

## End to end in the browser

Same headless Chrome, same files, production builds:

| Clip | ffmpeg.wasm build | SIMD build, first size target | Now |
| --- | --- | --- | --- |
| 20 s 1080p50 phone-style (65.5 MB) | 105.2 s, no size target | 75 s, −61%, SSIM 0.943 | 53 s, −55%, SSIM 0.951 |
| 10 s 1080p30 camera (77.9 MB) | 27.3 s | 31 s, −80% | 26 s, −80%, SSIM 0.994 |
| 10 s Big Buck Bunny (30.7 MB) | | 41 s, −60%, SSIM 0.980 | 33 s, −55%, SSIM 0.983 |
| 2 min 1080p50 phone-style (392 MB) | | | 260 s, −51%, SSIM 0.954 |

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
- `vmaf-wasm/build.sh` builds libvmaf for WebAssembly from the pinned commit plus `libvmaf-wasm.patch`, with Pare's
  binding, into `src/lib/vmaf/`.
- `research/codec_choice.py` simulates Auto's choice on the corpus (native x264, SVT-AV1 and ffmpeg with libvmaf);
  its results are in `codec_choice*.jsonl`.
- `research/wasm-bench.mjs` times the WebAssembly encoder on raw frames in Node; `research/browser-ab.mjs` times a
  full compression in the browser against any deployment.

## Licensing

x264 is GPL-2.0-or-later, and the WebAssembly build is served to users, so the corresponding source (x264 at
`X264_COMMIT` plus `x264-simd128.patch` and `pare_x264.c`) has to be offered to them. The previous ffmpeg.wasm build
had the same obligation. SVT-AV1 (BSD-3-Clause-Clear, with the Alliance for Open Media patent license) and libvmaf
(BSD-2-Clause-Patent) are permissive and GPL-compatible; their patches and bindings are in `av1-wasm/` and
`vmaf-wasm/`.
