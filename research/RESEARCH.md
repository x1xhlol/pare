# Pare: research notes

What was tried to make Pare's files look better and come out faster, in the order it happened, with the measurements
behind each decision. Everything here runs in the browser. Later sections sometimes overturn earlier ones; where that
happens, the earlier section says so.

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

Encoding got 2.0–2.3× faster per core, with identical output.

**A new pipeline** (`src/lib/x264.ts`, `src/lib/encode-worker.ts`): decoding moves to WebCodecs (usually hardware)
inside each worker, frames are copied straight into x264's input planes (NV12/I420, no conversion), one worker per
core within a memory budget, frame-exact chunks stitched at source timestamps, audio copied or transcoded with
Mediabunny. The encoder module is 824 KB (vs. 32 MB for ffmpeg.wasm), compiled once and shared by all workers.

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
| **faster + lookahead 40 + ref 3 + weightp 2 (shipped then)** | **−32.3%** | **−29.7%** | **−18.8%** | **−19.2%** |
| slow | −39.1% | −35.4% | −17.4% | −21.8% |
| faster + hqdn3d temporal denoise | −28.2% | −26.2% | −12.4% | −16.1% |

`faster` gets most of `medium`'s gain at about half its cost; `fast` is no better than `faster` and slower. The film
and grain tunes only win on the metric that rewards texture, and aq-mode 3 loses outright. (The shipped setting
changed again later, for speed: see "A third less work for x264".)

CRFs were then recalibrated so `faster` lands on the file sizes `veryfast` produced (CRF 18/22/26 → 18.3/22.4/26.4).
At those sizes VMAF NEG rises on every clip, by 1–5.5 points (e.g. ducks 93.4 → 96.6 at the visually lossless level).

The three additions cost no measurable speed in the WebAssembly build (4.68 → ~4.75 fps per core at 1080p); the
longer lookahead raises memory to ~400 MB per 1080p encoder, so it is only used up to 1080p.

## Denoising before encoding

hqdn3d (ported to WebAssembly, bit-exact with FFmpeg's filter) was tested as an "auto-enhance" step. At a fixed file
size it changed nothing measurable, against either the noisy source or, on a clip with synthetic sensor noise, the
clean original. Once bits are constrained, x264's quantizer already discards the noise. Over the corpus it lowered
efficiency slightly (above). It is not used.

## At least 50% smaller

A fixed "visually lossless" rate factor has no size discipline: on a noisy 25 Mbps source it re-encodes the noise and
comes out 63% *larger*. So with the size target on, Pare treats "at least 50% smaller" as a promise and checks it.

**Plan.** While the settings screen is open, 4 windows of 24 frames are encoded at the quality ceiling (CRF 15) and at
CRF 25, on half the cores each. Windows start on a source keyframe when one is close, so decoders work through few
frames they won't use.
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

That's size at the same rate factor, and it undersold the problem. Measured at equal quality, short chunks cost far
more (up to 42% on town for 32-frame chunks), which only came out much later: see "Cheaper keyframes for AV1's
chunks" and "Fewer, longer x264 chunks for short videos".

## Keeping every encoder busy

Every encoder waits for the slowest chunk, and the chunks weren't even. On the 20-second phone clip the encode's
wall time was 36% longer than the average chunk's working time with AV1, and 18% longer with x264. Three changes
brought that to 6% and 5%.

**Chunks of equal cost.** Boundaries used to move to the nearest source keyframe within a third of a chunk, so each
decoder started exactly on its chunk's first frame. Phones write a keyframe every 50 frames, and the phone clip came
out as 100- and 150-frame chunks for 8 encoders. Now every chunk costs the same, counting its frames plus the frames
its decoder has to work through from the previous source keyframe, at a tenth of a frame each (30 ms to decode against
about 310 ms to encode with every core busy; `decodeShare` in the codec profiles). The planner finds the smallest cost
that covers the video, and each chunk reaches as far as that cost allows. (It bisected for that cost until a bug
turned up: see "Every encoder from the start".) That greedy fill is optimal here, because moving a frame into a chunk
costs a whole frame, while starting the next chunk later costs at most a tenth of one in decoding. Big Buck Bunny,
with a keyframe every 250 frames, gains the other way. Its later chunks spent up to 8 s decoding frames they never
encoded, and now they get fewer frames to make up for it.

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
works, and the refit budgets for the extra keyframes. Shorter pieces were slower here (the minimum later came down
to 20 frames for a different case: see "Deciding on AV1 from H.264's plan"). At a high-quality rate factor an
AV1 keyframe costs about 250 KB, and budgeting for four more of them pulled a third chunk into the refit. On a
20-second phone clip with PCM audio, AV1 went from 50 s to 41 s.

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

- **Translate the intrinsics.** SVT-AV1 writes its speed-critical code as C intrinsics: 108 files of SSE2 to AVX2 and
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
  The two that help could go upstream to Emscripten; they haven't been submitted.
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
| Phone clip with PCM audio, 20 s | 23.2 MB, 92.46 (84.63) | 24.2 MB, 93.17 (88.91) | 40 → 54 s |

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

Fewer chunks compress a little better (fewer keyframes) but ran slower here, so Pare kept one encoder per core. (With
two threads per encoder and videos under 500 frames, that later turned around: see "Fewer, longer x264 chunks for
short videos".) What does pay is giving each of those encoders two threads anyway, on the same 8 hardware threads: the
20-second mix clip encodes in 41.1 s instead of 47.0 s (13% faster), with the same size and quality, and 3 or 4
threads per encoder add nothing more. With one thread, a core sits idle whenever its worker waits for the decoder or
copies a frame in; the second thread keeps x264 busy through those gaps. Beyond that, threads take cores the 8
encoders memory allows can't, and refits, which usually redo fewer chunks than there are cores (the phone clip's
one-chunk refit went from 18 s on one core to 7 s on four).

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

`subme 7` is the interesting one. At the same size it scores up to 0.8 VMAF NEG higher on noisy footage (town at CRF
20: 92.73 → 93.51) while SSIM dips, because psychovisual RD keeps grain that SSIM counts as error. It costs a third
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

Two more kernels since the first version: per-frame SSIM (`ssim_4x4x2_core`, `ssim_end4`) and explicit weighted
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

In the app, Auto (the default format) first worked like this. "Deciding on AV1 from H.264's plan", further down,
shortens the AV1 path.

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
| Phone clip with PCM audio, 20 s | H.264 | −0.4 | +0.71 |

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
WebAssembly, so AV1 stays at plain preset 8. Faster presets cost too much quality: preset 9 takes 0.67× the CPU time
for 19% more bits at the same VMAF NEG (town +16%, tree +17%, Big Buck Bunny +18%, screen +60%), and preset 10 0.43×
for 74% more. Auto picks AV1 for 1 to 6 points of VMAF NEG, and preset 9 would give back about half of that.

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
| noisy (sensor noise) | 161% | 198% | 177% | 291% |

So half the size at about 1:1 is out of reach for park, ducks and noisy with any encoder here. The source's noise is
the detail, and it needs more bits than the source already spends (noisy's row uses the current x264 settings). On
town and tree it's within reach, but only with AV1, which is why Auto's shortcut changed: a compression started before
AV1's test ends waits for it when H.264 is predicted under 93 and its size falls steeply near the target, as it does
on town and tree. Town went from 90.3 to 94.0 at the same size, its worst frame from 84.2 to 90.6; tree from 88.2 to
92.3.

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

## Starting before Compress

Most of a compression's wait used to come after the click, even though the plan usually settles while the settings
are still on screen. Now, once the size plan and the format are settled, Pare starts compressing in the background,
and Compress picks the job up wherever it got to. Changing any setting or opening another file drops it, and each
combination of settings gets one head start per file, so going back to the settings from a result doesn't quietly
compress the same thing twice. Clicking 15 s after the file loads (reading the settings, say):

| Clip | Click to file, before | Now |
| --- | --- | --- |
| Camera footage, 10 s | 16.9 s | 0.1 s |
| Phone clips, 20 s | 43.2 s | 33.0 s |
| Big Buck Bunny, 10 s | 21.9 s | 14.8 s |

These numbers were measured after the next two sections' changes. The camera footage had finished before the click.

Two smaller changes shorten the AV1 path. When H.264's first plan round already shows a steep curve, or a rate factor
within 3 of its highest, AV1 will be tested anyway, so its test starts right then, alongside H.264's third round on the
encoders that round leaves free. And at that edge H.264 has no headroom: park's plan put it at 28.3, the first pass
came out over, and it finished at x264's highest rate factor with VMAF NEG 78.9, where AV1 made 82.8 at the same
size. There AV1 is picked from a tie instead of a point ahead.

AV1's test estimates size from two windows, scaled by how those two compare with all four in H.264's test, and that
still lands 6-17% off (town and noisy over, then a second encode; tree 17% under, which leaves quality unused). A third
round at the same two windows didn't help (town went from a landing to a miss): the error is in which frames are
sampled, not in the curve. Encoding the other two windows once AV1 is chosen did help the landing (town and noisy
within 2%, no second encode), but it cost 5-10 s on every AV1 clip for 0.0-0.3 VMAF NEG, so it isn't shipped. Part of
the error isn't sampling either: the window estimate's 8% correction was calibrated on x264, and AV1's windows run high
on some footage (tree) and low on other (park).

## Room to spare goes to speed

Camera footage at 62 Mbps fits in half its size at x264's quality ceiling (CRF 15) with a lot left over: Pare's
file was 21% of the original. Nothing was using that room, and x264's `superfast` preset does about half the work.
At CRF 15 on the corpus, `superfast` against Pare's settings (native x264, one thread):

| Clip | CPU time | VMAF NEG, Pare's settings → superfast | Size, superfast / Pare's |
| --- | --- | --- | --- |
| Big Buck Bunny | 21.2 vs. 35.3 s | 95.34 → 95.24 | 1.36× |
| town | 16.4 vs. 37.5 s | 96.12 → 95.23 | 1.46× |
| tree | 20.4 vs. 38.2 s | 96.42 → 95.71 | 1.44× |
| park | 14.6 vs. 42.6 s | about the same | 1.03× |
| ducks (rippling water) | 17.3 vs. 39.1 s | 98.99 → 93.32 | 1.21× |
| screen recording | 6.9 vs. 8.0 s | about the same | 1.53× |

So when `superfast` still fits, it costs little quality, except on footage like the water. The plan now tries it
first: the four test windows at CRF 15 with `superfast`, kept if their estimate is within 90% of the size goal and
their VMAF NEG is at least 95 (the water would fail that). The encode keeps those windows as finished chunks.
The camera footage went from 28.7 s to 10.0 s, at VMAF NEG 97.9 → 97.8 (worst frame 93.9 → 95.6), in a file 69%
smaller instead of 79%.

The extra test is wasted when `superfast` doesn't fit, and it isn't cheap: it runs before the usual round, and its
windows are scored before the workers move on. Big Buck Bunny's plan went from 12 s to 20 s, and the phone clips' and
town's by 4 to 5 s. `superfast` at CRF 15 took 0.3 to 0.8 bits per pixel on the natural footage in the corpus (0.06
on the screen recording), and fitting it with room takes about twice that, so the test only runs on sources above 0.6
bits per pixel. The camera footage has 1.0; everything else in the benchmark has 0.4 or less.

Starting the encode while the test windows were still being scored, and starting over with the full settings if they
came in low, finished no sooner (10.2-10.5 s against 10.0 s): the scoring took the cores from the encode. Not shipped.

## Decoding only the frames that matter

Every chunk and test window starts its own decoder at the source keyframe before its first frame. Big Buck Bunny's
source has keyframes at frames 0 and 250 only, so a chunk starting at frame 200 decodes 200 frames it throws away,
and its plan windows spent up to 4.1 s decoding against 5 to 6.5 s encoding. Many of those frames are B-frames no other
frame refers to (`nal_ref_idc` 0 in H.264), and a decoder doesn't need them to decode what comes after. The worker
now drops them before its range starts, by filtering the packets Mediabunny's range decoding reads. The output is
byte-identical. Big Buck Bunny's decoding went from 4.5 to 3.0 s per encoder and its compression from 29.7 to 26.1 s.
HEVC's non-reference types are only non-reference within their temporal sub-layer, so HEVC sources decode everything
as before.

## Cheaper keyframes for AV1's chunks

Every chunk Pare encodes in parallel starts with a keyframe, so the decoder can start there. "What chunking costs"
put that at a few percent, measured at the same rate factor. Measured at equal quality it's far more, and this was the
biggest surprise of the project. `research/av1_chunks.py` encodes the first 192 frames of a clip as
back-to-back chunks of L frames with native SVT-AV1 (preset 8, one thread, as in Pare), joins them, and scores the
result against the source:

| Chunk length | town | park | Big Buck Bunny |
| --- | --- | --- | --- |
| 24 | +31.2% | +3.8% | +53.2% |
| 32 | +23.3% | +1.1% | +35.9% |
| 33 | +23.5% | +5.7% | +36.9% |
| 48 | +12.9% | +0.7% | +16.3% |
| 64 | +9.1% | +0.4% | +9.4% |
| 96 | +4.1% | +0.4% | −0.4% |
| 192 (one chunk) | 0 | 0 | 0 |

(BD-rate on VMAF NEG against one 192-frame encode, CRF 22-38.) A 5-second 1080p50 clip on 8 encoders gets 31-frame
chunks, so AV1 spends about a quarter more bits than it would in one piece on footage like town, and a third more on
animation, which is most of its advantage over x264. Park barely notices, because its inter frames cost nearly as much
as a keyframe. One frame past a whole 32-frame mini-GOP costs extra too (33 against 32, 49 against 48, 65 against 64),
a small effect next to the keyframes.

SVT-AV1 sets keyframe quality for GOPs of about five seconds, where a keyframe is referenced for a long time. In a
32-frame chunk it isn't, so a coarser keyframe should pay off. SVT's `--key-frame-qindex-offset` does nothing on its
own; with `--use-fixed-qindex-offsets 2` it adds to the rate control's own choice instead of replacing it:

| Keyframe qindex offset | town | park | Big Buck Bunny | tree |
| --- | --- | --- | --- | --- |
| −8, 32-frame chunks | +5.1% | +0.9% | +5.1% | |
| +8 | −3.0% | −0.6% | −2.4% | |
| +16 | −5.1% | −1.4% | −3.1% | −5.0% |
| **+24** | **−6.1%** | **−1.9%** | **−3.4%** | **−5.9%** |
| +40 | −6.3% | −2.7% | −0.9% | |
| +16, 96-frame chunks | −2.2% | −0.2% | −1.1% | −1.8% |
| +24, 96-frame chunks | −2.6% | −0.4% | −0.8% | −2.4% |

+24 ships, for every AV1 encode and AV1's test windows alike. In the browser, town at CRF 18 in 8 chunks came out 6.3%
smaller (13.14 → 12.32 MB) for 0.06 less VMAF NEG (95.31 → 95.25). Also tried on 32-frame chunks: keyframe temporal
filtering off (+1.8% to +6.0%, worse), and a smaller first mini-GOP after the keyframe (`--startup-mg-size 3`: −2.9%
on town, +0.2% on Big Buck Bunny, and no better on top of the keyframe offset).

AV1's size estimate still lands 10-20% either side on some clips (two test windows sample less of the video than
x264's four). Tree's first pass came to 78% of the size goal, and the rule then was to encode again at a lower rate
factor under 80%: that bought VMAF NEG 91.94 → 92.46 for 54.8 s instead of 38.3. The second pass now runs only under
75%.

## Every encoder from the start

The chunk planner looks for the smallest per-chunk cost that covers the video in as many chunks as there are
encoders, and it bisected for it. But a limit can fail where a lower one works: a remainder under 15 frames joins
the chunk before it, and that chunk then goes over. So 250 frames came out as 7 chunks for 8 encoders, and 240 frames
as 6, leaving encoders idle until the end-of-encode cuts. The planner now steps up from the lower bound instead. Over
2,848 simulated clip lengths and keyframe spacings it was never worse and gave a lower longest chunk in 38% of them
(240 frames with a keyframe every 60: 41.7 → 31.0 frames' worth of work). AV1 on town went from 7 encoders to 8.

## Fewer, longer x264 chunks for short videos

x264 pays for chunk keyframes too. `research/x264_chunks.py` does for Pare's x264 settings what `av1_chunks.py` does
for AV1 (192 frames, CRF 18-26, BD-rate on VMAF NEG against one encode):

| Chunk length | town | tree | park | Big Buck Bunny |
| --- | --- | --- | --- | --- |
| 32 | +41.8% | +24.9% | +5.7% | +34.4% |
| 96 | +7.9% | +4.8% | +1.0% | +6.4% |

x264's `--ipratio` (how much better keyframes are than P-frames) changed nothing at any setting. With the
macroblock tree on, keyframe quality comes from how much the following frames use it, so the lever is the number of
chunks. On a 10-second clip, 8 encoders get 37-frame chunks; x264's own frame threads can use the cores instead.
Each layout at the same rate factor, no size target (encode time, file, VMAF NEG):

| Layout | Big Buck Bunny, 300 frames | town, 250 | tree, 250 |
| --- | --- | --- | --- |
| 8 encoders × 2 threads | 14.3 s, 22.75 MB, 94.63 | 11.6 s, 21.51 MB, 95.14 | 11.2 s, 23.63 MB, 95.55 |
| 4 × 4 | 12.6 s, 22.07 MB, 94.78 | 10.8 s, 21.34 MB, 95.37 | 10.9 s, 23.27 MB, 95.71 |
| 3 × 5 | 12.1 s, 21.90 MB, 94.82 | 10.8 s, 21.24 MB, 95.37 | 12.0 s, 23.14 MB, 95.69 |
| 2 × 8 | 12.2 s, 22.00 MB, 94.80 | 11.0 s, 21.23 MB, 95.46 | 10.5 s, 23.08 MB, 95.78 |

Fewer encoders were faster as well as better: fewer chunks means fewer decoders working through frames before their
start (Big Buck Bunny's keyframes are 250 frames apart), and fewer lookaheads filling up. From 500 frames up, 8 × 2
was a little faster (the phone clips, 20 s: 30.9 against 31.9 s). So x264 now halves its encoders, doubling their
threads, until chunks are at least 60 frames long. In the app, Big Buck Bunny went from 25.6 to 24.6 s and from
VMAF NEG 92.8 to 93.1, in a file 56% smaller instead of 54%, and the screen recording came out at 3.49 MB instead of
4.10 at the same VMAF NEG.

The size plan still counts keyframes as if there were 8 chunks. Counting 4 made Big Buck Bunny's plan 11% smaller
(a test window's keyframe is pricier than what one fewer keyframe saves in a real chunk: 3% at the same rate
factor), it chose CRF 18.1 instead of 19.1, came out 9% over, and needed a second pass.

## Deciding on AV1 from H.264's plan

On the clips where Auto picks AV1, most of the time went into deciding. For town: H.264's first test round ended 8 s
after the click, AV1's quality test (preset 8, two windows) then ran next to H.264's third round and scoring for 13 s,
and only then did the 14 s AV1 encode start. Every clip that reached that test in the benchmark went to AV1, by 1.1 to
7.7 VMAF NEG, and H.264's first round already showed why: a steep size curve (town, tree), or a rate factor at the edge
of H.264's range (Jellyfish, park, ducks), or, for noisy, a rate factor far past the higher test with its windows
scoring far from 1:1 (79.5 at the target, against AV1's 87.2).

So Auto now commits to AV1 from H.264's first round when it shows one of those: the curve steeper than −0.18 per step
with H.264 at CRF 19 or more (on the corpus AV1 was 1.0 to 2.9 points ahead there from x264 CRF 20 up, and 0.1 to 1.7
below it), the edge, or H.264 past its higher test by 1.5 steps and predicted under VMAF NEG 85 at the target (the one
corpus case near it where AV1 lost, rippling water at 86.0, was above it). H.264's third round and scoring stop, and
AV1's size is planned at preset 10 on the two test windows, scaled by how H.264's same windows compare with all four,
which takes about 5 s. At the edge the bracket starts at the mapped rate factor instead of 6 below it: H.264's rate
factor is capped there, and AV1 landed at 42 to 48. Everywhere else, and on devices that can't play AV1, Auto measures
as before.

| Clip | Time, measured → predicted | VMAF NEG |
| --- | --- | --- |
| town | 37.0 → 29.3 s | 93.94 → 93.94 |
| tree | 38.3 → 29.9 s | 91.94 → 92.14 |
| noisy | 44.4 → 35.7 s | 87.84 → 87.50 |
| park | 47.6 → 37.7 s | 84.80 → 84.03 |
| ducks | 46.6 → 37.2 s | 70.69 → 70.69 |

Jellyfish's first pass came out 1.5% over the size limit either way. Refits cut chunks into pieces so every encoder
has work, but pieces had to be at least 30 frames, so its two 41- and 44-frame chunks went again whole, on 2 of 8
encoders. With a 20-frame minimum the second pass takes 1.5 s less. (An earlier test had found shorter pieces slower,
on a phone clip where the extra keyframes pulled another chunk into the refit; here there was nothing to pull in.)

## Settings that trade one metric for another (not shipped)

`research/tuning_sweep.py` tries x264 switches that cost no time, against the shipped setting (BD-rate, CRF 16-24,
mean over the corpus):

| Switch | VMAF NEG | VMAF | SSIM | PSNR-Y |
| --- | --- | --- | --- | --- |
| `--aq-strength 0.8` | −6.8% | −6.4% | +2.3% | −3.5% |
| `--aq-strength 1.2` | +7.8% | +7.6% | −2.3% | +4.1% |
| `--qcomp 0.5` | −5.1% | −4.8% | +2.0% | −1.7% |
| `--psy-rd 1.0:0.15` | −0.6% | −5.7% | +2.4% | +2.9% |
| `--deblock -1:-1` or `1:1` | −0.1%, +0.5% | | | |
| `--direct auto` | +9.3% | | | |
| `--no-fast-pskip` | +2.5% (screen +15%) | | | |

Weaker adaptive quantization and a flatter `qcomp` look like big wins on VMAF NEG (town −19.6% and −25.9%), but they
work by moving bits out of flat areas, which is exactly what SSIM says got worse and where banding shows. VMAF is known
to undercount banding, so shipping them would mean tuning Pare to its own measuring stick. Psychovisual trellis only
helps plain VMAF, the metric that rewards sharpening. `--psy-rd` strength changes nothing at `faster`, which doesn't run
psychovisual RD. The shipped setting stays.

## Quantization matrices for AV1

The same question for SVT-AV1's switches that aren't about speed (`research/av1_sweep.py`, preset 8, CRF 22-40,
BD-rate against plain preset 8):

| Switch | VMAF NEG | VMAF | SSIM | PSNR-Y | CPU |
| --- | --- | --- | --- | --- | --- |
| **`--enable-qm 1`** (flatness 8-15) | **−3.0%** | **−2.6%** | **−3.5%** | **−0.6%** | **0.92×** |
| `--enable-qm 1 --qm-min 0` | −6.3% | −5.6% | −10.1% | +14.4% | 0.91× |
| `--sharpness 1` / `-1` | +0.2% / +0.1% | | | | |
| `--ac-bias 1` | −0.7% | | | | 1.05× |
| `--qp-scale-compress-strength 1` | −0.8% (Big Buck Bunny +2.7%) | | | | |
| `--tune 2` (SSIM) | +12.8% | | | | |

Quantization matrices at SVT-AV1's default flatness are the rare switch every metric agrees on, on every clip except
PSNR on park (+0.2%) and Big Buck Bunny (+2.2%), and they take 8% off the CPU time too, so AV1 now uses them. The steeper matrices score better
still on the two perceptual metrics, but PSNR loses 14% and the screen recording gets worse on all of them, and text is
where a softer high end shows. Not shipped.

## HDR stays HDR

Phones record HDR by default, and the benchmark had no HDR video at all. Testing one showed what Pare did with it: the
10-bit frames were rounded to 8 bits and encoded with the source's HDR tags (BT.2020 with HLG or PQ) still on, so the
file claimed HDR with 8-bit precision, which bands in smooth gradients, worst with PQ. The settings screen said the copy
was SDR, which wasn't true either. Resized videos really are SDR: they go through a canvas.

x264's build here is 8-bit, but SVT-AV1 encodes 10-bit natively, and WebCodecs hands 10-bit frames over as 16-bit
planes (`I420P10`) that can be copied into its input as they are. So at the video's own size, an HDR source now goes to
AV1 in 10 bits: Auto sends it there without testing H.264 when the device decodes 10-bit AV1, and choosing AV1 does
the same. The size plan runs in 10 bits too. One trap on the way: asked about AV1 with a PQ or HLG transfer function,
Chrome says it can't play it on a screen without HDR, and then plays the file anyway, tone-mapped. What matters for
keeping HDR in the file is whether 10-bit AV1 decodes, so that's the question Pare asks.

Two 5-second test clips, the camera footage converted to HLG and to PQ in 10-bit AV1, in the browser, measured on the
10-bit signal:

| Clip | Before | Now |
| --- | --- | --- |
| HLG | 8-bit H.264, 1.90 MB, PSNR-Y 44.3 dB, 21.6 s | 10-bit AV1, 1.89 MB, 47.6 dB, 35.5 s |
| PQ | 8-bit AV1, 1.40 MB, 46.7 dB, 25.7 s | 10-bit AV1, 1.61 MB, 48.1 dB, 32.1 s |

The AV1 sequence header now tells the MP4 codec string its bit depth (`av01.0.08M.10`), read from the header's colour
config rather than assumed. What isn't tested: phone HDR is HEVC, which headless Chrome on Linux can't decode. If a
Mac's hardware decoder hands frames over in another format, they take the RGB path and come out 8-bit, as before.

As first shipped, this went by the container's tags, and that was wrong. See "Bit depth from the decoded frame" below.

## Threaded AV1 instead of chunks (not shipped)

Chunk keyframes cost AV1 the most, and x264 answered that with fewer, longer chunks and more threads each. SVT-AV1
has threads too, and the research build of its command-line encoder has had them all along. The notes above say its
threading ran at 11.8 fps; that was before the WebAssembly SAD kernels. In Node now, on town's 250 frames at CRF 30:

| Layout | Time | Size |
| --- | --- | --- |
| 8 chunks, one thread each | 22.0 s | 3.80 MB |
| 4 chunks, `--lp 2` | 18.7 s | 3.59 MB |
| 2 chunks, `--lp 4` | 14.5 s | 3.48 MB |
| one encode, `--lp 8` | 13.7 s | 3.45 MB |

(`--lp` is a level, not a thread count: SVT-AV1 starts about 48 threads at level 2 and 74 at level 4, most of them
idle pipeline stages, and anything from `--lp 4` up is the same at 1080p. Output is byte-identical at every level.)

That looked like the fix, so I built a threaded browser module (80 workers pre-started per encoder, since a thread
started while the encoder blocks never runs) and tried it in Chrome. The browser told a different story. The 8-chunk
Node figure had paid for 8 processes starting 64 threads each; Pare's 8 one-thread chunks don't. At the same rate
factor, against the shipped 8 chunks:

| CRF | Clip | 8 chunks, one thread | One encoder, 8 threads | Two encoders, 4 threads |
| --- | --- | --- | --- | --- |
| 36 | town | 2.63 MB, VMAF NEG 90.14, 13.4 s | 2.20 MB, 90.39, 14.8 s | 2.26 MB, 90.34, 15.3 s |
| 36 | tree | 3.46 MB, 89.60, 15.8 s | 3.15 MB, 89.73, 19.6 s | 3.19 MB, 89.73, 17.5 s |
| 18 | town | 12.32 MB, 95.25, 16.7 s | 13.88 MB, 95.60, 18.5 s | |
| 18 | tree | 19.00 MB, 95.36, 17.8 s | 20.78 MB, 95.68, 19.7 s | |

At Auto's usual rate factors for AV1 the threaded layouts save 9-16% of the bits at equal or better quality; at CRF
18 they don't save anything. Either way they're 10-24% slower, since one worker decodes and feeds every frame, and
each encoder needs about 1.5 GB and 80 workers. The size plan also needs recalibrating: counted for two keyframes
instead of eight, its estimate came out 14% low on town, the first pass went over, and a second pass took the time to
39.6 s against 29.3. About 0.8 VMAF NEG isn't worth that, so AV1 stays at one thread per chunk.

## Bit depth from the decoded frame

A review of the HDR change turned up the case it broke. Whether to encode 10-bit came from the container's colour tags,
through Mediabunny's `hasHighDynamicRange`, which is true for BT.2020 or Display P3 primaries whatever the transfer and
bit depth. The pixel format came from the decoder, in the worker, and the two never met. An 8-bit video tagged HLG (a
camera's 8-bit HLG mode, made here with ffmpeg) went into a 10-bit encoder, and its 8-bit frames were copied into
16-bit planes. Against its source the result scored SSIM 0.009 and PSNR 7.8 dB, at 192% of the original's size. The
app said "Good, SSIM 0.94", because the encoder compares its output with its own input, which was already scrambled.
An SDR video in Display P3 went the same way inside Auto: AV1's test windows scored VMAF NEG 19, so Auto kept H.264
and never showed the broken file, by luck.

Now the probe decodes one frame and keeps its pixel format and visible size. One function decides whether frames go
into the encoder as decoded (a planar 4:2:0 format at the output size) or through the RGB canvas, and the colour tags,
the bit depth, the Auto HDR route and the note on the settings screen all follow it. HDR now means a PQ or HLG
transfer. 10-bit needs a 10- or 12-bit decoded frame, the direct path and a device that decodes 10-bit AV1. Frames
drawn on the canvas are tagged BT.709, since that's what they are, and the worker refuses a frame that decodes
differently from the plan instead of writing it wrong.

| Clip | Before | Now |
| --- | --- | --- |
| 8-bit HLG | 10-bit AV1 from 8-bit data: 192% of the size, SSIM 0.009 | 8-bit AV1 tagged HLG: 40.6%, SSIM 0.969, PSNR 42.2 dB |
| Display P3 SDR | H.264 (AV1's test broken): 48.2%, 53.5 s | AV1 at VMAF NEG 95.8 against H.264's 92.6: 40.7%, 36.0 s |
| 10-bit HLG and PQ | 10-bit AV1 | the same bytes, plus a `colr` box |

The output also gets a `colr` box now, with the tags the encoder used, since some players read the container rather
than the bitstream.

## Rotated videos

Phone videos are stored landscape with a rotation flag. Frames that go through the canvas (any resize, 4:2:2 and 4:4:4
sources, formats WebCodecs doesn't name) were drawn with the rotation applied by Mediabunny's `transform`, then
squeezed back into the stored frame's shape, and the output kept the rotation flag, so they came out turned twice and
distorted. A portrait clip resized to 720p scored SSIM 0.36 against its source. None of the benchmark clips were
rotated. Now samples are drawn as stored, the container carries the rotation, and the mirror flag too, which was
dropped before: SSIM 0.95, the loss from resizing. A rotated video at its own size was never affected, and still comes
out byte-identical.

## One test window

The size plan uses fewer test windows when there are few encoders or frames: one at 4K (2 encoders), on clips under
80 frames, and on 2- or 3-core devices. H.264's estimate of AV1's two windows then covered no windows at all, an
estimate of 0 bytes, and the scale between them became infinite. Auto printed "NaN VMAF" for both formats, and on the
predicted path planned AV1 at CRF 44 ("Infinity MB"). On a 70-frame clip that pass came out at 0.54 MB against a goal
of 2.1 MB and every chunk was encoded again. Now AV1's windows are the ones that exist, and the scale and scores stay
finite: CRF 22.3, 46.8% of the original instead of 37.4%, SSIM 0.960 against 0.959. AV1's windows also sit where
H.264's did now, even where the two encoders run different numbers of workers (at 1440p x264 runs 6 and SVT-AV1 5,
which placed 3 windows against 2).

## The container's share of the size

The size check took a flat 64 KB off the limit for the MP4's own boxes. Measured on Pare's files, the boxes are about
1.3 KB plus 4-5.5 bytes per AV1 frame and 13 per H.264 frame (B-frames add timing offsets), and about 4 per audio
packet: 1.5 KB on a 150-frame clip, 15 KB on the 20-second phone clips with their audio. On a 3-5 MB source, 64 KB was
1.3-1.9% of the limit, and every small AV1 encode landed just over it and went for a second pass. The allowance is now
an upper bound from those numbers (4 KB plus 24 bytes a frame and 12 an audio packet), copied audio is counted
exactly from the container's index instead of extrapolated from its first 500 packets, and the finished file is
weighed after muxing, with another pass if it's still over. A second pass now aims at 98.5% of the real limit, not
back at the first pass's 47%: across 11 logged refits they landed 9% under to 1.1% over their target. A second pass
on AV1 also no longer restarts the encoders for threads SVT-AV1 doesn't use.

Old build against new, one after the other (both measured with native libvmaf):

| Video | Time | VMAF NEG (worst frame) | Size |
| --- | --- | --- | --- |
| Jellyfish, 10 s | 41.6 → 35.7 s | 82.9 (73.4) → 83.8 (76.1) | 47.1% → 49.1% |
| HDR HLG, 5 s | 39.0 → 25.4 s | 91.2 (86.7) → 91.7 (88.8) | 47.1% → 48.8% |
| HDR PQ, 5 s | 33.0 → 23.4 s | 89.7 (86.5) → 90.1 (87.6) | 47.5% → 49.4% |
| Phone clip with PCM audio, 20 s | 36.6 → 36.1 s | 92.0 (83.0) → 92.3 (84.8) | 46.0% → 48.4% |

The first three no longer need a second pass. The PCM clip still does, and aims closer to the limit. The phone clips
(20 s, copied AAC) didn't change.

## SVT-AV1's own keyframes

SVT-AV1 starts a new GOP every ((fps + 16) / 16) × 16 × 5 frames at preset 8, 160 at 24-30 fps and 320 at 50-60. Every
chunk already opens with a keyframe, but a chunk longer than 160 frames at 30 fps paid for a second one. That's any
AV1 video from about 43 s at 30 fps on 8 encoders, sooner with fewer encoders or at 4K. As one 240-frame chunk
(`research/av1_keyint.py`, native SVT-AV1, Pare's settings), a GOP longer than the chunk needed 8.4% fewer bits for
the same VMAF NEG on Big Buck Bunny and 12.2% on the screen recording. The 50 fps clips never reach 320 in one chunk
and didn't change. AV1 now uses 10-second GOPs (`keyint=10s`), longer than any normal chunk, so seeking stays quick on
very long videos, whose chunks can grow past that.

In the browser, a 60-second 30 fps clip (Big Buck Bunny looped) with AV1 chosen: 18 keyframes became 16, one per
chunk; at the same rate factors the first pass came out 2.8% smaller (93.4 MB against 96.1), so 2 chunks went again
instead of 5. 158 s instead of 289 s, VMAF NEG 94.43 → 94.56, worst frame 91.62 → 92.03. Chunks under 160 frames,
which is every clip in the benchmark, encode byte-identically. The size plan's keyframe count stays as calibrated.

## Checking what a player shows

After the 8-bit HLG file scored "Good" while being noise, the quality check got a second opinion. It already decoded
eight frames from each file, drawn as a player draws them, for the side-by-side view, and scored them. Those now get
compared with the encoder's own SSIM on the same frames. When the side-by-side frames lose more than twice what the
encoder measured, plus 0.02, as a median over the eight, they're what gets reported, with a note. Normal files lose a
bit more side by side than the encoder saw, most on hard footage: noisy 0.241 against 0.208, Jellyfish 0.030 against
0.019, town 0.067 against 0.053. A test build that dropped the mirror flag showed 0.805 against 0.024 and now reads
"Visible loss" instead of "Visually identical".

## Audio, decided up front

Audio used to be dealt with after the whole video was encoded. Chrome on Linux has no AAC encoder and its Opus
encoder takes at most 2 channels, so a camera's 5.1 PCM track failed with "This specific encoder configuration (opus,
256000 bps, 6 channels) is not supported" after 37 s of encoding, and so did ALAC, which it can't decode. Now the probe
plans the audio: copy it when an MP4 can carry it, else encode it as it is in AAC or Opus, else as stereo, else at 48
kHz, and if nothing works (or the track doesn't decode) leave it out. The settings screen says which ("PCM audio is
converted to Opus, mixed down to stereo"; "This browser can't decode this video's audio, so the copy will be silent"),
the size budget counts the planned bitrate, and the browser's own encoder follows the same plan.

| Source audio | Before | Now |
| --- | --- | --- |
| PCM 5.1, 48 kHz | failed at the end | Opus stereo |
| ALAC | failed at the end | left out, with a note |
| AAC 5.1 | copied | copied |
| PCM 96 kHz, Vorbis in MKV, PCM mono 8 kHz | Opus | Opus |

## Safari's engine

The README said Safari 17 and later; nobody had tried. Playwright's WebKit 26.6 build has everything Pare needs
(WebCodecs, cross-origin isolation, WebAssembly SIMD), and every compression failed:

- WebKit's `VideoFrame.copyTo` won't write into a resizable buffer ("Resizable ArrayBuffer is not allowed"), and the
  threaded encoder's memory is one. Once it refuses, frames go through a plain buffer first, plane by plane. That's
  one more copy per frame, and only there.
- It reports AV1 as decodable, 10-bit included, and then fails on every frame, even a 64×64 keyframe from libaom.
  The probe now trusts a real first-frame decode ("This browser can't decode AV1 video"), and before Auto may pick
  AV1, Pare decodes a 27-byte AV1 keyframe. Otherwise Auto would have written files the same browser can't play.
- Locally, the preview server answered revalidations with a bare 304 without the isolation headers, and WebKit then
  refused worker scripts it had loaded fine the first time. Vercel serves assets as immutable, so browsers there don't
  ask again, and the local server no longer revalidates.

Now town and a 3-second clip compress in WebKit, to H.264 (42% and 50% of the original, SSIM 0.96 and 0.98), live
included. It's slow: the size plan took 34 s on town against 11 s in Chrome. Real Safari on a Mac decodes with
VideoToolbox instead, and hasn't been tried.

## Resizing without a canvas

Resizing used to draw every frame on an RGB canvas at the output size (Mediabunny's `transform`) and convert it back
to YUV. Timing the worker showed where a 4K phone clip taken to 720p spent its time: 25.6 s per worker getting frames
in against 0.8 s encoding them, about 170 ms a frame. The round trip also costs quality: 8-bit RGB in the middle,
BT.709 whatever the source was, and a canvas downscale that aliases.

Now the decoded planes are scaled in WebAssembly, straight into the encoder's (`x264-wasm/pare_scale.h`, linked into
both encoders): a separable bicubic filter (Catmull-Rom), widened by the ratio when shrinking, as ffmpeg's swscale
does, in fixed point. It matches ffmpeg's bicubic to 55.6-56.4 dB PSNR. The SIMD version runs the vertical pass 16
samples at a time into 16-bit lanes, then lays four output rows out as pairs of neighbouring samples, so one dot
product makes two taps of all four. It's bit-exact with the plain C version it replaced, and took luma from 1080p to
720p in 5.8 ms a frame on this machine (11.7 ms before the dot products), from 4K in 13.7 ms (28.8). Resized videos now keep
their colour tags, and an HDR video resized stays HDR: 10-bit AV1 tagged HLG at 720p. Frames the encoders can't take
as planes (Firefox decodes to RGB, and 4:2:2 or 4:4:4 sources) still go through the canvas.

In Chrome at 720p, old build against new, one after the other, scored with native libvmaf against the full-size
source:

| Video | Time | VMAF NEG (worst frame) | PSNR-Y | Size |
| --- | --- | --- | --- | --- |
| 4K phone clip, 10 s | 35.8 → 15.8 s | 81.1 (76.9) → 85.9 (81.3) | 42.2 → 46.6 dB | 23.1% → 22.8% |
| Phone clips, 1080p50, 20 s | 52.2 → 35.6 s | 80.6 (67.7) → 84.3 (70.8) | 34.0 → 35.0 dB | 45.9% → 47.3% |
| Big Buck Bunny, 10 s | 32.8 → 24.5 s | 73.1 (71.1) → 83.7 (80.9) | 32.2 → 34.2 dB | 45.8% → 40.4% |
| Rotated clip, 3 s | 17.3 → 14.1 s | 83.7 (80.9) → 87.0 (84.0) | 37.3 → 38.1 dB | 24.0% → 22.6% |

The files are also smaller at the same rate factor: canvas aliasing is detail x264 had to spend bits on. A later run
with the faster version, while another job loaded the machine: the time each worker spent bringing frames in went
from 44.5 s to 5.6 s on the 4K clip, 48.9 s to 5.3 s on the phone clips and 10.9 s to 1.8 s on Big Buck Bunny.

## Firefox

Firefox 155 (Playwright's build) runs Pare as it is, with one difference: its decoder hands frames over as BGRX, even
from 10-bit AV1. Frames going into the encoder take the RGB path, which was fine, but the test encodes decoded back
for VMAF were read as if their first plane were luma, and Auto scored both formats 0.00. They're converted back to
luma now. After that, Firefox made the same choices as Chrome: town and a 3-second clip to AV1 (VMAF NEG 95.6 against
H.264's 92.5), the camera footage to the superfast tier. Its RGB frames cost 3.4-5.5 s per worker to bring in, against
0.1-0.4 s for Chrome's YUV frames. The conversion to YUV is now WebAssembly SIMD too (`x264-wasm/pare_rgb.h`,
bit-exact, 13.2 → 4.3 ms a 1080p frame), but most of the time is Firefox's own `copyTo`, about 68 ms a frame here: its
decoder hands over BGRX whether asked for hardware or software decoding.

Same headless Chrome, same files, production builds:

| Clip | ffmpeg.wasm build | SIMD build, first size target | Now |
| --- | --- | --- | --- |
| 20 s 1080p50 phone-style (65.5 MB) | 105.2 s, no size target | 75 s, −61%, SSIM 0.943 | 42 s, −54%, SSIM 0.951 |
| 10 s 1080p30 camera (77.9 MB) | 27.3 s | 31 s, −80% | 11 s, −69%, SSIM 0.994 |
| 10 s Big Buck Bunny (30.7 MB) | | 41 s, −60%, SSIM 0.980 | 24 s, −56%, SSIM 0.983 |
| 2 min 1080p50 phone-style (392 MB) | | | 197 s, −52%, SSIM 0.952 |

"Now" includes the size plan when Compress is clicked a second after the file loads. The ffmpeg.wasm build had no
size target. The middle column aimed at 44% of the original and often landed far below it; aiming at 47% and checking
the result spends the allowance on quality. The camera footage now comes out bigger than before on purpose, because
its spare room goes to speed ("Room to spare goes to speed").

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
- `research/benchmark.mjs`, `score.py` and `report.py` produce the tables in `research/BENCHMARKS.md`.
- `research/benchmark.mjs` takes `BROWSER=webkit|firefox` and `RES=720`.
- `research/speed_sweep.py` and `research/av1_sweep.py` are the x264 and SVT-AV1 speed sweeps;
  `research/av1_chunks.py` and `research/x264_chunks.py` measure what chunk keyframes cost, and `research/av1_keyint.py`
  what SVT-AV1's own keyframe interval costs a long chunk.
- `research/ffmpeg-wasm/` runs stock ffmpeg.wasm in Chrome for the comparison in `research/BENCHMARKS.md`.

## Licensing

x264 is GPL-2.0-or-later, and the WebAssembly build is served to users, so the corresponding source (x264 at
`X264_COMMIT` plus `x264-simd128.patch` and `pare_x264.c`) has to be offered to them. The previous ffmpeg.wasm build
had the same obligation. SVT-AV1 (BSD-3-Clause-Clear, with the Alliance for Open Media patent license) and libvmaf
(BSD-2-Clause-Patent) are permissive and GPL-compatible; their patches and bindings are in `av1-wasm/` and
`vmaf-wasm/`.
