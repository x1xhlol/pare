import type { VideoSample } from 'mediabunny'

/*
 * Whether copyTo gives back a decoded frame's pixels. WebKit 26.6 doesn't always: for frames whose decoder rows are
 * wider than the picture (VP9 at 640 wide padded to 704, H.264 at 720 wide) it copies the padded rows as if they were
 * packed, and leaves the bottom rows unwritten, on VP9 and H.264 alike. Pare's direct input path takes frames through
 * copyTo, so the encoder got garbage (SSIM 0.01-0.02 against the source) while a canvas draw of the same frame was
 * right. Chrome and Firefox copy correctly.
 */

/** Bytes copyTo never writes: two copies into buffers filled differently beforehand disagree there. */
export async function unwritten(sample: VideoSample) {
  const size = sample.allocationSize()
  const a = new Uint8Array(size)
  const b = new Uint8Array(size).fill(255)
  await sample.copyTo(a)
  await sample.copyTo(b)
  let count = 0
  for (let i = 0; i < size; i++) if (a[i] !== b[i]) count++
  return count
}

/**
 * Whether copyTo gives this sample's pixels: every byte written, and its luma following a canvas draw of the frame in
 * each of 8 bands. A layout error decorrelates a band (r under 0.1 in WebKit); matrix, range and bit depth don't
 * (r over 0.97). Flat bands, and transparent pixels, are skipped; null when no band could be judged (a black or flat
 * frame), where only the unwritten bytes were checked. Takes 1-100 ms at 1080p, up to 0.7 s for a 10-bit frame.
 */
export async function readsBack(sample: VideoSample): Promise<boolean | null> {
  if (await unwritten(sample)) return false
  const data = new Uint8Array(sample.allocationSize())
  const [luma] = await sample.copyTo(data)
  const { width: w, height: h } = sample.visibleRect
  const context = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
  if (!context) return false
  context.drawImage(sample.toCanvasImageSource(), 0, 0, w, h)
  const rgb = context.getImageData(0, 0, w, h).data
  const deep = sample.format === 'I420P10' || sample.format === 'I420P12'
  const at = (x: number, row: number) => {
    const i = luma.offset + row * luma.stride + (deep ? 2 * x : x)
    return deep ? data[i] | (data[i + 1] << 8) : data[i]
  }
  let judged = 0
  for (let band = 0; band < 8; band++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
    for (let row = Math.floor((band * h) / 8); row < Math.floor(((band + 1) * h) / 8); row += 2)
      for (let x = 0; x < w; x += 2) {
        const i = (row * w + x) * 4
        // An alpha video's transparent pixels draw as nothing over its real luma.
        if (rgb[i + 3] < 255) continue
        const p = at(x, row)
        const q = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]
        n++
        sx += p
        sy += q
        sxx += p * p
        syy += q * q
        sxy += p * q
      }
    const vx = sxx - (sx * sx) / n
    const vy = syy - (sy * sy) / n
    if (!(vx > 1e-3 * n && vy > 1e-3 * n)) continue
    if ((sxy - (sx * sy) / n) / Math.sqrt(vx * vy) < 0.5) return false
    judged++
  }
  return judged ? true : null
}
