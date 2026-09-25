// Results of full compressions in the production build (visually lossless, at least 50% smaller).
// Regenerate with research/browser-ab.mjs; the machine is described in BENCHMARK_SETUP.
export const BENCHMARK_SETUP =
  'Visually lossless, at least 50% smaller. Chrome on a 4-core, 8-thread cloud machine with no GPU, time from clicking Compress to download.'

export const BENCHMARKS: { name: string; detail: string; before: number; after: number; seconds: number; ssim: number }[] = [
  { name: 'Action camera', detail: '1080p30, 10 s, H.264 60 Mbps', before: 75e6, after: 15e6, seconds: 31, ssim: 0.994 },
  { name: 'Phone clip', detail: '1080p50, 20 s, H.264 25 Mbps', before: 79e6, after: 31e6, seconds: 75, ssim: 0.943 },
  { name: 'Animation', detail: 'Big Buck Bunny, 1080p30, 30 s', before: 90e6, after: 36e6, seconds: 41, ssim: 0.98 },
]
