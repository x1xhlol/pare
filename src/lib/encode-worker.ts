/// <reference lib="webworker" />
// Encodes chunks of one video with x264 (WebAssembly SIMD). Frames come from the browser's decoder via
// Mediabunny and are copied straight into x264's input planes whenever the pixel format allows it.
import { BlobSource, Input, MATROSKA, MP4, QTFF, VideoSampleSink, WEBM, type VideoSample } from 'mediabunny'
import type createX264 from './x264/x264.mjs'
import type { X264Module } from './x264/x264.mjs'

export type WorkerInit = {
  type: 'init'
  module: WebAssembly.Module
  /** URL of the Emscripten glue for `module`. A threaded build starts its own workers from this same file. */
  script: string
  /** x264 frame threads; above 1 the module must be the threaded build. */
  threads: number
  file: File
  /** x264 options: "preset;tune;key=value;..." */
  options: string
  width: number
  height: number
  fpsNum: number
  fpsDen: number
}
export type WorkerChunk = {
  type: 'chunk'
  index: number
  start: number
  end: number
  /** Overrides the pool's x264 options for this chunk (used when testing several rate factors). */
  options?: string
}
/** Size of one output frame, the rate factor it was encoded at, and whether it opened its chunk (an IDR frame). */
export type FrameStat = { bytes: number; crf: number; first: boolean }
export type EncodedChunk = {
  index: number
  /** Milliseconds spent waiting for decoded frames, copying them in, and encoding. */
  timing: { decode: number; load: number; encode: number }
  /** Source timestamp of each input frame, by x264 pts. */
  times: number[]
  /** SSIM of each output frame against its input, as measured by x264 (luma). */
  packets: { data: Uint8Array<ArrayBuffer>; pts: number; key: boolean; ssim: number }[]
  headers: Uint8Array<ArrayBuffer>
}
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; index: number; fed: number; frames: number; stats: FrameStat[] }
  | { type: 'done'; chunk: EncodedChunk }
  | { type: 'error'; message: string }

const CSP_I420 = 0x0002
const CSP_NV12 = 0x0004

let x: X264Module
let init: WorkerInit
let sink: VideoSampleSink
let staging = 0
let stagingSize = 0
let enc = 0

const post = (message: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(message, transfer)

function scratch(size: number) {
  if (size > stagingSize) {
    if (staging) x._free(staging)
    staging = x._malloc(size)
    stagingSize = size
  }
  return staging
}

type Loader = (sample: VideoSample) => Promise<void>

/** Picks the cheapest way to get this sample's pixels into x264, and the colour space x264 should expect. */
function planInput(sample: VideoSample, enc: number): Loader {
  const { width, height } = init
  const heap = () => new Uint8Array(x.HEAPU8.buffer)
  const direct = sample.visibleRect.width === width && sample.visibleRect.height === height
  const plane = (i: number) => ({ offset: x._enc_plane(enc, i), stride: x._enc_stride(enc, i) })

  if (direct && sample.format === 'NV12')
    return async (s) => void (await s.copyTo(heap(), { layout: [plane(0), plane(1)] }))
  if (direct && (sample.format === 'I420' || sample.format === 'I420A'))
    return async (s) => {
      const layout = [plane(0), plane(1), plane(2)]
      if (s.format === 'I420A') layout.push({ offset: scratch(width * height), stride: width })
      await s.copyTo(heap(), { layout })
    }
  if (direct && (sample.format === 'I420P10' || sample.format === 'I420P12')) {
    const bits = sample.format === 'I420P10' ? 10 : 12
    return async (s) => {
      const size = s.allocationSize()
      const base = scratch(size)
      const layout = await s.copyTo(new Uint8Array(x.HEAPU8.buffer, base, size))
      const [ly, lu, lv] = layout
      x._enc_import_p16(enc, base + ly.offset, base + lu.offset, base + lv.offset,
        ly.stride / 2, lu.stride / 2, lv.stride / 2, width, height, bits)
    }
  }
  // Anything else (resizing, 4:2:2/4:4:4, RGB) goes through an RGB frame at the target size.
  return async (s) => {
    const resized = direct && (s.format === 'RGBA' || s.format === 'RGBX' || s.format === 'BGRA' || s.format === 'BGRX')
      ? s
      : await s.transform({ width, height, fit: 'fill' })
    try {
      const size = resized.allocationSize()
      const base = scratch(size)
      const [layout] = await resized.copyTo(new Uint8Array(x.HEAPU8.buffer, base, size))
      const bgr = resized.format === 'BGRA' || resized.format === 'BGRX' ? 1 : 0
      x._enc_import_rgba(enc, base + layout.offset, layout.stride, width, height, bgr)
    } finally {
      if (resized !== s) resized.close()
    }
  }
}

function cspFor(sample: VideoSample) {
  const direct = sample.visibleRect.width === init.width && sample.visibleRect.height === init.height
  return direct && (sample.format === 'I420' || sample.format === 'I420A') ? CSP_I420 : CSP_NV12
}

async function encodeChunk({ index, start, end, options: override }: WorkerChunk): Promise<EncodedChunk> {
  const times: number[] = []
  const packets: EncodedChunk['packets'] = []
  const stats: FrameStat[] = []
  const text = (override ?? init.options) + (init.threads > 1 ? `;threads=${init.threads}` : '')
  const crf = Number(/crf=([\d.]+)/.exec(text)?.[1] ?? 0)
  let load: Loader | null = null
  const collect = (size: number) => {
    if (size <= 0) return
    const ptr = x._enc_payload(enc)
    const pts = x._enc_out_pts(enc)
    packets.push({ data: x.HEAPU8.slice(ptr, ptr + size), pts, key: !!x._enc_out_keyframe(enc), ssim: x._enc_out_ssim(enc) })
    stats.push({ bytes: size, crf, first: pts === 0 })
  }
  const report = () => post({ type: 'progress', index, fed: times.length, frames: packets.length, stats: stats.splice(0) })

  const timing = { decode: 0, load: 0, encode: 0 }
  let mark = performance.now()
  try {
    // A small tolerance keeps float rounding from pulling in a neighbouring frame.
    for await (const sample of sink.samples(start, end)) {
      timing.decode += performance.now() - mark
      try {
        if (sample.timestamp < start - 1e-6 || sample.timestamp >= end - 1e-6) continue
        if (!enc) {
          const options = x.stringToNewUTF8(text)
          enc = x._enc_open(init.width, init.height, init.fpsNum, init.fpsDen, cspFor(sample), options)
          x._free(options)
          if (!enc) throw new Error(`x264 rejected the options "${text}".`)
          load = planInput(sample, enc)
        }
        let t = performance.now()
        await load!(sample)
        timing.load += performance.now() - t
        times.push(sample.timestamp)
        t = performance.now()
        collect(x._enc_encode(enc, times.length - 1))
        timing.encode += performance.now() - t
        // Report frames x264 has finished, not frames fed in: the lookahead buffers ~40 before any output.
        if (times.length % 8 === 0) report()
      } finally {
        sample.close()
        mark = performance.now()
      }
    }
    if (!enc) throw new Error(`No frames decoded between ${start.toFixed(3)} s and ${end.toFixed(3)} s.`)
    // The lookahead still holds up to 40 frames, which can be most of a short chunk: report them as they come out.
    for (let size, n = 1; ; n++) {
      const t = performance.now()
      size = x._enc_flush(enc)
      timing.encode += performance.now() - t
      if (size < 0) break
      collect(size)
      if (n % 4 === 0) report()
    }
    const headerSize = x._enc_headers(enc)
    const headersPtr = x._enc_headers_ptr(enc)
    report()
    return { index, times, packets, timing, headers: x.HEAPU8.slice(headersPtr, headersPtr + headerSize) }
  } finally {
    if (enc) x._enc_close(enc)
    enc = 0
  }
}

self.onmessage = async (event: MessageEvent<WorkerInit | WorkerChunk>) => {
  const message = event.data
  try {
    if (message.type === 'init') {
      init = message
      const { default: create }: { default: typeof createX264 } = await import(/* @vite-ignore */ message.script)
      x = await create({
        // The threaded build starts its thread workers up front: x264's threads plus its lookahead thread, and one
        // spare. A thread started later would deadlock, since this worker blocks while x264 waits on them.
        threads: message.threads > 1 ? message.threads + 2 : 0,
        instantiateWasm: (imports, done) => {
          void WebAssembly.instantiate(message.module, imports).then((instance) => done(instance, message.module))
          return {}
        },
      })
      const input = new Input({ source: new BlobSource(message.file), formats: [MP4, QTFF, WEBM, MATROSKA] })
      const track = await input.getPrimaryVideoTrack()
      if (!track) throw new Error('The file has no video track.')
      sink = new VideoSampleSink(track)
      post({ type: 'ready' })
    } else {
      const chunk = await encodeChunk(message)
      post({ type: 'done', chunk }, [chunk.headers.buffer, ...chunk.packets.map((p) => p.data.buffer)])
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
