/// <reference lib="webworker" />
// Encodes chunks of one video with x264 (WebAssembly SIMD). Frames come from the browser's decoder via
// Mediabunny and are copied straight into x264's input planes whenever the pixel format allows it.
import {
  BlobSource, EncodedPacketSink, Input, MATROSKA, MP4, QTFF, VideoSampleSink, WEBM, type EncodedPacket, type InputVideoTrack,
  type VideoSample,
} from 'mediabunny'
import { decoderConfig } from './codec-config'
import type createVmaf from './vmaf/vmaf.mjs'
import type { VmafModule } from './vmaf/vmaf.mjs'
import type createX264 from './x264/x264.mjs'
import type { X264Module } from './x264/x264.mjs'

export type WorkerInit = {
  type: 'init'
  module: WebAssembly.Module
  /** URL of the Emscripten glue for `module`. A threaded build starts its own workers from this same file. */
  script: string
  /** x264 frame threads; above 1 the module must be the threaded build. */
  threads: number
  /** What the module encodes, for decoding test encodes back to score them. */
  codec: 'avc' | 'av1'
  /** The VMAF module, when chunks will be scored. */
  vmaf?: { module: WebAssembly.Module; script: string }
  file: File
  /** x264 options: "preset;tune;key=value;..." */
  options: string
  width: number
  height: number
  fpsNum: number
  fpsDen: number
  /**
   * Frames go in as decoded (the output keeps the source's colour tags and, for HDR in AV1, its 10 bits), rather than
   * through an RGB canvas (BT.709 SDR). Planned from the probe's decoded frame (copiesFrames).
   */
  direct: boolean
}
export type WorkerChunk = {
  type: 'chunk'
  index: number
  start: number
  end: number
  /** Overrides the pool's x264 options for this chunk (used when testing several rate factors). */
  options?: string
  /**
   * Score `count` frames from frame `from` with VMAF NEG against the source. The first only primes VMAF's motion
   * feature; the mean covers the rest.
   */
  score?: { from: number; count: number }
}
/** Asks the worker encoding chunk `index` to stop before the frame at `at`, so another worker can take the rest. */
export type WorkerSplit = { type: 'split'; index: number; at: number }
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
  /** VMAF NEG of a chunk that asked to be scored, after its 'done' (-1 if scoring failed). */
  | { type: 'scored'; index: number; vmaf: number }
  /** Whether the chunk now ends at `at`: it can't once that frame has gone into the encoder. */
  | { type: 'split'; index: number; at: number; ok: boolean }
  | { type: 'error'; message: string }

const CSP_I420 = 0x0002
const CSP_NV12 = 0x0004

let x: X264Module
let vmaf: Promise<VmafModule> | null = null
let init: WorkerInit
let sink: SkippingSink
let staging = 0
let stagingSize = 0
let enc = 0
/** The open encoder takes 10-bit samples (AV1 for an HDR source): its planes hold 16 bits per sample. */
let tenBit = false
/** The chunk being encoded: where it ends now, and the last frame that went into the encoder. */
let running: { index: number; end: number; fed: number } | null = null

const post = (message: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(message, transfer)

/** Bytes in each NAL unit's length prefix, from an H.264 decoder configuration record (avcC). */
function lengthSize(description: AllowSharedBufferSource) {
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description)
  return (bytes[4] & 3) + 1
}

/** Whether an H.264 frame is one no other frame refers to: its slices have nal_ref_idc 0. */
function disposable(data: Uint8Array, size: number) {
  for (let i = 0; i + size < data.length; ) {
    let length = 0
    for (let k = 0; k < size; k++) length = length * 256 + data[i + k]
    const header = data[i + size]
    const type = header & 0x1f
    if (type === 1 || type === 5) return (header & 0x60) === 0
    i += size + length
  }
  return false
}

/**
 * Decodes a range without the frames before it that nothing refers to. Each chunk's decoder starts at the source
 * keyframe before its first frame, which in an H.264 file with a keyframe every 250 frames (x264's default) can be
 * hundreds of frames earlier, and with B-frames about half of those are never referenced.
 */
class SkippingSink extends VideoSampleSink {
  skipBefore = -Infinity
  private readonly track: InputVideoTrack
  private readonly size: number

  /** `size`: the source's NAL length prefix size, or 0 when it isn't H.264 in that form (nothing is skipped). */
  constructor(track: InputVideoTrack, size: number) {
    super(track)
    this.track = track
    this.size = size
  }

  // Mediabunny's range decoding reads packets through this (internal) method; filtering them here keeps its
  // decoder handling, timestamps and rotation as they are.
  _createPacketSink() {
    const packets = new EncodedPacketSink(this.track)
    if (!this.size) return packets
    const { size } = this
    const before = this.skipBefore - 1e-6
    const all = packets.packets.bind(packets)
    packets.packets = async function* (...args: Parameters<EncodedPacketSink['packets']>) {
      for await (const packet of all(...args) as AsyncGenerator<EncodedPacket>)
        if (!(packet.type === 'delta' && packet.timestamp < before && disposable(packet.data, size))) yield packet
    }
    return packets
  }
}

function scratch(size: number) {
  if (size > stagingSize) {
    if (staging) x._free(staging)
    staging = x._malloc(size)
    stagingSize = size
  }
  return staging
}

type Loader = (sample: VideoSample) => Promise<void>
type Plane = { offset: number; stride: number }

/**
 * Safari won't copy a frame into a resizable buffer, which the threaded encoder's memory is ("Resizable ArrayBuffer is
 * not allowed"). Once it refuses, frames go through a plain buffer first: one more copy each.
 */
let bounce = false

/**
 * Copies a frame into the encoder's memory: planes at `layout` (offsets into the heap), or packed from `base` when
 * there's no layout. Returns the planes' layout relative to where they were written.
 */
async function copyFrame(frame: VideoSample, planes: Plane[] | null, base = 0, size = 0): Promise<PlaneLayout[]> {
  if (!bounce) {
    try {
      return planes
        ? await frame.copyTo(new Uint8Array(x.HEAPU8.buffer), { layout: planes })
        : await frame.copyTo(new Uint8Array(x.HEAPU8.buffer, base, size))
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
      bounce = true
    }
  }
  if (!planes) {
    const plain = new Uint8Array(size)
    const layout = await frame.copyTo(plain)
    x.HEAPU8.set(plain, base)
    return layout
  }
  // Each plane is written on its own: the gaps between them belong to other allocations.
  const start = Math.min(...planes.map((p) => p.offset))
  const rows = planes.map((_, i) => (i === 0 || i === 3 ? init.height : (init.height + 1) >> 1))
  const extent = Math.max(...planes.map((p, i) => p.offset - start + p.stride * rows[i]))
  const plain = new Uint8Array(extent)
  const layout = await frame.copyTo(plain, { layout: planes.map((p) => ({ offset: p.offset - start, stride: p.stride })) })
  planes.forEach((p, i) => x.HEAPU8.set(plain.subarray(p.offset - start, p.offset - start + p.stride * rows[i]), p.offset))
  return layout
}

/** Whether a sample is the size the encoder takes, as stored (before rotation). */
const fits = (sample: VideoSample) => sample.visibleRect.width === init.width && sample.visibleRect.height === init.height

/** Picks the cheapest way to get this sample's pixels into the encoder. */
function planInput(sample: VideoSample, enc: number): Loader {
  const { width, height } = init
  const plane = (i: number) => ({ offset: x._enc_plane(enc, i), stride: x._enc_stride(enc, i) })

  if (init.direct) {
    const deep = sample.format === 'I420P10' || sample.format === 'I420P12'
    // The output is tagged for frames like the probed one. One that decodes differently would be written wrong, in
    // colour or, into a 10-bit encoder, as noise.
    if (!fits(sample) || (tenBit && !deep) || !(deep || sample.format === 'NV12' || sample.format === 'I420' ||
        sample.format === 'I420A'))
      throw new Error(`The video decoded as ${sample.format ?? 'an unnamed format'} at ${sample.visibleRect.width}×` +
        `${sample.visibleRect.height}, not as planned.`)
    if (sample.format === 'NV12')
      return async (s) => void (await copyFrame(s, [plane(0), plane(1)]))
    if (sample.format === 'I420' || sample.format === 'I420A')
      return async (s) => {
        const layout = [plane(0), plane(1), plane(2)]
        if (s.format === 'I420A') layout.push({ offset: scratch(width * height), stride: width })
        await copyFrame(s, layout)
      }
    // A 10-bit encoder (AV1 for HDR sources) takes 10-bit frames as they are: its planes hold 16-bit samples.
    if (sample.format === 'I420P10' && tenBit)
      return async (s) => void (await copyFrame(s, [plane(0), plane(1), plane(2)]))
    const bits = sample.format === 'I420P10' ? 10 : 12
    return async (s) => {
      const size = s.allocationSize()
      const base = scratch(size)
      const layout = await copyFrame(s, null, base, size)
      const [ly, lu, lv] = layout
      x._enc_import_p16(enc, base + ly.offset, base + lu.offset, base + lv.offset,
        ly.stride / 2, lu.stride / 2, lv.stride / 2, width, height, bits)
    }
  }
  // Anything else (resizing, 4:2:2/4:4:4, formats WebCodecs doesn't name, RGB) goes through an RGB frame at the
  // target size, as stored: the container carries the rotation and flip, as the source's did. Drawn with them, a
  // portrait video would come out turned twice and squeezed into the stored frame's shape.
  return async (s) => {
    s.setRotation(0)
    s.setFlip(false)
    const resized = fits(s) && (s.format === 'RGBA' || s.format === 'RGBX' || s.format === 'BGRA' || s.format === 'BGRX')
      ? s
      : await s.transform({ width, height, fit: 'fill' })
    try {
      const size = resized.allocationSize()
      const base = scratch(size)
      const [layout] = await copyFrame(resized, null, base, size)
      const bgr = resized.format === 'BGRA' || resized.format === 'BGRX' ? 1 : 0
      x._enc_import_rgba(enc, base + layout.offset, layout.stride, width, height, bgr)
    } finally {
      if (resized !== s) resized.close()
    }
  }
}

function cspFor(sample: VideoSample, tenBit: boolean) {
  // A 10-bit encoder only takes planar input; x264's 10-to-8-bit import writes interleaved chroma.
  return tenBit || (init.direct && (sample.format === 'I420' || sample.format === 'I420A')) ? CSP_I420 : CSP_NV12
}

/** The luma plane the encoder is about to read, copied out tightly packed. */
function luma() {
  const { width, height } = init
  const offset = x._enc_plane(enc, 0)
  const stride = x._enc_stride(enc, 0)
  const out = new Uint8Array(width * height)
  if (tenBit) return to8(new Uint16Array(x.HEAPU8.buffer, offset, (stride / 2) * height), width, height, stride / 2)
  for (let y = 0; y < height; y++) out.set(x.HEAPU8.subarray(offset + y * stride, offset + y * stride + width), y * width)
  return out
}

/** 10-bit luma samples as 8-bit, for VMAF, which Pare runs on 8-bit frames. */
function to8(samples: Uint16Array, width: number, height: number, stride: number) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = Math.min(255, (samples[y * stride + x] + 2) >> 2)
  return out
}

/** Decodes a finished test encode and returns the luma of the wanted frames, by frame number. */
async function decodeLuma(chunk: EncodedChunk, wanted: Set<number>) {
  const { width, height } = init
  const frames: VideoFrame[] = []
  let failure: unknown = null
  const decoder = new VideoDecoder({
    output: (frame) => (wanted.has(Math.round(frame.timestamp)) ? frames.push(frame) : frame.close()),
    error: (err) => (failure = err),
  })
  decoder.configure(decoderConfig(init.codec, chunk.headers, width, height))
  // Frames only reference packets decoded before them, so decoding can stop at the last packet shown in range.
  const last = Math.max(...wanted)
  const through = chunk.packets.findLastIndex((p) => p.pts <= last)
  for (const p of chunk.packets.slice(0, through + 1))
    decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.pts, data: p.data }))
  await decoder.flush()
  decoder.close()
  if (failure) throw failure
  const out = new Map<number, Uint8Array>()
  for (const frame of frames) {
    try {
      const data = new Uint8Array(frame.allocationSize())
      const [plane] = await frame.copyTo(data)
      if (frame.format?.endsWith('P10')) {
        out.set(Math.round(frame.timestamp),
          to8(new Uint16Array(data.buffer, plane.offset, (data.byteLength - plane.offset) >> 1), width, height, plane.stride / 2))
        continue
      }
      const y = new Uint8Array(width * height)
      for (let row = 0; row < height; row++)
        y.set(data.subarray(plane.offset + row * plane.stride, plane.offset + row * plane.stride + width), row * width)
      out.set(Math.round(frame.timestamp), y)
    } finally {
      frame.close()
    }
  }
  return out
}

/** VMAF NEG of decoded frames against their sources, skipping the first pair, which only primes motion. */
async function scoreFrames(sources: Map<number, Uint8Array>, decoded: Map<number, Uint8Array>) {
  const v = await (vmaf ??= import(/* @vite-ignore */ init.vmaf!.script).then(({ default: create }: { default: typeof createVmaf }) =>
    create({
      instantiateWasm: (imports, done) => {
        void WebAssembly.instantiate(init.vmaf!.module, imports).then((instance) => done(instance, init.vmaf!.module))
        return {}
      },
    })))
  const scorer = v._score_open(init.width, init.height)
  try {
    const numbers = [...sources.keys()].sort((a, b) => a - b)
    for (const n of numbers) {
      const dist = decoded.get(n)
      if (!dist) throw new Error(`Frame ${n} of the test encode didn't decode.`)
      v.HEAPU8.set(sources.get(n)!, v._score_ref(scorer))
      v.HEAPU8.set(dist, v._score_dist(scorer))
      if (v._score_add(scorer)) throw new Error('VMAF rejected a frame.')
    }
    return v._score_finish(scorer, 1)
  } finally {
    v._score_close(scorer)
  }
}

/** Encodes a chunk, and when it asks to be scored, returns how to score it once the chunk has been handed over. */
async function encodeChunk({ index, start, end, options: override, score }: WorkerChunk):
  Promise<{ chunk: EncodedChunk; scoring?: () => Promise<number> }> {
  const chunk = (running = { index, end, fed: -Infinity })
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
  /** Source luma of the frames to score, by frame number. */
  const sources = new Map<number, Uint8Array>()

  const timing = { decode: 0, load: 0, encode: 0 }
  let mark = performance.now()
  try {
    // A small tolerance keeps float rounding from pulling in a neighbouring frame.
    sink.skipBefore = start
    for await (const sample of sink.samples(start, end)) {
      timing.decode += performance.now() - mark
      try {
        if (sample.timestamp >= chunk.end - 1e-6) break
        if (sample.timestamp < start - 1e-6) continue
        chunk.fed = sample.timestamp
        if (!enc) {
          const options = x.stringToNewUTF8(text)
          tenBit = /input-depth=10/.test(text)
          enc = x._enc_open(init.width, init.height, init.fpsNum, init.fpsDen, cspFor(sample, tenBit), options)
          x._free(options)
          if (!enc) throw new Error(`x264 rejected the options "${text}".`)
          load = planInput(sample, enc)
        }
        let t = performance.now()
        await load!(sample)
        timing.load += performance.now() - t
        if (score && times.length >= score.from && times.length < score.from + score.count) sources.set(times.length, luma())
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
    const encoded = { index, times, packets, timing, headers: x.HEAPU8.slice(headersPtr, headersPtr + headerSize) }
    if (!sources.size) return { chunk: encoded }
    // Handing the chunk over transfers its buffers, so scoring keeps its own copies.
    const kept = { ...encoded, headers: encoded.headers.slice(), packets: packets.map((p) => ({ ...p, data: p.data.slice() })) }
    return { chunk: encoded, scoring: async () => scoreFrames(sources, await decodeLuma(kept, new Set(sources.keys()))) }
  } finally {
    if (enc) x._enc_close(enc)
    enc = 0
    running = null
  }
}

self.onmessage = async (event: MessageEvent<WorkerInit | WorkerChunk | WorkerSplit>) => {
  const message = event.data
  try {
    if (message.type === 'split') {
      // Handled between frames, while the encode loop waits on the decoder.
      const ok = running?.index === message.index && message.at > running.fed + 1e-6 && message.at < running.end - 1e-6
      if (ok) running!.end = message.at
      post({ type: 'split', index: message.index, at: message.at, ok })
    } else if (message.type === 'init') {
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
      const config = await track.getDecoderConfig()
      const avcC = (await track.getCodec()) === 'avc' && config?.description
      sink = new SkippingSink(track, avcC ? lengthSize(avcC) : 0)
      post({ type: 'ready' })
    } else {
      const { chunk, scoring } = await encodeChunk(message)
      post({ type: 'done', chunk }, [chunk.headers.buffer, ...chunk.packets.map((p) => p.data.buffer)])
      // Scores come after: the size plan only needs the chunk, and a compression can start without the score.
      if (scoring) post({ type: 'scored', index: chunk.index, vmaf: await scoring().catch(() => -1) })
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
