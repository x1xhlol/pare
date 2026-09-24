export function lumaOf(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
  const { data } = ctx.getImageData(0, 0, width, height)
  const y = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < y.length; i++, p += 4) {
    y[i] = (77 * data[p] + 150 * data[p + 1] + 29 * data[p + 2] + 128) >> 8
  }
  return y
}

const C1 = (0.01 * 255) ** 2
const C2 = (0.03 * 255) ** 2

/** Mean SSIM over 8×8 windows with a stride of 4, on luma. */
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number) {
  const win = 8
  const stride = 4
  const n = win * win
  let total = 0
  let windows = 0
  for (let y = 0; y + win <= height; y += stride) {
    for (let x = 0; x + win <= width; x += stride) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
      for (let j = 0; j < win; j++) {
        let i = (y + j) * width + x
        for (let k = 0; k < win; k++, i++) {
          const va = a[i]
          const vb = b[i]
          sa += va
          sb += vb
          saa += va * va
          sbb += vb * vb
          sab += va * vb
        }
      }
      const ma = sa / n
      const mb = sb / n
      const va = saa / n - ma * ma
      const vb = sbb / n - mb * mb
      const cov = sab / n - ma * mb
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      windows++
    }
  }
  return total / windows
}

export function psnr(a: Uint8Array, b: Uint8Array) {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  const mse = sum / a.length
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}
