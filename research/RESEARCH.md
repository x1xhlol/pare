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

**WebAssembly SIMD128 kernels for x264** (`x264-wasm/x264-simd128.patch`, ~1,600 lines):
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
comes out 63% *larger*. Pare now plans each file: one round of 1-second test windows at the preset's rate factor and
at one ~half the size (half the cores each), with keyframes and scene cuts priced separately and a measured 8%
bias correction. Files predicted under 44% of the original keep the visually lossless setting; others get the rate
factor interpolated to 44%, capped at CRF 30. Results on the corpus: −54% to −86%, all but the hardest grainy clip
"visually identical" or "excellent" by the in-app SSIM check.

## End to end in the browser

Same headless Chrome, same files, previous production build vs. the new one:

| Clip | Before | After | Size | VMAF (vs. source) |
| --- | --- | --- | --- | --- |
| 20 s 1080p50 phone-style | 105.2 s | 54.2 s (1.9×) | 78.9 → 76.3 MB | 95.63 → 97.43 |
| 10 s 1080p30 camera | 27.3 s | 19.3 s (1.4×) | 10.5 → 10.6 MB | SSIM 0.9887 → 0.9897 |

Short clips gain less because worker start-up and the first keyframe of each chunk are fixed costs.

## Reproducing

- `x264-wasm/build.sh` rebuilds `src/lib/x264/x264.{mjs,wasm}` from the pinned x264 commit plus the patch, and runs
  `checkasm`.
- `research/evaluate.py` / `research/experiments.py` run the rate-quality sweeps (native x264 build, ffmpeg with
  libvmaf, corpus in `corpus/ref/*.y4m`).
- `research/wasm-bench.mjs` times the WebAssembly encoder on raw frames in Node; `research/browser-ab.mjs` times a
  full compression in the browser against any deployment.

## Licensing

x264 is GPL-2.0-or-later, and the WebAssembly build is served to users, so the corresponding source (x264 at
`X264_COMMIT` plus `x264-simd128.patch` and `pare_x264.c`) has to be offered to them. The previous ffmpeg.wasm build
had the same obligation.
