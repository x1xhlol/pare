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
| Camera footage, 1080p30, 10 s | 77.9 MB | 16.35 MB (-79%) | H.264 | 29.2 → 19.3 s | 97.9 → 97.7 | 93.9 |
| Screen recording, 1080p30, 8 s | 10.8 MB | 4.10 MB (-62%) | H.264 | 12.2 → 8.1 s | 99.0 → 99.0 | 95.6 |
| Big Buck Bunny, 1080p30, 10 s | 30.7 MB | 14.05 MB (-54%) | H.264 | 36.1 → 28.9 s | 93.0 → 92.8 | 89.4 |
| Phone clip with PCM audio, 1080p50, 10 s | 49.8 MB | 23.31 MB (-53%) | H.264 | 42.0 → 31.1 s | 92.4 → 92.4 | 84.4 |
| Phone clips, 1080p50, 20 s | 65.5 MB | 30.07 MB (-54%) | H.264 | 56.0 → 42.4 s | 87.9 → 87.9 | 71.9 |
| town, 25 Mbps re-encode, 1080p50, 5 s | 15.8 MB | 7.27 MB (-54%) | AV1 | 32.1 → 36.9 s | 90.3 → 93.9 | 90.9 |
| tree, same, 5 s | 15.1 MB | 5.90 MB (-61%) | AV1 | 33.0 → 39.6 s | 88.2 → 91.9 | 87.8 |
| noisy, same, 5 s | 15.8 MB | 7.23 MB (-54%) | AV1 | 38.1 → 54.6 s | 80.9 → 87.3 | 80.2 |
| Jellyfish, already 4.2 Mbps, 1080p30, 10 s | 5.2 MB | 2.39 MB (-54%) | AV1 | 48.2 → 39.6 s | 82.8 → 82.4 | 74.2 |
| park, 25 Mbps re-encode, 5 s | 16.2 MB | 7.64 MB (-53%) | AV1 | 67.1 → 60.6 s | 82.8 → 83.7 | 70.5 |
| ducks (rippling water), same, 5 s | 17.2 MB | 7.39 MB (-57%) | AV1 | 59.5 → 46.5 s | 72.3 → 71.1 | 57.4 |
| Phone clips, 1080p50, 2 min | 392.1 MB | 188.36 MB (-52%) | H.264 | 261.1 → 196.3 s | 88.3 → 88.4 | 67.1 |

All videos together: 715 s before, 604 s now (16% less), for 223 s of video.

Every file is at least 50% smaller. Where the source has room, quality is at or near 1:1: the camera footage and
screen recording score 97.7 and 99.0, and town, Big Buck Bunny, the PCM clip and tree 92 to 94. On the noisy 25 Mbps
re-encodes Auto's AV1 lifts noisy by 6.4 points and town and tree by 3.6 to 3.7, which costs time: those three take
15-43% longer. Everything else got 10-34% faster, most of it from x264 settings that do a third less work at the same
quality per byte.

## Starting before Compress

Once the size plan and the format are settled, Pare starts compressing while the settings are still on screen.
Clicking 15 seconds after the file loads, as someone reading the settings might:

| Video | Click to file, before | Now | Load to file, before | Now |
| --- | --- | --- | --- | --- |
| Camera footage, 10 s | 16.7 s | 5.6 s | 31.7 s | 20.6 s |
| Phone clips, 20 s | 42.7 s | 33.0 s | 57.8 s | 48.0 s |
| Big Buck Bunny, 10 s | 21.3 s | 15.9 s | 36.3 s | 30.9 s |

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

Park and ducks can't be halved at about 1:1 by x264 or SVT-AV1: their noise is the detail, and it takes more bits than
the source spends. Town and tree can, with AV1, and that's where Auto sends them.

## Speed in context

The first version of Pare ran ffmpeg.wasm: 105 s for the 20-second phone clips without any size target, and 27 s for
the camera footage. Now the phone clips take 43 s and the camera footage 17 s, halved and checked. A browser's own
encoder is faster still (1.1 to 2.7 times real time on this machine), but in software here it scored 93.4 VMAF NEG on
the camera footage at the same budget, against Pare's 97.7, and couldn't halve the phone clips at all.

## Reproducing

```sh
bun run build && bun x vite preview                               # the production build on :4173
OUT=/tmp/bench TAG=now node research/benchmark.mjs clip.mp4 ... > runs.jsonl
python3 research/score.py runs.jsonl > scored.jsonl               # native libvmaf, every frame
python3 research/report.py scored.jsonl old-tag new-tag           # the table above
```
