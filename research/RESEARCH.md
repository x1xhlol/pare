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

`faster` gets most of `medium`'s gain at about half its cost; `fast` is no better than `faster` and slower. The film
and grain tunes only win on the metric that rewards texture, and aq-mode 3 loses outright.

CRFs were then recalibrated so `faster` lands on the file sizes `veryfast` produced (CRF 18/22/26 → 18.3/22.4/26.4).
At those sizes VMAF NEG rises on every clip, by 1–5.5 points (e.g. ducks 93.4 → 96.6 at the visually lossless level).

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
