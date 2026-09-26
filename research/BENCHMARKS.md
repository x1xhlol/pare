# Benchmarks

Every number here comes from `research/benchmark.mjs` (a real Chrome, the production build, default settings:
visually lossless, at least 50% smaller, format Auto) and `research/score.py` (native libvmaf over every frame of the
output against the decoded source). Compress is clicked a second after the file loads, so the time includes the size
plan and Auto's tests, and runs from that click to the finished file.

The machine is a 4-core, 8-thread cloud VM with no GPU, shared with other work. Decoding is in software here. A
laptop usually decodes H.264 in hardware and may have more cores; "On a smaller machine" below shows how the time
scales with cores.

VMAF NEG is Netflix's VMAF without the enhancement gain, so sharpening can't raise it. Around 93 to 95 a re-encode
stops looking different from its source at normal viewing distance. The worst frame shows how the weakest moment holds
up.

## Results

Twelve videos, from footage with plenty of room (camera, screen recording) to noisy 25 Mbps re-encodes where no
current encoder reaches 1:1 at half the size. "Before" is the build from 25 September, before this work (commit
`b34f83a`), run alternately with the current one on the same machine so load hits both the same way.

| Video | Original | Now: size | Format | Time, before → now | VMAF NEG, before → now | Worst frame, now |
| --- | --- | --- | --- | --- | --- | --- |
| Camera footage, 1080p30, 10 s | 77.9 MB | 23.89 MB (-69%) | H.264 | 29.4 → 10.8 s | 97.9 → 97.8 | 95.6 |
| Screen recording, 1080p30, 8 s | 10.8 MB | 3.49 MB (-68%) | H.264 | 12.4 → 8.7 s | 99.0 → 99.0 | 95.6 |
| Big Buck Bunny, 1080p30, 10 s | 30.7 MB | 13.42 MB (-56%) | H.264 | 36.0 → 23.9 s | 93.0 → 93.1 | 88.9 |
| Phone clip with PCM audio, 1080p50, 10 s | 49.8 MB | 22.89 MB (-54%) | H.264 | 42.6 → 30.7 s | 92.4 → 92.0 | 83.0 |
| Phone clips, 1080p50, 20 s | 65.5 MB | 30.23 MB (-54%) | H.264 | 57.2 → 42.3 s | 87.8 → 87.9 | 71.9 |
| town, 25 Mbps re-encode, 1080p50, 5 s | 15.8 MB | 7.00 MB (-56%) | AV1 | 31.0 → 29.3 s | 90.3 → 93.9 | 90.0 |
| tree, same, 5 s | 15.1 MB | 5.89 MB (-61%) | AV1 | 31.9 → 30.0 s | 88.2 → 92.1 | 88.5 |
| noisy, same, 5 s | 15.8 MB | 6.84 MB (-57%) | AV1 | 38.5 → 35.0 s | 80.9 → 87.5 | 79.1 |
| Jellyfish, already 4.2 Mbps, 1080p30, 10 s | 5.2 MB | 2.46 MB (-53%) | AV1 | 49.1 → 37.5 s | 82.8 → 82.9 | 73.6 |
| park, 25 Mbps re-encode, 5 s | 16.2 MB | 7.62 MB (-53%) | AV1 | 67.7 → 36.9 s | 82.8 → 84.0 | 71.7 |
| ducks (rippling water), same, 5 s | 17.2 MB | 7.04 MB (-59%) | AV1 | 61.6 → 35.9 s | 72.3 → 70.7 | 57.9 |
| Phone clips, 1080p50, 2 min | 392.1 MB | 189.06 MB (-52%) | H.264 | 263.2 → 197.4 s | 88.4 → 88.5 | 67.1 |

All videos together: 721 s before, 518 s now (28% less), for 223 s of video.

Every video is faster than before, and every file at least 50% smaller. Where the source has room, quality is at or
near 1:1: the camera footage and screen recording score 97.8 and 99.0, and town, Big Buck Bunny, tree and the PCM clip
92 to 94.

The camera footage has so much room that Pare encodes it at x264's `superfast` preset, about half the work: 29.4 s
became 10.8 s, at the same VMAF NEG (97.9 before, 97.8 now; the worst frame went from 93.9 to 95.6), in a file 69%
smaller instead of 81%. The other H.264 videos got 25-34% faster: x264 settings that do a third less work at the same
quality per byte, fewer and longer chunks on short videos (Big Buck Bunny also scores a little higher, in a file 56%
smaller instead of 54%), and less decoding before each chunk.

The noisy 25 Mbps re-encodes now go to AV1, which lifts noisy by 6.6 points and town and tree by 3.6 to 3.9. They
still finish 5-9% sooner than H.264 did before, because where H.264's first test round already shows that AV1 is the
choice, Auto no longer tests AV1's quality, only its size. Jellyfish, park and ducks got 24-45% faster, and park 1.2
points better, helped by cheaper keyframes for AV1's short chunks.

Two videos lost a little. Ducks lost 1.6 points because its first pass landed at 87% of the size goal and Pare left
the room unused. The PCM clip lost 0.4, from being split into 8 chunks instead of 7.

## Since then: quantization matrices and 10-bit HDR

Two later changes, measured against the build before them (commit `43001d5`), alternating on the same machine: AV1
now uses quantization matrices, and HDR sources stay HDR, as 10-bit AV1. The six AV1 rows in the table above predate
both. The same build ran 7 s apart on Jellyfish between sessions, so compare within this table, not across tables.

| Video | Original | Now: size | Format | Time, before → now | VMAF NEG, before → now | Worst frame, now |
| --- | --- | --- | --- | --- | --- | --- |
| town, 25 Mbps re-encode, 1080p50, 5 s | 15.8 MB | 7.12 MB (-55%) | AV1 | 29.9 → 30.0 s | 93.9 → 94.1 | 89.9 |
| tree, same, 5 s | 15.1 MB | 5.87 MB (-61%) | AV1 | 30.9 → 31.9 s | 92.1 → 92.2 | 88.6 |
| noisy, same, 5 s | 15.8 MB | 6.92 MB (-56%) | AV1 | 35.9 → 37.3 s | 87.5 → 87.7 | 79.2 |
| Jellyfish, already 4.2 Mbps, 1080p30, 10 s | 5.2 MB | 2.47 MB (-53%) | AV1 | 44.6 → 47.2 s | 82.9 → 82.9 | 73.4 |
| park, 25 Mbps re-encode, 5 s | 16.2 MB | 7.69 MB (-53%) | AV1 | 45.5 → 41.1 s | 84.0 → 84.3 | 72.1 |
| ducks (rippling water), same, 5 s | 17.2 MB | 7.14 MB (-58%) | AV1 | 40.3 → 41.5 s | 70.7 → 71.1 | 58.1 |
| HDR test clip (HLG), 10-bit, 1080p30, 5 s | 4.0 MB | 1.89 MB (-53%) | AV1 | 21.6 → 35.5 s | 83.3 → 91.2 | 86.7 |
| HDR test clip (PQ), 10-bit, 1080p30, 5 s | 3.4 MB | 1.61 MB (-53%) | AV1 | 25.7 → 32.1 s | 87.5 → 89.7 | 86.5 |

All videos together: 274 s before, 297 s now (8% more), for 45 s of video.

On the AV1 clips quality rose by 0.0 to 0.4 points at about the same sizes, with times inside the noise. The two HDR
clips are the camera footage converted to HLG and to PQ in 10-bit AV1. Headless Chrome on Linux can't decode HEVC, so
they stand in for a phone's HDR video; whether a Mac's HEVC decoder hands its frames over as 10-bit planes the same way
is untested. Before, the HLG clip came out as 8-bit H.264 and
the PQ clip as 8-bit AV1, both still tagged HDR; now both are 10-bit AV1. VMAF isn't made for HDR, so here is PSNR on
the 10-bit luma as well: HLG 44.3 → 47.6 dB in the same size file, PQ 46.7 → 48.1 dB. They take 6 to 14 s longer,
most of it AV1's 10-bit encode.

## Where the time goes

What happens between the click (a second after the file loads) and the file, from timestamps logged in earlier runs.
Since then Big Buck Bunny's encode got about 2 s shorter, and town decides on AV1 in about 15 s instead of 22 and
encodes on 8 encoders instead of 7.

| Video | Plan and Auto, after the click | Encode | Frames encoded per second | Writing the MP4 |
| --- | --- | --- | --- | --- |
| Camera footage | 4.0 s (superfast test and its VMAF) | 5.6 s | 39 (204 frames; the test's 96 are kept) | 0.2 s |
| Big Buck Bunny | 11.5 s | 14.3 s | 22 | 0.4 s |
| Phone clips, 20 s | 9.1 s | 32.4 s | 32 | 0.6 s |
| Phone clips, 2 min | 8.5 s | 184.9 s | 33 | 1.6 s |
| town (AV1) | 22.4 s (AV1's test ends 21 s after the click) | 14.5 s | 18 | 0.3 s |

Once the plan is done, the encoders are the floor. x264 at Pare's settings encodes about 32 frames of 1080p a second
on all of this machine's cores, and SVT-AV1 about 18. Big Buck Bunny's source has a keyframe every 250 frames, so
its decoders work through many frames before their chunks start. The faster settings that exist cost quality at the
same size: x264's `veryfast` needs 40% more bits for the same VMAF NEG, and SVT-AV1's preset 9 needs 19% more for
0.67 times the CPU time (`research/RESEARCH.md`).

## Hard footage: AV1 or a faster H.264

On the six clips Auto sends to AV1, the only faster path is H.264. Forced to H.264 (format setting), same build:

| Video | H.264: time, VMAF NEG, size | Auto (AV1): time, VMAF NEG, size |
| --- | --- | --- |
| town, 5 s | 21.3 s, 91.0, −58% | 29.3 s, 93.9, −56% |
| tree, 5 s | 21.3 s, 88.8, −61% | 30.0 s, 92.1, −61% |
| noisy, 5 s | 22.4 s, 80.6, −58% | 35.0 s, 87.5, −57% |
| Jellyfish, 10 s | 31.0 s, 78.5, −32% (misses half) | 37.5 s, 82.9, −53% |
| park, 5 s | 27.5 s, 79.1, −53% | 36.9 s, 84.0, −53% |
| ducks, 5 s | 29.4 s, 65.6, −54% | 35.9 s, 70.7, −59% |

I expected H.264 to win back more time than this. It saves 6 to 13 s and gives up 2.9 to 6.9 points, and on
Jellyfish it can't reach half the size at all. AV1's own encode (14-18 s for these clips) is the floor. Its preset 9
takes 0.75-0.86x the CPU time for 1-17% more bits depending on the footage (noisy +9.3%), and its target-bitrate mode
overshot by 59% on 32-frame chunks.

## On a smaller machine

The same build with Chrome limited to half this machine (2 cores, 4 threads, via `taskset` and 4 reported cores):
town took 54.2 s instead of 29.3 (1.85x), and Big Buck Bunny 46.4 s instead of 23.9 (1.94x). Pare's time scales
almost linearly with cores, so every time here belongs to this machine, a 4-core, 8-thread Xeon Platinum 8259CL at
2.5 GHz from 2019.

## Starting before Compress

Once the size plan and the format are settled, Pare starts compressing while the settings are still on screen.
Clicking 15 seconds after the file loads, as someone reading the settings might:

| Video | Click to file, before | Now | Load to file, before | Now |
| --- | --- | --- | --- | --- |
| Camera footage, 10 s | 16.9 s | 0.1 s | 31.9 s | 15.1 s |
| Phone clips, 20 s | 43.2 s | 33.0 s | 58.3 s | 48.0 s |
| Big Buck Bunny, 10 s | 21.9 s | 14.8 s | 36.9 s | 29.8 s |

The camera footage had finished before the click, so the click only showed the result.

## How far 1:1 is

The sizes each encoder needs for VMAF NEG 93 and 95, from whole-clip sweeps (`research/RESEARCH.md`, "How close to 1:1
half the size can get"), against the 50% budget:

| Clip | x264 at 93 | x264 at 95 | AV1 at 93 | AV1 at 95 |
| --- | --- | --- | --- | --- |
| Big Buck Bunny | 39% | over the tested range | 26% | 61% |
| town | 76% | 120% | 28% | 66% |
| tree | 99% | 134% | 50% | 107% |
| park | over the tested range | 100% | 84% | 99% |
| ducks | 124% | 142% | 171% | 204% |
| noisy | 161% | 198% | 177% | 291% |

Park, ducks and noisy can't be halved at about 1:1 by x264 or SVT-AV1. Their noise is the detail, and it takes more
bits than the source spends (noisy would need 1.6 to 2.9 times its own size). At half the size Pare's AV1 gets noisy to
87.5, about what either encoder can do there. Town and tree can be halved at about 1:1, with AV1, and that's where
Auto sends them. (Noisy's row uses Pare's current x264 settings; the others its previous ones, which have the same
quality per byte.)

## Speed in context

Big Buck Bunny (10 s, 30.7 MB) on the same machine and browser, each file scored the same way:

| Tool | Time | File | VMAF NEG (worst frame) |
| --- | --- | --- | --- |
| Pare: size plan, Auto, encode, from the click | 24.9 s | 13.4 MB (−56%) | 93.1 (88.9) |
| ffmpeg.wasm 0.12, one thread, `faster` CRF 19 | 158.9 s | 12.2 MB (−60%) | 93.0 (89.8) |
| ffmpeg.wasm 0.12, multithreaded core, `faster` CRF 19 | 42.4 s | 12.2 MB (−60%) | 93.0 (89.8) |
| ffmpeg.wasm 0.12, one thread, `veryfast` CRF 23 (a common default) | 80.7 s | 5.1 MB (−83%) | 86.5 (82.8) |
| Native ffmpeg, as a desktop app would run it, Pare's x264 settings at CRF 19.1 | 6.4 s | 13.5 MB (−56%) | 93.3 (89.5) |

The ffmpeg.wasm runs were handed a rate factor; Pare finds its own for the size target, and that's in its time.
At the same quality it's 6.4 times as fast as the single-threaded ffmpeg.wasm most in-browser compressors use, and
1.7 times as fast as the multithreaded one (whose `veryfast` crashed). Its encode alone took 12.9 s, twice native x264
on the same cores. One continuous encode is also about 9% smaller than Pare's four chunks at the same VMAF NEG, which
is what splitting the video for speed costs on a clip this short.

The first version of Pare ran ffmpeg.wasm too: 105 s for the 20-second phone clips without any size target, and 27 s
for the camera footage. Now they take 42 s and 11 s, halved and checked, and with a head start the camera footage is
ready when Compress is clicked. A browser's own encoder is faster still (1.1 to 2.7 times real time on this machine),
but in software here it scored 93.4 VMAF NEG on the camera footage at the same budget, against Pare's 97.7, and
couldn't halve the phone clips at all.

## Reproducing

```sh
bun run build && bun x vite preview                               # the production build on :4173
OUT=/tmp/bench TAG=now node research/benchmark.mjs clip.mp4 ... > runs.jsonl
python3 research/score.py runs.jsonl > scored.jsonl               # native libvmaf, every frame
python3 research/report.py scored.jsonl old-tag new-tag           # the table above
```

The ffmpeg.wasm rows come from `research/ffmpeg-wasm/` (`bun install`, `INPUT=clip.mp4 bun serve.ts`, then
`node run.mjs st|mt <ffmpeg arguments>`), and the native row from the same ffmpeg build `research/score.py` uses.
