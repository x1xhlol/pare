// node bench.mjs <clip.y4m> <options> [frames] [module.mjs] [out.264]
// Encodes raw I420 frames with the wasm x264 and reports encode speed. Writes Annex B output for comparison.
import fs from 'node:fs'

const [file, options = 'veryfast;;crf=18', maxFrames = '100', modulePath = './x264.mjs', outPath] = process.argv.slice(2)
const { default: createX264 } = await import(new URL(modulePath, import.meta.url).href)
const x = await createX264()

const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(512)
fs.readSync(fd, head, 0, 512, 0)
const headerEnd = head.indexOf(0x0a)
const header = head.subarray(0, headerEnd).toString()
const width = +header.match(/ W(\d+)/)[1]
const height = +header.match(/ H(\d+)/)[1]
const [fpsNum, fpsDen] = header.match(/ F(\d+):(\d+)/).slice(1).map(Number)
const frameBytes = (width * height * 3) / 2
const frameHeader = 6 // "FRAME\n"

const opts = x.stringToNewUTF8(options)
const enc = x._enc_open(width, height, fpsNum, fpsDen, 0x0002, opts)
if (!enc) throw new Error('enc_open failed: ' + options)

const out = []
const annexB = (ptr, size) => {
  // Replace 4-byte length prefixes with start codes.
  const bytes = x.HEAPU8.slice(ptr, ptr + size)
  for (let i = 0; i < bytes.length; ) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]
    bytes.set([0, 0, 0, 1], i)
    i += 4 + len
  }
  return bytes
}
const hs = x._enc_headers(enc)
out.push(annexB(x._enc_headers_ptr(enc), hs))

const frame = Buffer.alloc(frameBytes)
const planes = [0, 1, 2].map((i) => ({ ptr: x._enc_plane(enc, i), stride: x._enc_stride(enc, i) }))
let encodeMs = 0
let frames = 0
let offset = headerEnd + 1
for (; frames < +maxFrames; frames++) {
  if (fs.readSync(fd, frame, 0, frameBytes, offset + frameHeader) < frameBytes) break
  offset += frameHeader + frameBytes
  const t = performance.now()
  let src = 0
  for (const [i, { ptr, stride }] of planes.entries()) {
    const w = i === 0 ? width : width / 2
    const h = i === 0 ? height : height / 2
    for (let y = 0; y < h; y++, src += w) x.HEAPU8.set(frame.subarray(src, src + w), ptr + y * stride)
  }
  const size = x._enc_encode(enc, frames)
  encodeMs += performance.now() - t
  if (size > 0) out.push(annexB(x._enc_payload(enc), size))
}
const t = performance.now()
for (let size; (size = x._enc_flush(enc)) >= 0; ) if (size > 0) out.push(annexB(x._enc_payload(enc), size))
encodeMs += performance.now() - t
x._enc_close(enc)

const bytes = out.reduce((s, b) => s + b.length, 0)
console.log(JSON.stringify({ frames, fps: +(frames / (encodeMs / 1000)).toFixed(2), bytes, options }))
if (outPath) fs.writeFileSync(outPath, Buffer.concat(out))
