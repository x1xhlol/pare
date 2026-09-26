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

RESULTS
