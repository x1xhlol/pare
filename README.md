# Pare

Video compression that runs entirely in the browser. Drop in a video and Pare:

1. Encodes a few short samples at different bitrates with the browser's own encoder (WebCodecs, via [Mediabunny](https://mediabunny.dev)) and scores each against the source with SSIM, searching for the lowest bitrate that meets the chosen quality target.
2. Encodes the full video at that bitrate.
3. Decodes matching frames from the original and the result, scores them, and shows them side by side.

| Quality | Luma SSIM target | Roughly like x264 |
| --- | --- | --- |
| Visually lossless | 0.985 | CRF 18 |
| High | 0.970 | CRF 23 |
| Compact | 0.950 | CRF 28 |
| Exact copy | bit-identical | remux, no re-encode |

The output bitrate is capped at 90% of the source's, so a file that's already efficiently compressed gets a warning instead of a bigger copy.

```sh
bun install
bun dev
```

Deployed with `vercel deploy --prod`.
