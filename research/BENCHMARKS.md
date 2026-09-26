# Benchmarks

Every number here comes from `research/benchmark.mjs` (a real Chrome, the production build, default settings:
visually lossless, at least 50% smaller, format Auto) and `research/score.py` (native libvmaf over every frame of the
output against the decoded source). Compress is clicked a second after the file loads, so the time includes the size
plan and Auto's tests, and runs from that click to the finished file.

The machine is a 4-core, 8-thread cloud VM with no GPU, shared with other work. Decoding is in software here; a
laptop decodes H.264 in hardware and has more cores, so it will be faster.

VMAF NEG is Netflix's VMAF without the enhancement gain, so sharpening can't raise it. Around 93 to 95 a re-encode
stops looking different from its source at normal viewing distance; 1st percentile and worst frame show how the
weakest moments hold up.

## Results

Twelve videos, from footage with plenty of room (camera, screen recording) to noisy 25 Mbps re-encodes where no
current encoder reaches 1:1 at half the size. "Before" is the build from before this round (commit `b34f83a`), run
alternately with the current one on the same machine so load hits both the same way.

| Video | Original | Now: size | Format | Time, before → now | VMAF NEG, before → now | Worst frame, now |
| --- | --- | --- | --- | --- | --- | --- |
| Camera footage, 1080p30, 10 s | 77.9 MB | 24.35 MB (-69%) | H.264 | 28.7 → 10.0 s | 97.9 → 97.8 | 95.6 |
| Screen recording, 1080p30, 8 s | 10.8 MB | 4.10 MB (-62%) | H.264 | 12.3 → 8.7 s | 99.0 → 99.0 | 95.6 |
| Big Buck Bunny, 1080p30, 10 s | 30.7 MB | 14.05 MB (-54%) | H.264 | 36.5 → 26.8 s | 93.0 → 92.8 | 89.4 |
| Phone clip with PCM audio, 1080p50, 10 s | 49.8 MB | 23.31 MB (-53%) | H.264 | 43.2 → 33.0 s | 92.4 → 92.4 | 84.4 |
| Phone clips, 1080p50, 20 s | 65.5 MB | 30.07 MB (-54%) | H.264 | 59.0 → 42.4 s | 87.8 → 87.9 | 71.9 |
| town, 25 Mbps re-encode, 1080p50, 5 s | 15.8 MB | 7.27 MB (-54%) | AV1 | 31.5 → 37.4 s | 90.3 → 93.9 | 90.9 |
| tree, same, 5 s | 15.1 MB | 5.90 MB (-61%) | AV1 | 32.5 → 39.0 s | 88.2 → 91.9 | 87.8 |
| noisy, same, 5 s | 15.8 MB | 7.23 MB (-54%) | AV1 | 38.1 → 55.0 s | 80.9 → 87.3 | 80.2 |
| Jellyfish, already 4.2 Mbps, 1080p30, 10 s | 5.2 MB | 2.39 MB (-54%) | AV1 | 47.4 → 37.0 s | 82.8 → 82.4 | 74.2 |
| park, 25 Mbps re-encode, 5 s | 16.2 MB | 7.64 MB (-53%) | AV1 | 66.1 → 59.5 s | 82.8 → 83.7 | 70.5 |
| ducks (rippling water), same, 5 s | 17.2 MB | 7.39 MB (-57%) | AV1 | 60.3 → 45.9 s | 72.3 → 71.1 | 57.4 |
| Phone clips, 1080p50, 2 min | 392.1 MB | 187.97 MB (-52%) | H.264 | 262.7 → 195.7 s | 88.4 → 88.4 | 67.1 |

All videos together: 718 s before, 590 s now (18% less), for 223 s of video.

Every file is at least 50% smaller. Where the source has room, quality is at or near 1:1: the camera footage and
screen recording score 97.8 and 99.0, and town, Big Buck Bunny, the PCM clip and tree 92 to 94.

The camera footage has so much room that Pare encodes it at x264's `superfast` preset, about half the work: 28.7 s
became 10.0 s, at the same VMAF NEG (97.9 before, 97.8 now; the worst frame went from 93.9 to 95.6), in a file 69%
smaller instead of 79%. The other H.264 videos got 24-29% faster, most of it from x264 settings that do a third less
work at the same quality per byte, and Big Buck Bunny also from skipping frames its decoders don't need. On the noisy
25 Mbps re-encodes Auto's AV1 lifts noisy by 6.4 points and town and tree by 3.6 to 3.7, and that costs time: those
three take 19-44% longer. The other AV1 videos got 10-24% faster.

## Where the time goes

What happens between the click (a second after the file loads) and the file, from timestamps logged in the same
runs:

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

## Starting before Compress

Once the size plan and the format are settled, Pare starts compressing while the settings are still on screen.
Clicking 15 seconds after the file loads, as someone reading the settings might:

| Video | Click to file, before | Now | Load to file, before | Now |
| --- | --- | --- | --- | --- |
| Camera footage, 10 s | 16.9 s | 0.1 s | 31.9 s | 15.1 s |
| Phone clips, 20 s | 43.2 s | 33.0 s | 58.3 s | 48.0 s |
| Big Buck Bunny, 10 s | 21.9 s | 14.8 s | 36.9 s | 29.8 s |

The camera footage had finished before the click: the click only shows the result.

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

Park, ducks and noisy can't be halved at about 1:1 by x264 or SVT-AV1: their noise is the detail, and it takes more
bits than the source spends (noisy would need 1.6 to 2.9 times its own size). At half the size Pare's AV1 gets noisy to
87.3, about what either encoder can do there. Town and tree can be halved at about 1:1, with AV1, and that's where
Auto sends them. (Noisy's row uses Pare's current x264 settings; the others its previous ones, which have the same
quality per byte.)

## Speed in context

The first version of Pare ran ffmpeg.wasm: 105 s for the 20-second phone clips without any size target, and 27 s for
the camera footage. Now the phone clips take 42 s and the camera footage 10 s, halved and checked, and with a head
start the camera footage is ready when Compress is clicked. A browser's own encoder is faster still (1.1 to 2.7 times
real time on this machine), but in software here it scored 93.4 VMAF NEG on the camera footage at the same budget,
against Pare's 97.7, and couldn't halve the phone clips at all.

## Reproducing

```sh
bun run build && bun x vite preview                               # the production build on :4173
OUT=/tmp/bench TAG=now node research/benchmark.mjs clip.mp4 ... > runs.jsonl
python3 research/score.py runs.jsonl > scored.jsonl               # native libvmaf, every frame
python3 research/report.py scored.jsonl old-tag new-tag           # the table above
```
