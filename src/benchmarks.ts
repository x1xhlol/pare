// Full compressions in the production build: visually lossless, at least 50% smaller, Compress clicked a second
// after the file loaded. Time runs from that click to the finished file. See research/RESEARCH.md for the clips.
export const BENCHMARK_SETUP =
  'Visually lossless, at least 50% smaller, in Chrome on a 4-core, 8-thread cloud machine with no GPU. Time runs from clicking Compress to the finished file, and SSIM is averaged over every frame.'

export const BENCHMARKS: { name: string; detail: string; before: number; after: number; seconds: number; ssim: number }[] = [
  { name: 'Camera footage', detail: '1080p30, 10 s, H.264 at 62 Mbps', before: 77_919_498, after: 23_886_802, seconds: 10, ssim: 0.9944 },
  { name: 'Phone clips', detail: '1080p50, 20 s, H.264 at 26 Mbps', before: 65_458_226, after: 30_155_812, seconds: 42, ssim: 0.9505 },
  { name: 'Animation', detail: 'Big Buck Bunny, 1080p30, 10 s', before: 30_704_510, after: 13_416_804, seconds: 25, ssim: 0.9825 },
  { name: 'Screen recording', detail: '1080p30, 8 s, scrolling text', before: 10_814_518, after: 3_493_238, seconds: 8, ssim: 0.9995 },
]
