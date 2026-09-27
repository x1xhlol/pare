import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Choice, type Option } from './components/Choice'
import { Compare } from './components/Compare'
import { BENCHMARKS, BENCHMARK_SETUP } from './benchmarks'
import * as fmt from './lib/format'
import { dropPlace, placeLabel } from './lib/origin'
import type { Calibration, FramePair, Job, QualityReport } from './lib/media'
import type { Progress, SizePlan } from './lib/x264'
import {
  audioFor, CODEC_LABEL, codecName, copiesFrames, deepFormat, endOf, forEngine, frameAt, keepsHdr, MIN_PART, narrow, reachable,
  snapTrim, targetBytes, outputSize, type Engine, type OutputCodec, type Preset, type Probe, type Settings, type Trim,
} from './lib/shared'

const media = () => import('./lib/media')
const x264 = () => import('./lib/x264')
type X264Module = Awaited<ReturnType<typeof x264>>
/** The File Handling API's queue of files an installed app was opened with (Chromium only, not in TypeScript's DOM). */
type LaunchQueue = { setConsumer(consumer: (params: { files?: FileSystemFileHandle[] }) => void): void }

type Phase =
  | { kind: 'empty'; error?: string }
  | { kind: 'probing'; name: string }
  | { kind: 'ready'; probe: Probe; error?: string }
  | { kind: 'running'; probe: Probe; progress: Progress | null; status: string }
  | {
      kind: 'done'
      probe: Probe
      /** The part that was compressed: `probe` itself unless it was trimmed. */
      part: Probe
      blob: Blob
      url: string
      quality: QualityReport | 'pending' | 'failed'
      /** The format Pare's own encoders wrote, when they ran. */
      codec?: 'avc' | 'av1'
      /** The size target was on and the file still came out over it: the target, or null for half the original. */
      missed?: {
        target: number | null
        /** The copy is above 360p, the lowest Fit under steps down to: a lower resolution would get further. */
        lower: boolean
        /** H.264 because this browser can't play AV1, which would have got further. */
        noAv1: boolean
        /** The encoder, as the note names it: the browser's own when it did the work. */
        label: string
      }
      /** The short side Pare went down to because the size target was out of reach at the source's. */
      shortSide?: number
    }

/** `side`: planning again at that short side, the size target being out of reach at the source's. */
type Tuning = { round: number; side?: number } | { result: Calibration } | { error: string }
type HeadStart = {
  key: string
  job: Job
  codec: 'avc' | 'av1'
  shortSide?: number
  progress: Progress | null
  watch?: (p: Progress) => void
}
type CalibrationEntry = {
  promise: Promise<Calibration>
  controller: AbortController
  result?: Calibration
  /** A compression is waiting on this result, so leaving the settings screen mustn't cancel it. */
  needed?: boolean
  /**
   * Auto: H.264's plan, ready before AV1's test is, whether H.264 can reach the size target, and a way to stop the
   * test when the compression starts without it.
   */
  first?: Promise<Calibration & { reaches: boolean; predicted: boolean }>
  /** Whether a compression started before AV1's test ends may go ahead with H.264 (it's near 1:1 already). */
  quick?: Promise<boolean>
  skipTest?: () => void
}

/** Thorough runs Pare's own WebAssembly encoders: x264 for H.264, SVT-AV1 for AV1. */
const usesX264 = (s: Settings) => s.engine === 'thorough' && s.preset !== 'copy'
const thoroughCodec = (s: Settings): 'avc' | 'av1' => (s.codec === 'av1' ? 'av1' : 'avc')
const thoroughFormat = (s: Settings): ThoroughFormat => (s.autoCodec ? 'auto' : thoroughCodec(s))
const settingsKey = (s: Settings) =>
  `${s.preset}|${usesX264(s) ? `wasm-${thoroughFormat(s)}` : s.codec}|${s.shortSide}|${s.keepAudio}|${s.sizeTarget}|${s.targetBytes ?? ''}` +
  (s.trim ? `|${s.trim.start}-${s.trim.end}` : '')
const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'ConversionCanceledError')

// The landing page is rendered to HTML at build time, where there is no window: render it as supported, and let the
// rare browser without WebCodecs swap in its message on hydration.
const supported = typeof window === 'undefined' || ('VideoEncoder' in window && 'VideoDecoder' in window)

export const REPO = 'https://github.com/x1xhlol/pare'

const PRESETS: { value: Preset; label: string; hint: string }[] = [
  {
    value: 'visually-lossless',
    label: 'Visually lossless',
    hint: 'Looks the same as the original at any normal viewing size. Every result is checked frame by frame.',
  },
  { value: 'high', label: 'High', hint: 'Smaller. Differences only show up when you pause and zoom in.' },
  { value: 'compact', label: 'Compact', hint: 'Smallest. Fine texture softens, which suits chats and uploads.' },
  {
    value: 'copy',
    label: 'Exact copy',
    hint: 'Repackages the original streams without re-encoding, so every frame is bit-identical. It only saves space when the container itself is wasteful.',
  },
]

type SizeMode = 'half' | 'fit' | 'any'

const SIZE_OPTIONS: Option<SizeMode>[] = [
  { value: 'half', label: 'At least 50% smaller' },
  { value: 'fit', label: 'Fit under' },
  { value: 'any', label: 'No limit' },
]

/** Fit under with Pare's own encoders from the original resolution, which step the resolution down too (fitSide). */
const FIT_HINT_LOWERS = 'Keeps the chosen quality when that already fits. If it doesn’t, compression is raised just enough to get under the size, and if even that isn’t enough, the resolution is lowered too, down to 360p.'

const SIZE_HINT: Record<SizeMode, string> = {
  half: 'Keeps the chosen quality when that already halves the file. If it doesn’t, compression is raised just enough to get there, and the quality check shows how close it stayed.',
  fit: 'Keeps the chosen quality when that already fits. If it doesn’t, compression is raised just enough to get under the size.',
  any: 'Always encodes at the chosen quality, even if the file barely shrinks.',
}

/** Common upload limits, in MB: Discord's free tier, email attachments, and two larger ones. */
const FIT_PRESETS = [10, 25, 50, 100]

/** Where "Fit under" starts: 10 MB, or a quarter of a smaller file (1 MB for files of 2-4 MB), rounded. */
const defaultFit = (size: number) =>
  size > 20e6 ? 10e6
    : size > 4e6 ? Math.round(size / 4 / 1e5) * 1e5
    : size > 2e6 ? 1e6
    : Math.round(Number((size / 4 / 1e6).toPrecision(2)) * 1e6)

/** Phones record where a video was taken. Left out by default, since a compressed copy is often one to share. */
const placeHint = (place: string, keep: boolean, dated: boolean) => {
  const where = placeLabel(place)
  return keep
    ? `The copy says it was recorded at ${where ?? 'the same place'}, as the original does.`
    : `The original says where it was recorded${where ? ` (${where})` : ''}. The copy leaves that out${dated ? ' and keeps the recording date' : ''}.`
}

const ENGINES: Option<Engine>[] = [
  { value: 'thorough', label: 'Thorough' },
  { value: 'fast', label: 'Fast' },
]

const ENGINE_HINT: Record<Engine, string> = {
  thorough:
    'Encoders compiled to WebAssembly, running on every CPU core: x264, the one inside HandBrake and ffmpeg, or SVT-AV1. The smallest files for the quality.',
  fast: "Your browser's built-in encoder, often hardware-accelerated. Several times quicker, but files come out larger at the same quality.",
}

const CODEC_HINT: Record<OutputCodec, string> = {
  avc: 'Plays everywhere.',
  hevc: 'About 40% smaller than H.264. Plays on Apple devices, Windows, and Chrome.',
  av1: 'Smallest files, slowest to encode. Plays in current browsers and newer phones.',
}

type ThoroughFormat = 'auto' | 'avc' | 'av1'

const THOROUGH_CODECS: Option<ThoroughFormat>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'avc', label: 'H.264' },
  { value: 'av1', label: 'AV1' },
]

const THOROUGH_CODEC_HINT = {
  auto: 'Test-encodes this video and measures the results with VMAF, in this browser. AV1 when it looks better at this size and this device plays it, otherwise H.264: faster, and plays everywhere.',
  avc: 'x264. Plays everywhere.',
  av1: 'SVT-AV1. About 30% smaller than H.264 at the same quality on most footage, and about half as fast. Plays in current Chrome, Edge and Firefox, on Android, and on Apple devices with AV1 hardware (iPhone 15 Pro, M3 Macs and later).',
}

function firstEncodable(probe: Probe): OutputCodec {
  return (['avc', 'hevc', 'av1'] as const).find((c) => probe.encodable[c]) ?? 'avc'
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'empty' })
  const [settings, setSettings] = useState<Settings>({
    preset: 'visually-lossless',
    engine: 'thorough',
    codec: 'avc',
    autoCodec: true,
    shortSide: null,
    keepAudio: true,
    sizeTarget: true,
    keepPlace: false,
  })
  const [tuning, setTuning] = useState<(Tuning & { key: string }) | null>(null)
  const calibrations = useRef(new Map<string, CalibrationEntry>())
  const currentKey = useRef('')
  const cancelRun = useRef<(() => void) | null>(null)
  /**
   * A compression started in the background as soon as the plan settled, for the settings on screen: Compress picks
   * it up where it got to. Any change of settings or file drops it, and each settings key gets one per file.
   */
  const headStart = useRef<HeadStart | null>(null)
  const headStarted = useRef(new Set<string>())
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Fetch the encoder bundle once the page has painted, before anyone picks a file.
    const id = setTimeout(() => void media(), 300)
    return () => clearTimeout(id)
  }, [])

  const probe = phase.kind === 'ready' || phase.kind === 'running' || phase.kind === 'done' ? phase.probe : null

  const phaseKind = useRef(phase.kind)
  phaseKind.current = phase.kind
  const open = useCallback(async (file: File) => {
    setPhase({ kind: 'probing', name: file.name })
    // Someone opening a video will want the encoders: the service worker keeps them for next time, and offline.
    navigator.serviceWorker?.controller?.postMessage('warm')
    headStart.current?.job.cancel()
    headStart.current = null
    headStarted.current.clear()
    for (const entry of calibrations.current.values()) entry.controller.abort()
    calibrations.current.clear()
    setTuning(null)
    try {
      const probe = await (await media()).probeFile(file)
      if (!probe.canDecode) {
        const codec = probe.videoCodec ? CODEC_LABEL[probe.videoCodec] ?? probe.videoCodec : 'this codec'
        throw new Error(`This browser can’t decode ${codec} video. Try Chrome or Edge.`)
      }
      // The browser's own encoders need browser support; Pare's WebAssembly ones work everywhere.
      setSettings((s) => ({
        ...s,
        codec: s.engine === 'thorough' || probe.encodable[s.codec] ? s.codec : firstEncodable(probe),
        shortSide: null,
        // A part of the last video means nothing for this one.
        trim: null,
        // A Fit under size carried over from a bigger file starts again from this one's.
        targetBytes: s.targetBytes && s.targetBytes >= probe.file.size ? defaultFit(probe.file.size) : s.targetBytes,
        // Where a video was recorded is kept only when asked, for that video.
        keepPlace: false,
      }))
      setPhase({ kind: 'ready', probe })
    } catch (err) {
      setPhase({ kind: 'empty', error: `Couldn’t open ${file.name}. ${message(err)}` })
    }
  }, [])

  // A video shared to the installed app (the manifest's share_target), which the service worker holds for the page, or
  // one opened with it from the desktop (file_handlers).
  useEffect(() => {
    if (new URLSearchParams(location.search).has('shared') && 'caches' in window) {
      history.replaceState(null, '', '/')
      void (async () => {
        const cache = await caches.open('pare-shared')
        const response = await cache.match('/shared')
        if (!response) return
        await cache.delete('/shared')
        const name = decodeURIComponent(response.headers.get('x-name') ?? 'Shared video')
        void open(new File([await response.blob()], name, { type: response.headers.get('content-type') ?? '' }))
      })()
    }
    // A launch into a window that's compressing leaves it be, as a drop there does. (Without a launch_handler Chrome
    // usually opens a new window, and a share could be lost to one that focuses an existing window instead.)
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue
    queue?.setConsumer(async ({ files }) => {
      const handle = files?.[0]
      if (handle && !['running', 'probing'].includes(phaseKind.current)) void open(await handle.getFile())
    })
  }, [open])

  const resultUrl = phase.kind === 'done' ? phase.url : null
  const report = phase.kind === 'done' && typeof phase.quality === 'object' ? phase.quality : null

  useEffect(() => {
    if (!resultUrl) return
    return () => URL.revokeObjectURL(resultUrl)
  }, [resultUrl])

  useEffect(() => {
    if (!report) return
    return () => {
      for (const f of report.frames) {
        f.original.close()
        f.compressed.close()
      }
    }
  }, [report])

  useEffect(() => {
    const poster = probe?.poster
    return () => {
      if (poster) URL.revokeObjectURL(poster)
    }
  }, [probe?.poster])

  const key = settingsKey(settings)

  const ensureCalibration = (whole: Probe, chosen: Settings) => {
    const key = settingsKey(chosen)
    // Everything planned here is for the part being compressed.
    const probe = narrow(whole, chosen)
    const settings = forEngine(probe, chosen)
    const existing = calibrations.current.get(key)
    if (existing) return existing
    const controller = new AbortController()
    const onRound = (round: number) => {
      if (currentKey.current === key) setTuning({ key, round })
    }
    const fromPlan = ({ size, crf, raised, fitted, slope, points, reuse, fast, long }: SizePlan): Calibration =>
      ({ bitrate: 0, size, ssim: 0, target: 0, reached: true, crf, raised, fitted, slope, points, reuse, fast, long })
    // A size target out of reach at the source's resolution even at the highest rate factor plans again smaller, down
    // to 360p, rather than encode a file that misses it. Only from Original: a resolution picked by hand stays.
    const shrink = async <T,>(m: X264Module, result: T, of: (r: T) => [SizePlan, 'avc' | 'av1'],
                              again: (s: Settings) => Promise<T>) => {
      let sized = settings
      for (let side = settings.shortSide === null ? m.fitSide(probe, sized, ...of(result)) : null; side !== null;
           side = m.fitSide(probe, sized, ...of(result))) {
        sized = { ...sized, shortSide: side }
        if (currentKey.current === key) setTuning({ key, round: 0, side })
        result = await again(sized)
      }
      return { result, shortSide: sized === settings ? undefined : sized.shortSide ?? undefined }
    }
    // Auto tests AV1 while the settings are on screen. Starting before the test ends goes ahead with H.264 when it
    // meets the size target, so a quick start doesn't wait for a test that rarely changes the answer.
    const test = new AbortController()
    controller.signal.addEventListener('abort', () => test.abort())
    const first = usesX264(settings) && settings.autoCodec
      ? x264().then(async (m) => ({ m, avc: await m.planAvc(probe, settings, controller.signal) }))
      : null
    const entry: CalibrationEntry = {
      controller,
      first: first?.then(({ m, avc }) => ({ ...fromPlan(avc), codec: 'avc' as const, reaches: m.avcReaches(probe, settings, avc),
        predicted: !!avc.av1Plan })),
      quick: first?.then(({ m, avc }) => m.quickStart(probe, settings, avc)),
      // Stops H.264's scoring as well as AV1's test: neither may compete with the encode for the cores.
      skipTest: () => controller.abort(),
      promise: first
        ? first.then(async ({ m, avc }) => {
            await avc.scored
            if (m.testsAv1(probe, settings, avc) && currentKey.current === key && !entry.result)
              setTuning({ key, result: { ...fromPlan(avc), codec: 'avc', choice: { reason: 'testing' } } })
            const { result: { codec, plan, reason, vmaf }, shortSide } = await shrink(m,
              await m.settle(probe, settings, avc, test.signal), (c) => [c.plan, c.codec],
              async (s) => m.settle(probe, s, await m.planAvc(probe, s, controller.signal), test.signal))
            const reached = !m.misses(probe, { ...settings, shortSide: shortSide ?? settings.shortSide }, plan, codec)
            return { ...fromPlan(plan), codec, choice: { reason, vmaf }, shortSide, reached }
          })
        : usesX264(settings)
          ? x264().then(async (m) => {
              const { result, shortSide } = await shrink(m, await m.plan(probe, settings, controller.signal),
                (p) => [p, thoroughCodec(settings)], (s) => m.plan(probe, s, controller.signal))
              const sized = { ...settings, shortSide: shortSide ?? settings.shortSide }
              return { ...fromPlan(result), shortSide, reached: !m.misses(probe, sized, result, thoroughCodec(settings)) }
            })
          : media().then((m) => m.calibrate(probe, settings, controller.signal, onRound)),
    }
    entry.promise.then(
      (result) => {
        entry.result = result
        if (currentKey.current === key) setTuning({ key, result })
      },
      (err) => {
        calibrations.current.delete(key)
        if (controller.signal.aborted || isAbort(err)) return
        if (currentKey.current === key) setTuning({ key, error: message(err) })
      },
    )
    // Nothing may be waiting on the early plan when it's canceled; the full promise reports the failure.
    entry.first?.catch(() => {})
    entry.quick?.catch(() => {})
    calibrations.current.set(key, entry)
    return entry
  }

  // Tune the bitrate for the current settings while the user is still choosing. Results are cached per setting.
  // Leaving the settings screen cancels unfinished tests (x264 encodes don't wait for them) and returning restarts them.
  const choosing = phase.kind === 'ready'
  useEffect(() => {
    if (!probe || !choosing) return
    currentKey.current = key
    const map = calibrations.current
    const cached = map.get(key)
    if (cached?.result) {
      setTuning({ key, result: cached.result })
      return
    }
    setTuning({ key, round: 0 })
    const timer = setTimeout(() => ensureCalibration(probe, settings), cached ? 0 : 250)
    return () => {
      clearTimeout(timer)
      const entry = map.get(key)
      if (entry && !entry.result && !entry.needed) {
        entry.controller.abort()
        map.delete(key)
      }
    }
    // `key` captures every setting that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe, key, choosing])

  // Start compressing once the plan has settled, while the settings are still on screen.
  const settled = tuning && tuning.key === key && 'result' in tuning && tuning.result.choice?.reason !== 'testing'
    ? tuning.result
    : null
  useEffect(() => {
    if (headStart.current && headStart.current.key !== key) {
      headStart.current.job.cancel()
      // Coming back to these settings (a part tried and undone) may start it again.
      headStarted.current.delete(headStart.current.key)
      headStart.current = null
    }
    if (phase.kind !== 'ready' || !probe || !usesX264(settings) || !settled || headStarted.current.has(key)) return
    headStarted.current.add(key)
    let dropped = false
    void x264().then((engine) => {
      if (dropped) return
      const codec = settings.autoCodec ? settled.codec ?? 'avc' : thoroughCodec(settings)
      const start = { crf: settled.crf, slope: settled.slope, points: settled.points,
        reuse: codec === 'avc' ? settled.reuse : undefined, fast: codec === 'avc' && settled.fast, long: settled.long }
      const spec: HeadStart = { key, codec, shortSide: settled.shortSide, progress: null, job: null as unknown as Job }
      const part = narrow(probe, settings)
      const sized = { ...forEngine(part, settings), codec, shortSide: settled.shortSide ?? settings.shortSide }
      spec.job = engine.encode(part, sized, start, (p) => {
        spec.progress = p
        spec.watch?.(p)
      })
      spec.job.promise.catch(() => {})
      headStart.current = spec
    })
    return () => {
      dropped = true
    }
    // `key` captures every setting that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, probe, key, settled])

  useEffect(() => {
    if (phase.kind !== 'running') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase.kind])

  const start = async () => {
    if (phase.kind !== 'ready') return
    const { probe } = phase
    const run: { canceled: boolean; job: Job | null } = { canceled: false, job: null }
    const adopted = headStart.current?.key === settingsKey(settings) ? headStart.current : null
    headStart.current = null
    headStarted.current.add(settingsKey(settings))
    cancelRun.current = () => {
      run.canceled = true
      if (run.job) run.job.cancel()
      else setPhase({ kind: 'ready', probe })
    }
    // The encoders get the part being compressed; the phases keep the whole video, to go back to.
    const part = narrow(probe, settings)
    // With the size target, x264 starts from the size plan's rate factor and steers from there while it encodes.
    // Without it there is nothing to plan, and the browser's encoders need their tuned bitrate up front.
    const engine = forEngine(part, settings)
    const planned = usesX264(settings) && engine.sizeTarget && !adopted
    const waitFor = !adopted && (!usesX264(settings) || planned) ? ensureCalibration(probe, settings) : null
    if (waitFor) waitFor.needed = true
    setPhase({
      kind: 'running',
      probe,
      progress: adopted?.progress ?? null,
      status: adopted
        ? 'Encoding…'
        : !usesX264(settings)
        ? 'Finishing tuning…'
        : waitFor && !waitFor.result
          ? 'Finishing size tests…'
          : 'Starting encoders…',
    })
    const onProgress = (progress: Progress) => setPhase((p) => (p.kind === 'running' ? { ...p, progress } : p))
    let codec: 'avc' | 'av1' | undefined
    let shortSide: number | undefined
    try {
      if (adopted) {
        adopted.watch = onProgress
        run.job = adopted.job
        codec = adopted.codec
        shortSide = adopted.shortSide
      } else if (usesX264(settings)) {
        const x264Engine = await x264()
        let plan: Calibration | undefined
        if (waitFor?.first && !waitFor.result) {
          const first = await waitFor.first.catch(() => undefined)
          const quick = first?.reaches && (await waitFor.quick?.catch(() => false))
          if (quick && first && !waitFor.result) {
            waitFor.skipTest?.()
            plan = first
          } else if (!waitFor.result) {
            const why = first?.reaches
              ? 'H.264 isn’t near 1:1 at this size'
              : `H.264 can’t get ${settings.targetBytes ? `under ${fmt.bytes(settings.targetBytes)}` : 'to half the size'}`
            const status = first?.predicted ? 'Planning AV1: H.264 is near its limit here…' : `Testing AV1: ${why}…`
            setPhase((p) => (p.kind === 'running' ? { ...p, status } : p))
          }
        }
        plan ??= waitFor ? await waitFor.promise.catch(() => undefined) : undefined
        if (run.canceled) return
        setPhase((p) => (p.kind === 'running' ? { ...p, status: 'Starting encoders…' } : p))
        // Auto without a size target has nothing to compare, and only an HDR video it keeps in 10 bits goes to AV1.
        codec = settings.autoCodec ? plan?.codec ?? (keepsHdr(probe) ? 'av1' : 'avc') : thoroughCodec(settings)
        shortSide = plan?.shortSide
        run.job = x264Engine.encode(part, { ...engine, codec, shortSide: shortSide ?? engine.shortSide },
          { crf: plan?.crf, slope: plan?.slope, points: plan?.points, reuse: codec === 'avc' ? plan?.reuse : undefined,
            fast: codec === 'avc' && plan?.fast, long: plan?.long }, onProgress)
      } else {
        const { bitrate } = await ensureCalibration(probe, settings).promise
        if (run.canceled) return
        run.job = (await media()).compress(part, engine, bitrate, onProgress)
      }
      const { measureQuality } = await media()
      const { blob: made, scores } = await run.job.promise
      const blob = settings.keepPlace ? made : await dropPlace(made)
      const url = URL.createObjectURL(blob)
      const reason = calibrations.current.get(settingsKey(settings))?.result?.choice?.reason
      const missed = engine.sizeTarget && settings.preset !== 'copy' && blob.size > targetBytes(part, settings)
        ? { target: settings.targetBytes ?? null,
            lower: Math.min(probe.width, probe.height, shortSide ?? engine.shortSide ?? Infinity) > 360,
            noAv1: codec === 'avc' && reason === 'device',
            label: codec ? (codec === 'av1' ? 'AV1' : 'H.264') : `The browser’s ${CODEC_LABEL[engine.codec]} encoder` }
        : undefined
      setPhase({ kind: 'done', probe, part, blob, url, quality: settings.preset === 'copy' ? 'failed' : 'pending', codec,
        missed, shortSide })
      if (settings.preset === 'copy') return
      // A resolution Pare chose itself is judged at the original's size.
      const quality = await measureQuality(part, blob, scores, 8, !!shortSide).catch((err) => {
        console.warn(`[pare] quality check failed: ${message(err)}`)
        return 'failed' as const
      })
      setPhase((p) => (p.kind === 'done' && p.blob === blob ? { ...p, quality } : p))
    } catch (err) {
      if (run.canceled) {
        if (run.job) setPhase({ kind: 'ready', probe })
        return
      }
      setPhase({ kind: 'ready', probe, error: isAbort(err) ? undefined : `Compression failed. ${message(err)}` })
    } finally {
      cancelRun.current = null
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && (phase.kind === 'empty' || phase.kind === 'ready' || phase.kind === 'done')) void open(file)
  }

  // The first screen appears without motion; later views fade in because the user caused them.
  const view = phase.kind === 'probing' ? 'empty' : phase.kind
  // Each view replaces the last, taking the focused control with it: focus moves to the new view's heading (or the view)
  // instead of the page.
  const main = useRef<HTMLElement>(null)
  const shownView = useRef(view)
  useEffect(() => {
    if (shownView.current === view) return
    shownView.current = view
    const heading = main.current?.querySelector<HTMLElement>('h1[tabindex]')
    ;(heading ?? main.current)?.focus()
  }, [view])
  // Said once per change, from a region that stays on the page.
  const announcement = phase.kind === 'running'
    ? 'Compressing.'
    : phase.kind === 'done'
      ? phase.part.trim
        ? `Done: ${fmt.clock(phase.part.duration)} of ${fmt.duration(phase.probe.duration)}, about ${fmt.bytes(phase.part.bytes)} ` +
          `in the original, to ${fmt.bytes(phase.blob.size)}, ${fmt.change(phase.part.bytes, phase.blob.size)}.`
        : `Done: ${fmt.bytes(phase.probe.file.size)} to ${fmt.bytes(phase.blob.size)}, ${fmt.change(phase.probe.file.size, phase.blob.size)}.`
      : ''

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <header className="header">
        <a className="wordmark" href="/">
          Pare
        </a>
        <p className="header-note">
          <span className="header-private">Runs on your device. Nothing is uploaded.</span>
          <a className="link" href={REPO}>
            Source
          </a>
        </p>
      </header>

      <input
        ref={picker}
        type="file"
        accept="video/*,.mkv,.mov,.webm,.mp4,.m4v"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void open(file)
        }}
      />

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <main className="main" key={view} ref={main} tabIndex={-1} data-enter={view !== 'empty' || undefined}>
        {!supported ? (
          <Unsupported />
        ) : phase.kind === 'empty' || phase.kind === 'probing' ? (
          <Empty
            dragging={dragging}
            probing={phase.kind === 'probing' ? phase.name : null}
            error={phase.kind === 'empty' ? phase.error : undefined}
            onPick={() => picker.current?.click()}
          />
        ) : phase.kind === 'ready' ? (
          <Ready
            probe={phase.probe}
            settings={settings}
            setSettings={setSettings}
            tuning={tuning?.key === key ? tuning : null}
            error={phase.error}
            onStart={start}
            onReplace={() => picker.current?.click()}
          />
        ) : phase.kind === 'running' ? (
          <Running
            probe={phase.probe}
            duration={narrow(phase.probe, settings).duration}
            progress={phase.progress}
            status={phase.status}
            target={settings.sizeTarget ? settings.targetBytes : null}
            onCancel={() => cancelRun.current?.()}
          />
        ) : (
          <Done
            phase={phase}
            copy={settings.preset === 'copy'}
            onAdjust={() => setPhase({ kind: 'ready', probe: phase.probe })}
            onNew={() => picker.current?.click()}
          />
        )}
      </main>

      <footer className="footer">
        <p>
          Pare runs x264, SVT-AV1 and VMAF compiled to WebAssembly, in this tab. It's free software under the GPL, version 2
          or later.
        </p>
        <nav className="footer-links" aria-label="Project">
          <a className="link" href={REPO}>
            Source
          </a>
          <a className="link" href={`${REPO}/blob/main/research/RESEARCH.md`}>
            Research notes
          </a>
          <a className="link" href={`${REPO}/blob/main/LICENSE`}>
            License
          </a>
        </nav>
      </footer>
    </div>
  )
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function Unsupported() {
  return (
    <section className="panel empty">
      <h1 className="display">This browser can’t encode video.</h1>
      <p className="lede">Pare uses the WebCodecs API. Open it in a current Chrome, Edge, Safari (17+), or Firefox (130+).</p>
    </section>
  )
}

function Empty(props: { dragging: boolean; probing: string | null; error?: string; onPick: () => void }) {
  return (
    <section className="stack intro">
      <div className="intro-head">
        <h1 className="display" tabIndex={-1}>Make a video smaller without making it worse.</h1>
        <p className="lede">
          Pare cuts a video to half its size or less and keeps it looking like the original. It encodes across your
          computer’s cores, in this tab, and the file never leaves your device.
        </p>
      </div>
      <div className="drop" data-active={props.dragging || undefined} onClick={props.onPick}>
        <svg className="drop-icon" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
          <path d="M14 4v13m0 0-5-5m5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 17v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        <p className="drop-title">{props.probing ? (
            `Reading ${props.probing}…`
          ) : (
            <>
              <span className="fine-pointer">Drop a video anywhere on the page</span>
              <span className="coarse-pointer">Pick a video from your device</span>
            </>
          )}</p>
        <button
          type="button"
          className="button primary"
          disabled={!!props.probing}
          onClick={(e) => {
            e.stopPropagation()
            props.onPick()
          }}
        >
          Choose a video
        </button>
        <p className="muted">MP4, MOV, WebM, or MKV with H.264, HEVC, VP9, or AV1 video.</p>
      </div>
      {props.error && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
      <Benchmarks />
      <HowItWorks />
    </section>
  )
}

function Benchmarks() {
  return (
    <section className="section" aria-labelledby="benchmarks">
      <div className="section-head">
        <h2 id="benchmarks">Measured on four videos</h2>
        <p className="note">{BENCHMARK_SETUP}</p>
      </div>
      <div className="table-scroll">
        <table className="bench">
          <thead>
            <tr>
              <th scope="col">Video</th>
              <th scope="col" className="num">
                Original
              </th>
              <th scope="col" className="num">
                Pare
              </th>
              <th scope="col" className="num">
                Time
              </th>
              <th scope="col" className="num">
                <abbr title="Structural similarity, from 0 to 1, averaged over every frame">SSIM</abbr>
              </th>
            </tr>
          </thead>
          <tbody>
            {BENCHMARKS.map((b) => (
              <tr key={b.name}>
                <th scope="row">
                  <span className="bench-name">{b.name}</span>
                  <span className="bench-detail">{b.detail}</span>
                </th>
                <td className="num" data-label="Original">
                  {fmt.bytes(b.before)}
                </td>
                <td className="num" data-label="Pare">
                  {fmt.bytes(b.after)} <span className="delta">{fmt.change(b.before, b.after)}</span>
                </td>
                <td className="num" data-label="Time">
                  {b.seconds} s
                </td>
                <td className="num" data-label="SSIM">
                  {b.ssim.toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const STEPS = [
  {
    title: 'Decoded by your browser',
    body: 'WebCodecs decodes the video, on the GPU when there is one, and frames are copied straight into the encoder’s memory.',
  },
  {
    title: 'x264, rebuilt for the web',
    body: 'x264’s speed comes from hand-written x86 and ARM assembly, which a browser can’t run. Pare replaces it with about 1,500 lines of WebAssembly SIMD, bit-exact with x264’s own code and about twice as fast.',
  },
  {
    title: 'Every core busy',
    body: 'The video is split into chunks of equal work, one per encoder, and the encoding starts while you’re still looking at the settings. Short videos get fewer, longer chunks with more threads each, since every chunk begins with a costly keyframe. A chunk that turns out slow hands its last frames to whichever encoder will be free first.',
  },
  {
    title: 'Held to half the size',
    body: 'Short test encodes measure how size falls as quality drops, and each chunk gets its setting from what the finished ones really cost. The file is weighed at the end, and if it isn’t at least 50% smaller, the busiest chunks are encoded again. A video with room to spare gets an x264 preset that does half the work, kept only if VMAF still scores it visually identical.',
  },
  {
    title: 'H.264 or AV1, by measuring',
    body: 'Netflix’s VMAF, compiled to WebAssembly too, scores the test encodes. AV1 is used when it looks better at the target size and your device plays it, or when H.264’s test already shows noise it can’t keep. Otherwise it’s H.264, which is faster and plays everywhere.',
  },
  {
    title: 'Checked frame by frame',
    body: 'Every frame is scored against the source. The result screen puts the weakest frames next to the original so you can judge for yourself.',
  },
]

function HowItWorks() {
  return (
    <section className="section" aria-labelledby="how">
      <div className="section-head">
        <h2 id="how">How it works</h2>
      </div>
      <ol className="steps">
        {STEPS.map((s) => (
          <li key={s.title}>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="section-foot">
        <a className="link" href={`${REPO}/blob/main/research/RESEARCH.md`}>
          Read the research notes
        </a>{' '}
        for the benchmarks behind each choice.
      </p>
    </section>
  )
}

function FileSummary({ probe, onReplace }: { probe: Probe; onReplace?: () => void }) {
  const codec = probe.videoCodec ? CODEC_LABEL[probe.videoCodec] ?? probe.videoCodec : 'Unknown codec'
  return (
    <div className="summary">
      <div className="poster" style={{ aspectRatio: `${probe.width} / ${probe.height}` }}>
        {probe.poster && <img src={probe.poster} alt="" width={probe.width} height={probe.height} />}
      </div>
      <div className="summary-body">
        <h1 className="filename" title={probe.file.name} tabIndex={-1}>
          {probe.file.name}
        </h1>
        <p className="size">{fmt.bytes(probe.file.size)}</p>
        <dl className="facts">
          <div>
            <dt>Resolution</dt>
            <dd>
              {probe.width}×{probe.height}
            </dd>
          </div>
          <div>
            <dt>Length</dt>
            <dd>{fmt.duration(probe.duration)}</dd>
          </div>
          <div>
            <dt>Frame rate</dt>
            <dd>{fmt.fps(probe.fps)}</dd>
          </div>
          <div>
            <dt>Codec</dt>
            <dd>{codec}</dd>
          </div>
          <div>
            <dt>Bitrate</dt>
            <dd>{fmt.bitrate(probe.videoBitrate)}</dd>
          </div>
          <div>
            <dt>Audio</dt>
            <dd>{probe.audio ? codecName(probe.audio.codec) : 'None'}</dd>
          </div>
        </dl>
        {onReplace && (
          <button type="button" className="link" onClick={onReplace}>
            Choose a different video
          </button>
        )}
      </div>
    </div>
  )
}

/** What Auto picked and why, as "format: reason" in one line on wide screens (two on phones). */
function choiceDetail({ reason, vmaf }: NonNullable<Calibration['choice']>, target: number | null | undefined) {
  const gain = vmaf?.av1 !== undefined ? vmaf.av1 - vmaf.avc : 0
  if (reason === 'testing') return 'H.264 so far, testing AV1'
  if (reason === 'high' && vmaf) return `H.264: already ${Math.round(vmaf.avc)} VMAF here`
  if (vmaf?.av1 === undefined && reason === 'even') return 'Measured on short test encodes'
  if (reason === 'device') return 'H.264: this device can’t play AV1'
  if (reason === 'size') return `AV1: H.264 can’t get ${target ? `under ${fmt.bytes(target)}` : 'to half the size'}`
  if (reason === 'predicted') return 'AV1: H.264 is near its limit at this size'
  if (reason === 'hdr') return 'AV1: keeps this HDR video in 10 bits'
  if (reason === 'better') return `AV1: ${gain.toFixed(1)} VMAF above H.264 here`
  return gain > 0 ? `H.264: AV1 only ${gain.toFixed(1)} VMAF better` : `H.264: ${(-gain).toFixed(1)} VMAF above AV1 here`
}

function Ready(props: {
  probe: Probe
  settings: Settings
  setSettings: (fn: (s: Settings) => Settings) => void
  tuning: Tuning | null
  error?: string
  onStart: () => void
  onReplace: () => void
}) {
  const { probe, settings, setSettings, tuning } = props
  // What's compressed: the whole video, or the part the Length choice keeps. Sizes compare with its bytes.
  const part = useMemo(() => narrow(probe, settings), [probe, settings.trim])
  const trimmed = !!part.trim
  const copy = settings.preset === 'copy'
  const short = Math.min(probe.width, probe.height)
  const target = outputSize(probe, settings.shortSide)
  const noEncoder = !copy && settings.engine === 'fast' && !probe.encodable[settings.codec]
  const sizeMode: SizeMode = !settings.sizeTarget ? 'any' : settings.targetBytes ? 'fit' : 'half'
  // A typed Fit under size the field rejects (empty, zero, not below the original) holds Compress back.
  const [fitProblem, setFitProblem] = useState<FitProblem>(null)
  // So does a size that isn't below this file's, or this part's.
  const fitBad = sizeMode === 'fit' && !copy &&
    (!!fitProblem || (settings.targetBytes ?? defaultFit(part.bytes)) >= part.bytes)
  // And a part typed but not usable (Length).
  const [trimProblem, setTrimProblem] = useState<string | null>(null)
  const blocked = fitBad || !!trimProblem
  // The Fit under size last chosen, which a part too small for it lowers to its own default only while it's chosen.
  const wanted = useRef(settings.targetBytes ?? null)
  const setTrim = (trim: Trim | null) => {
    const next = narrow(probe, { ...settings, trim })
    setSettings((s) => ({ ...s, trim,
      targetBytes: !s.targetBytes ? s.targetBytes : wanted.current && wanted.current < next.bytes ? wanted.current : defaultFit(next.bytes) }))
  }
  // Sizes compare with what's compressed: this part's share of the file, or the file.
  const base = part.bytes
  const result = tuning && 'result' in tuning && !blocked ? tuning.result : null

  // A resolution Pare lowered to itself, for a size the source's can't reach, shows on the choice that asked for it.
  const chosenSide = result?.shortSide || null
  const fitted = outputSize(probe, chosenSide)
  const resolutions: Option<string>[] = [
    { value: 'original', label: chosenSide && !settings.shortSide && !copy ? `Auto · ${chosenSide}p` : 'Original' },
    ...[1080, 720, 480].filter((r) => r < short).map((r) => ({ value: String(r), label: `${r}p` })),
  ]

  const codecs: Option<OutputCodec>[] = (['avc', 'hevc', 'av1'] as const).map((c) => ({
    value: c,
    label: CODEC_LABEL[c],
    disabled: !probe.encodable[c],
    title: probe.encodable[c] ? undefined : `This browser can’t encode ${CODEC_LABEL[c]}`,
  }))

  const unavailable = (['avc', 'hevc', 'av1'] as const).filter((c) => !probe.encodable[c]).map((c) => CODEC_LABEL[c])
  // Over the size asked for (what "reached" means differs between the engines; the size doesn't).
  const over = !!result && settings.sizeTarget && result.size > targetBytes(part, settings)
  // The size target in the estimate's words.
  const goal = settings.targetBytes ? `under ${fmt.bytes(settings.targetBytes)}` : 'in half the size'
  // A few frames encoded as the compression will encode them, on request, for a look before it runs.
  const [preview, setPreview] = useState<{ key: string; frames?: FramePair[]; error?: string } | null>(null)
  const previewing = useRef<AbortController | null>(null)
  const previewKey = result ? `${settingsKey(settings)}|${result.codec}|${result.crf}|${result.shortSide}|${result.fast}` : ''
  const shown = preview && preview.key === previewKey ? preview : null
  const encodingPreview = !!shown && !shown.frames && !shown.error
  const canPreview = usesX264(settings) && !copy && !blocked && result?.crf !== undefined && result.choice?.reason !== 'testing'
  useEffect(() => {
    previewing.current?.abort()
    setPreview(null)
  }, [previewKey])
  // Compressing leaves this screen; a preview still encoding would take cores from it.
  useEffect(() => () => previewing.current?.abort(), [])
  // The preview opens under the action bar, which on a phone is where the tap happened: bring it into view when it
  // opened out of sight, and take the focus the preview link had.
  const previewPanel = useRef<HTMLDivElement>(null)
  const previewShown = !!shown?.frames
  useEffect(() => {
    const panel = previewPanel.current
    if (!previewShown || !panel) return
    if (document.activeElement === document.body) panel.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
    if (panel.getBoundingClientRect().top < innerHeight * 0.6) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    panel.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
  }, [previewShown])
  useEffect(() => () => preview?.frames?.forEach((f) => (f.original.close(), f.compressed.close())), [preview])
  const runPreview = async () => {
    if (!result?.crf) return
    previewing.current?.abort()
    const controller = new AbortController()
    previewing.current = controller
    const key = previewKey
    setPreview({ key })
    try {
      const codec = settings.autoCodec ? result.codec ?? 'avc' : thoroughCodec(settings)
      const sized = { ...forEngine(part, settings), codec, shortSide: result.shortSide ?? settings.shortSide }
      const clip = await (await x264()).preview(part, sized, result.crf, codec === 'avc' && !!result.fast, controller.signal)
      const frames = await (await media()).framePairs(part, clip.blob, clip.times, clip.first)
      if (controller.signal.aborted) frames.forEach((f) => (f.original.close(), f.compressed.close()))
      else setPreview({ key, frames })
    } catch (err) {
      if (!controller.signal.aborted) setPreview({ key, error: message(err) })
    }
  }
  const presetLabel = PRESETS.find((p) => p.value === settings.preset)?.label.toLowerCase()
  const better = (['hevc', 'av1'] as const).filter((c) => c !== settings.codec && probe.encodable[c])
  // Open by default only when something in it has been changed.
  const [more, setMore] = useState(
    () => settings.engine !== 'thorough' || !settings.autoCodec || settings.shortSide !== null || !settings.keepAudio ||
      !!settings.keepPlace,
  )
  const thoroughName = (c: 'avc' | 'av1') => (c === 'av1' ? 'SVT-AV1' : 'x264')
  const outOfReach = `${short}p can’t get ${settings.targetBytes ? `under ${fmt.bytes(settings.targetBytes)}` : 'to half the size'}`
  const audioNote = () => {
    const audio = probe.audio
    if (!audio) return 'This video has no audio.'
    const plan = audioFor(part, settings)
    if (copy || !plan || plan.kind === 'copy') return undefined
    const name = audio.codec ? `${codecName(audio.codec)} audio` : 'this video’s audio'
    if (plan.kind === 'drop')
      return plan.reason === 'decode'
        ? `This browser can’t decode ${name}, so the copy will be silent.`
        : 'This browser can’t encode audio, so the copy will be silent.'
    const changes = [
      plan.channels < audio.channels && `mixed down to ${plan.channels === 1 ? 'mono' : 'stereo'}`,
      plan.sampleRate !== audio.sampleRate && `at ${plan.sampleRate / 1000} kHz`,
      // The compact rate for a tight Fit under size (audioFor).
      plan.reduced && `at ${plan.bitrate / 1000} kbps to leave room for the video`,
    ].filter((c): c is string => !!c)
    const listed = changes.length > 1 ? `${changes.slice(0, -1).join(', ')} and ${changes.at(-1)}` : changes[0]
    const verb = plan.codec === audio.codec ? 'is re-encoded' : `is converted to ${CODEC_LABEL[plan.codec]}`
    const converted = `${verb}${listed ? `, ${listed}` : ''}.`
    return audio.codec ? `${name} ${converted}` : `This video’s audio ${converted}`
  }
  const hdrNote = () => {
    // Frames the encoders can't take as planes (Firefox's RGB, 4:2:2, 4:4:4) go through an SDR canvas, as does the
    // browser's own encoder.
    if (settings.engine === 'fast' || !copiesFrames(probe))
      return 'This is an HDR video. The compressed copy is SDR, so highlights and colors may look flatter.'
    if (!deepFormat(probe.frame?.format)) return 'This is an HDR video in 8 bits. The copy stays HDR.'
    const codec = settings.autoCodec ? (keepsHdr(probe) ? 'av1' : null) : thoroughCodec(settings)
    if (codec === 'av1' && keepsHdr(probe)) return 'This is an HDR video. It stays HDR, as 10-bit AV1.'
    if (codec === 'avc')
      return keepsHdr(probe)
        ? 'This is an HDR video. H.264 here is 8-bit, so smooth gradients may band; AV1 keeps it in 10 bits.'
        : 'This is an HDR video. H.264 here is 8-bit, and this device can’t play 10-bit AV1, so smooth gradients may band.'
    return 'This is an HDR video. This device can’t play 10-bit AV1, so the copy is 8-bit and smooth gradients may band.'
  }
  const summary = [
    copy
      ? 'Original streams'
      : settings.engine === 'thorough'
        ? settings.autoCodec
          ? result?.codec ? `Auto: ${thoroughName(result.codec)}` : 'Auto'
          : thoroughName(thoroughCodec(settings))
        : `Browser ${CODEC_LABEL[settings.codec]}`,
    copy || !settings.shortSide ? (chosenSide && !copy ? `${chosenSide}p${over ? '' : ' to fit'}` : 'Original resolution')
      : `${settings.shortSide}p`,
    // Repackaging copies the audio whatever the plan says Pare's own encoders could do with it.
    !probe.audio ? 'No audio' : settings.keepAudio && (copy || audioFor(part, settings)?.kind !== 'drop') ? 'Audio kept' : 'Audio removed',
    probe.origin.place && (settings.keepPlace ? 'Location kept' : 'Location removed'),
  ].filter(Boolean).join(' · ')

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked) return
        props.onStart()
      }}
    >
      <FileSummary probe={probe} onReplace={props.onReplace} />

      <div className="panel settings">
        <Choice
          legend="Quality"
          value={settings.preset}
          options={PRESETS}
          onChange={(preset) => setSettings((s) => ({ ...s, preset }))}
          hint={PRESETS.find((p) => p.value === settings.preset)?.hint}
        />
        <Choice
          legend="Size"
          value={sizeMode}
          options={SIZE_OPTIONS}
          disabled={copy}
          onChange={(v) => {
            const targetBytes = v === 'fit' ? defaultFit(part.bytes) : null
            wanted.current = targetBytes
            setSettings((s) => ({ ...s, sizeTarget: v !== 'any', targetBytes }))
          }}
          hint={copy
            ? 'Unchanged.'
            : sizeMode === 'fit' && usesX264(settings) && !settings.shortSide
              ? FIT_HINT_LOWERS
              : trimmed ? SIZE_HINT[sizeMode].replace('halves the file', 'halves this part') : SIZE_HINT[sizeMode]}
        >
          {sizeMode === 'fit' && !copy && (
            <FitSize
              // Starts again from the size in the settings when the part changes.
              key={trimmed ? `${part.trim!.start}-${part.trim!.end}` : 'whole'}
              bytes={settings.targetBytes ?? defaultFit(part.bytes)}
              limit={part.bytes}
              limitLabel={trimmed ? 'this part of the original' : 'the original'}
              onChange={(targetBytes) => {
                wanted.current = targetBytes
                setSettings((s) => ({ ...s, targetBytes }))
              }}
              onProblem={setFitProblem}
            />
          )}
        </Choice>
        {probe.duration >= 2 * MIN_PART && probe.index.times.length > 1 && (
          <Length probe={probe} trim={settings.trim ?? null} onChange={setTrim} onProblem={setTrimProblem} />
        )}
        <details className="more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary>
            <span className="more-label">More options</span>
            <span className="more-summary">{summary}</span>
            <svg className="more-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="more-body">
            <Choice
              legend="Encoder"
              value={settings.engine}
              options={ENGINES}
              disabled={copy}
              onChange={(engine) => setSettings((s) => ({ ...s, engine }))}
              hint={copy ? 'Not used. Nothing is re-encoded.' : ENGINE_HINT[settings.engine]}
            />
            {settings.engine === 'thorough' && !copy && (
              <Choice
                legend="Format"
                value={thoroughFormat(settings)}
                options={THOROUGH_CODECS}
                onChange={(format) =>
                  setSettings((s) => (format === 'auto' ? { ...s, autoCodec: true } : { ...s, autoCodec: false, codec: format }))
                }
                hint={THOROUGH_CODEC_HINT[thoroughFormat(settings)]}
              />
            )}
            {settings.engine === 'fast' && !copy && (
              <Choice
                legend="Format"
                value={settings.codec}
                options={codecs}
                onChange={(codec) => setSettings((s) => ({ ...s, codec }))}
                hint={[CODEC_HINT[settings.codec], unavailable.length ? `${unavailable.join(' and ')} can’t be encoded in this browser.` : '']
                  .filter(Boolean)
                  .join(' ')}
              />
            )}
            <Choice
              legend="Resolution"
              value={settings.shortSide ? String(settings.shortSide) : 'original'}
              options={resolutions}
              disabled={copy || resolutions.length === 1}
              onChange={(v) => setSettings((s) => ({ ...s, shortSide: v === 'original' ? null : Number(v) }))}
              hint={copy
                ? 'Unchanged.'
                : chosenSide && !settings.shortSide
                  ? `${fitted.width}×${fitted.height}, ${over ? 'the lowest Pare goes' : 'lowered to fit'}`
                  : `${target.width}×${target.height}`}
            />
            <Choice
              legend="Audio"
              value={settings.keepAudio && probe.audio ? 'keep' : 'remove'}
              options={[
                { value: 'keep', label: 'Keep' },
                { value: 'remove', label: 'Remove' },
              ]}
              disabled={!probe.audio}
              onChange={(v) => setSettings((s) => ({ ...s, keepAudio: v === 'keep' }))}
              hint={audioNote()}
            />
            {probe.origin.place && (
              <Choice
                legend="Location"
                value={settings.keepPlace ? 'keep' : 'remove'}
                options={[
                  { value: 'keep', label: 'Keep' },
                  { value: 'remove', label: 'Remove' },
                ]}
                onChange={(v) => setSettings((s) => ({ ...s, keepPlace: v === 'keep' }))}
                hint={placeHint(probe.origin.place, !!settings.keepPlace, !!probe.origin.date)}
              />
            )}
          </div>
        </details>
        {probe.hdr && !copy && <p className="note">{hdrNote()}</p>}
        {settings.sizeTarget && !copy && !blocked && !reachable(part, settings) && (
          <p className="note">
            The audio alone takes up most of {settings.targetBytes ? 'that size' : trimmed ? 'half this part' : 'half this file'}, so no video size
            gets under it. The video is compressed at the quality you chose instead.
          </p>
        )}
        {result && !result.reached && !copy && usesX264(settings) && settings.targetBytes && (
          <p className="note">
            {(result.codec ?? thoroughCodec(settings)) === 'av1' ? 'AV1' : 'H.264'} can’t get this video under{' '}
            {fmt.bytes(settings.targetBytes)}, even at its lowest quality{result.shortSide ? ` and ${result.shortSide}p` : ''}:
            the smallest it gets is about {fmt.bytes(result.size)}, so the copy will come out over.{' '}
            {(result.codec ?? thoroughCodec(settings)) === 'avc' && result.choice?.reason === 'device'
              ? 'AV1 would get further, but this browser can’t play it.'
              : 'A larger size will fit.'}
          </p>
        )}
        {result && !result.reached && !copy && !usesX264(settings) && (
          <p className="note">
            {CODEC_LABEL[settings.codec]} in this browser can’t reach {presetLabel} quality on this {trimmed ? 'part' : 'video'}{' '}
            {settings.sizeTarget
              ? settings.targetBytes ? `under ${fmt.bytes(settings.targetBytes)}` : trimmed ? 'at half its size' : 'at half the original size'
              : 'without growing past the original’s bitrate'}, so this is
            as close as it gets.{' '}
            {better.length
              ? `${better.map((c) => CODEC_LABEL[c]).join(' or ')} should do better.`
              : 'A lower quality setting will make it smaller.'}
          </p>
        )}
        {result?.crf && !settings.sizeTarget && result.size > part.bytes * 0.95 && (
          <p className="note">
            This video is already compressed about as tightly as x264 manages at {presetLabel} quality. Compact or a
            smaller resolution will shrink it.
          </p>
        )}
        {tuning && 'error' in tuning && (
          <p className="error" role="alert">
            Couldn’t test this setting. {tuning.error}
          </p>
        )}
        {props.error && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        {shown?.error && (
          <p className="error" role="alert">
            Couldn’t make a preview. {shown.error}
          </p>
        )}
      </div>

      <div className="action-bar">
        <div className="estimate">
          <span className="estimate-label">Estimated size</span>
          {blocked ? (
            <span className="estimate-value unavailable">—</span>
          ) : result ? (
            <span className="estimate-value">
              ~{fmt.bytes(result.size)}
              {/* A repackaged part carries the frames from the keyframe before it: bigger than its share, and not worse. */}
              <span className={result.size >= base ? (copy ? 'delta muted' : 'delta bad') : over ? 'delta muted' : 'delta'}>
                {fmt.change(base, result.size)}
              </span>
            </span>
          ) : tuning && 'error' in tuning ? (
            <span className="estimate-value unavailable">Not available</span>
          ) : (
            <span className="estimate-value pending">
              {settings.engine === 'thorough' && !copy ? 'Estimating…' : 'Tuning to this video…'}
            </span>
          )}
          <span className="estimate-detail" id="estimate-detail">
            {trimProblem
              ? 'Fix the part’s times to see the estimate'
              : fitBad
              ? fitProblem === 'empty' || fitProblem === 'zero'
                ? 'Enter a size to see the estimate'
                : `Enter a size below ${trimmed ? 'this part of the original' : 'the original'}`
              : tuning && 'side' in tuning && tuning.side
              ? `Trying ${tuning.side}p: ${outOfReach}`
              : result?.shortSide
              ? `${result.codec === 'av1' ? 'AV1' : result.codec === 'avc' ? 'H.264' : 'Encoding'}${result.reached === false
                ? ` at ${result.shortSide}p: still over ${fmt.bytes(targetBytes(part, settings))}`
                : `, lowered to ${result.shortSide}p to fit`}`
              : result?.choice && result.choice.reason !== 'unlimited' && result.choice.reason !== 'fits'
              ? result.choice.reason === 'device' && result.size > targetBytes(part, settings)
                ? `H.264 can’t get this one ${settings.targetBytes ? `under ${fmt.bytes(settings.targetBytes)}` : 'to half the size'}, and this device can’t play AV1`
                : choiceDetail(result.choice, settings.targetBytes)
              : !result && usesX264(settings) && settings.autoCodec && settings.sizeTarget && !(tuning && 'error' in tuning)
              ? 'Test-encoding to pick the format'
              : result?.fast
              ? 'Fits easily, so it uses a faster preset'
              : result?.fitted === false
              ? `Highest quality already fits ${goal}`
              : result?.fitted
              ? `Best quality that fits ${goal}`
              : result?.raised
              ? settings.targetBytes ? `Compression raised to fit ${goal}` : 'Compression raised to reach 50% smaller'
              : result?.crf
              ? 'Measured on short test encodes'
              : result && !copy
              ? `SSIM ${result.ssim.toFixed(3)} on test clips at ${fmt.bitrate(result.bitrate)}`
              : tuning && 'round' in tuning && tuning.round > 0
                ? `Test encode ${tuning.round}`
                : copy
                  ? 'Same streams, new container'
                  : '\u00a0'}
          </span>
          {/* Announced once the estimate settles, not at every step on the way. */}
          <span className="sr-only" aria-live="polite">
            {result
              ? `Estimated size about ${fmt.bytes(result.size)}, ${fmt.change(base, result.size)}${over
                ? `, still over ${fmt.bytes(targetBytes(part, settings))}` : ''}.`
              : ''}
          </span>
          <span className="sr-only" aria-live="polite">
            {encodingPreview ? 'Encoding a preview.' : shown?.frames ? 'Preview ready, below.' : ''}
          </span>
          {canPreview && !shown?.frames && (
            // Not disabled while it works: a disabled button drops the keyboard focus to the page.
            <button type="button" className={`link estimate-preview${encodingPreview ? ' pending' : ''}`}
                    onClick={() => encodingPreview || void runPreview()}
                    aria-disabled={encodingPreview || undefined}>
              {encodingPreview ? 'Encoding a preview…' : 'Preview frames at this size'}
            </button>
          )}
        </div>
        <button type="submit" className="button primary" aria-describedby={blocked ? 'estimate-detail' : undefined}
                disabled={noEncoder || (!!tuning && 'error' in tuning && !usesX264(settings)) || blocked}>
          {copy ? 'Repackage video' : 'Compress video'}
        </button>
      </div>
      {shown?.frames && (
        <div ref={previewPanel} className="preview-panel">
          <Compare
            frames={shown.frames}
            title="Preview"
            note={`${['One moment', 'Two moments', 'Three moments'][shown.frames.length - 1] ?? 'Moments'} of this video, encoded with the settings the compression will use${result?.shortSide ? `, at ${result.shortSide}p` : ''}. SSIM of 1.000 means identical; from 0.98 it looks the same, and under 0.90 the loss is visible.`}
          />
        </div>
      )}
    </form>
  )
}

function Running(props: {
  probe: Probe
  /** Seconds being compressed: the part's, when trimmed. */
  duration: number
  progress: Progress | null
  status: string
  /** The size chosen with Fit under, for what a refit is for; half the original otherwise. */
  target?: number | null
  onCancel: () => void
}) {
  const { probe, progress, onCancel } = props
  const fraction = progress?.fraction ?? 0
  const speed = progress && progress.elapsed > 0.5 ? progress.processed / progress.elapsed : null
  // Encoders start slower than they run, so wait for some progress before predicting the end.
  const left = speed && fraction > 0.1 ? (props.duration - (progress?.processed ?? 0)) / speed : Infinity
  const stage = !progress
    ? props.status
    : progress.stage === 'finishing'
      ? 'Writing the file…'
      : progress.stage === 'refitting'
        ? `Encoding the busiest parts again to ${props.target ? `fit under ${fmt.bytes(props.target)}` : 'reach 50% smaller'}`
        : progress.workers && progress.workers > 1
        ? `Encoding on ${progress.workers} cores`
        : 'Encoding'
  return (
    <section className="stack">
      <FileSummary probe={probe} />
      <div className="panel running">
        <div className="running-head">
          <div className="running-title">
            <p className={progress ? 'running-stage' : 'running-stage pending'} aria-live="polite">
              {stage}
            </p>
            <span className="percent" data-idle={!progress || undefined} aria-hidden>
              {Math.floor(fraction * 100)}
              <span className="percent-sign">%</span>
            </span>
          </div>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div
          className="bar"
          role="progressbar"
          aria-label="Compressing"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(fraction * 100)}
        >
          <div className="bar-fill" style={{ transform: `scaleX(${fraction})` }} />
        </div>
        <dl className="facts inline">
          <div>
            <dt>Speed</dt>
            <dd>{speed ? `${speed.toFixed(1)}× realtime` : '—'}</dd>
          </div>
          <div>
            <dt>Frames/s</dt>
            <dd>{speed ? Math.round(speed * probe.fps) : '—'}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd>{progress?.stage === 'finishing' ? 'Almost done' : fmt.eta(left)}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

function verdict(ssim: number) {
  if (ssim >= 0.98) return 'Visually identical'
  if (ssim >= 0.95) return 'Excellent'
  if (ssim >= 0.9) return 'Good'
  return 'Visible loss'
}

const TIME_FORMAT = 'Enter a time in seconds, like 65.5, or as minutes:seconds, like 1:05.5.'
const TIME_ORDER = `The part has to end after it starts, and be at least ${MIN_PART} second long.`

/**
 * Which part of the video to compress: all of it, or from one moment to another, typed or taken from the player. Times
 * are shown from the video's start and snap to frames (snapTrim); a part is committed when a field is left or Enter is
 * pressed, so the estimate plans once per change rather than per keystroke.
 */
function Length({ probe, trim, onChange, onProblem }: {
  probe: Probe
  trim: Trim | null
  onChange: (trim: Trim | null) => void
  /** Why the typed part can't be used, or null; Compress waits while there's a reason. */
  onProblem: (problem: string | null) => void
}) {
  const [open, setOpen] = useState(!!trim)
  const end = endOf(probe)
  const { times } = probe.index
  const shown = (t: number) => fmt.clock(t - probe.start, 2)
  const [from, setFrom] = useState(() => shown(trim?.start ?? probe.start))
  const [to, setTo] = useState(() => shown(trim?.end ?? end))
  const [problem, setProblem] = useState<string | null>(null)
  // What Start here and End here set, said for screen readers.
  const [said, setSaid] = useState('')
  const url = useMemo(() => URL.createObjectURL(probe.file), [probe.file])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  // The browser may not play what it can decode frame by frame (HEVC in Firefox, some MOV): then only the fields.
  const [playable, setPlayable] = useState(true)
  const player = useRef<HTMLVideoElement>(null)
  // Seconds from the player's clock to the source's. Chrome and WebKit play a file on its own clock (a video whose
  // timestamps start at 3 s can't be sought before 3 s in Chrome, and lasts 15 s in WebKit), Firefox counts from 0.
  const offset = useRef(probe.start)
  // The frame on screen, where the browser says (requestVideoFrameCallback): a paused playhead can sit past it. Firefox
  // doesn't call it for a seek while paused, so it only counts while it agrees with the playhead.
  const presented = useRef<number | null>(null)
  useEffect(() => {
    const video = player.current
    if (!video || !('requestVideoFrameCallback' in video)) return
    let id = 0
    const track = (_: number, frame: VideoFrameCallbackMetadata) => {
      presented.current = frame.mediaTime
      id = video.requestVideoFrameCallback(track)
    }
    id = video.requestVideoFrameCallback(track)
    return () => video.cancelVideoFrameCallback(id)
  }, [open, playable])

  const fail = (why: string | null) => {
    setProblem(why)
    onProblem(why)
  }
  /** A typed time on the source's clock; a time left as it's shown keeps the exact frame it stands for. */
  const read = (text: string, exact: number) => (text === shown(exact) ? exact : (fmt.parseClock(text) ?? NaN) + probe.start)
  const apply = (next: Trim | null, seek: boolean) => {
    if (next && next.end - next.start < MIN_PART - 1e-6) return fail(TIME_ORDER)
    fail(null)
    setFrom(shown(next?.start ?? probe.start))
    setTo(shown(next?.end ?? end))
    const start = next?.start ?? probe.start
    const moved = start !== (trim?.start ?? probe.start)
    if (moved || next?.end !== trim?.end) onChange(next)
    // Show where the part now starts, when its start moved there.
    if (seek && moved && player.current) player.current.currentTime = start - offset.current
  }
  const commit = () => {
    const a = read(from, trim?.start ?? probe.start)
    const b = read(to, trim?.end ?? end)
    if (Number.isNaN(a) || Number.isNaN(b)) return fail(TIME_FORMAT)
    if (b <= a) return fail(TIME_ORDER)
    apply(snapTrim(probe, a, Math.min(b, end)), true)
  }
  /** Start or end the part at the frame on screen: it's kept either way. */
  const here = (which: 'from' | 'to') => {
    const video = player.current
    if (!video) return
    const frame = presented.current
    const now = frame !== null && Math.abs(frame - video.currentTime) < 1.5 / (probe.fps || 30) ? frame : video.currentTime
    const k = frameAt(probe.index, now + offset.current)
    const a = which === 'from' ? times[k] : read(from, trim?.start ?? probe.start)
    const b = which === 'to' ? (k + 1 < times.length ? times[k + 1] : end) : read(to, trim?.end ?? end)
    if (Number.isNaN(a) || Number.isNaN(b)) return fail(TIME_FORMAT)
    if (b <= a) return fail(TIME_ORDER)
    setSaid(`${which === 'from' ? 'From' : 'To'} ${shown(which === 'from' ? a : b)}`)
    apply(snapTrim(probe, a, Math.min(b, end)), false)
  }
  const field = (label: string, value: string, set: (v: string) => void, which: 'from' | 'to') => (
    <div className="trim-field">
      <label>
        <span>{label}</span>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          aria-invalid={!!problem}
          aria-describedby={problem ? 'trim-problem' : undefined}
          onChange={(e) => set(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // Enter commits the part here rather than submitting the form.
            e.preventDefault()
            commit()
          }}
        />
      </label>
      {playable && (
        // Pressing it keeps the focus in the field, so a typed time isn't committed (and the player moved) first.
        <button type="button" className="fit-preset" onMouseDown={(e) => e.preventDefault()} onClick={() => here(which)}>
          {which === 'from' ? 'Start here' : 'End here'}
        </button>
      )}
    </div>
  )
  const length = trim ? trim.end - trim.start : probe.duration
  return (
    <Choice
      legend="Length"
      value={open ? 'part' : 'whole'}
      options={[
        { value: 'whole', label: 'Whole video' },
        { value: 'part', label: 'Part of it' },
      ]}
      onChange={(v) => {
        setOpen(v === 'part')
        if (v === 'whole') {
          fail(null)
          setFrom(shown(probe.start))
          setTo(shown(end))
          if (trim) onChange(null)
        }
      }}
      hint={!open
        ? `All ${fmt.duration(probe.duration)} of it.`
        : trim && !problem
          ? `${fmt.clock(length)} of ${fmt.duration(probe.duration)}. The estimate and the size are for this part.`
          : playable
            ? 'Type where the part starts and ends, or play the video and use Start here and End here.'
            : 'This browser can’t play the video here. Type where the part starts and ends, like 65.5 or 1:05.5.'}
    >
      {open && (
        <div className="trim">
          {playable && (
            <video
              ref={player}
              className="trim-player"
              src={url}
              controls
              playsInline
              preload="metadata"
              onError={() => setPlayable(false)}
              onLoadedMetadata={(e) => {
                const video = e.currentTarget
                // Seeking shows a frame rather than an empty box (iOS Safari draws none before one), where the part
                // starts.
                const show = () => (video.currentTime = (trim?.start ?? probe.start) - offset.current)
                if (probe.start < 0.01) return void show()
                // Asked for 0, a player on the file's clock stops at its first timestamp (Chrome), or runs to its end
                // (WebKit's duration).
                video.addEventListener('seeked', () => {
                  const own = video.currentTime > 0.01 || Math.abs(video.duration - end) < Math.abs(video.duration - probe.duration)
                  offset.current = own ? 0 : probe.start
                  show()
                }, { once: true })
                video.currentTime = 0
              }}
            />
          )}
          <div className="trim-fields" style={{ '--chars': shown(end).length } as React.CSSProperties}>
            {field('From', from, setFrom, 'from')}
            {field('To', to, setTo, 'to')}
          </div>
          <div id="trim-problem" className="fit-problem" aria-live="polite">
            {problem && <p className="error">{problem}</p>}
          </div>
          <span className="sr-only" aria-live="polite">{said}</span>
        </div>
      )}
    </Choice>
  )
}

/** What's wrong with a typed Fit under size, if anything: nothing typed, not above 0, or not below the original. */
type FitProblem = 'empty' | 'zero' | 'over' | null

const fitProblem = (text: string, limit: number): FitProblem => {
  const mb = Number(text)
  return text.trim() === '' ? 'empty' : !(mb > 0) ? 'zero' : mb * 1e6 >= limit ? 'over' : null
}

/** The size for "Fit under": typed in megabytes, or one of the common limits smaller than the file. */
function FitSize({ bytes, limit, limitLabel, onChange, onProblem }: {
  bytes: number
  limit: number
  /** What `limit` is the size of. */
  limitLabel: string
  onChange: (bytes: number) => void
  /** What's wrong with the typed size; Compress waits while something is. */
  onProblem: (problem: FitProblem) => void
}) {
  const [text, setText] = useState(() => String(bytes / 1e6))
  const presets = FIT_PRESETS.filter((mb) => mb * 1e6 < limit)
  const typed = Number(text)
  const problem = fitProblem(text, limit)
  // Said here: a browser's own validation bubble is easy to miss, or not shown at all. Only once typing pauses, since
  // "0." on the way to "0.5" isn't a mistake yet; a fixed size clears it at once.
  const message = problem === 'empty'
    ? 'Enter a size in megabytes.'
    : problem === 'zero'
      ? 'Enter a size above 0 MB.'
      : problem === 'over' ? `That’s no smaller than ${limitLabel} (${fmt.bytes(limit)}).` : null
  // Reported from what the field shows, on mount too: a field brought back for a new part starts valid.
  useEffect(() => onProblem(problem), [problem])
  const [said, setSaid] = useState(message)
  useEffect(() => {
    if (!message) {
      setSaid(null)
      return
    }
    const timer = setTimeout(() => setSaid(message), 700)
    return () => clearTimeout(timer)
  }, [message])
  const set = (mb: number) => {
    setText(String(mb))
    onChange(mb * 1e6)
  }
  return (
    <div className="fit">
      <label className="fit-field">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={text}
          aria-invalid={!!said}
          aria-describedby={said ? 'fit-problem' : undefined}
          aria-label="Largest size, in megabytes"
          onChange={(e) => {
            setText(e.target.value)
            if (!fitProblem(e.target.value, limit)) onChange(Math.round(Number(e.target.value) * 1e6))
          }}
        />
        <span>MB</span>
      </label>
      {presets.map((mb) => (
        <button key={mb} type="button" className="fit-preset" aria-pressed={typed === mb} onClick={() => set(mb)}>
          {mb} MB
        </button>
      ))}
      {/* Always there, so the message is read when it changes rather than as an alert at every keystroke. */}
      <div id="fit-problem" className="fit-problem" aria-live="polite">
        {said && <p className="error">{said}</p>}
      </div>
    </div>
  )
}

function Done(props: {
  phase: Extract<Phase, { kind: 'done' }>
  copy: boolean
  onAdjust: () => void
  onNew: () => void
}) {
  const { probe, part, blob, url, quality } = props.phase
  // Against what was compressed: the file, or a part's share of it.
  const before = part.bytes
  const after = blob.size
  // A repackaged part isn't judged: its frames are the original's, from the keyframe before it.
  const smaller = (props.copy && !!part.trim) || after < before
  const ext = blob.type.includes('matroska') ? 'mkv' : blob.type.includes('quicktime') ? 'mov' : 'mp4'
  const name = `${probe.file.name.replace(/\.[^.]+$/, '')} (compressed${part.trim ? ' part' : ''}).${ext}`
  // Phones and most desktop browsers can hand the file straight to another app: a chat, mail, or the photo library.
  const file = useMemo(() => new File([blob], name, { type: blob.type }), [blob, name])
  const shareable = typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] })
  // Played back, the copy barely resembles the original although the encoder measured it fine: the browser handed the
  // encoder broken frames (WebKit's copyTo did, SSIM 0.01-0.02). readback.ts should catch that first; if it didn't,
  // an error says so and downloading is no longer the main action.
  const damaged = typeof quality === 'object' && !!quality.mismatch && quality.ssim < 0.5
  const [shareFailed, setShareFailed] = useState(false)
  const share = () => {
    setShareFailed(false)
    void navigator.share({ files: [file] }).catch((err: unknown) => {
      // Closing the share sheet isn't a failure, nor is a second tap while it's open; a file too big for the app is.
      const name = (err as Error)?.name
      if (name !== 'AbortError' && name !== 'InvalidStateError') setShareFailed(true)
    })
  }
  const missed = props.phase.missed
  // The quality line is one line without a score for every frame: a resolution Pare chose is judged on sampled frames,
  // and the browser's encoder gives no scores. The longer line has room kept for it on phones.
  const short = props.copy || quality === 'failed' ||
    (typeof quality === 'object' ? quality.scored <= quality.frames.length : !!props.phase.shortSide || !props.phase.codec)

  return (
    <section className="stack">
      <div className="panel result">
        <h1 className="result-kicker" tabIndex={-1}>
          {damaged
            ? 'The copy came out damaged'
            : smaller ? 'Done' : part.trim ? 'Done, but this part is smaller in the original' : 'Done, but the original is smaller'}
          {part.trim && ` · ${fmt.clock(part.trim.start - probe.start)} to ${fmt.clock(part.trim.end - probe.start)}`}
          {props.phase.codec && ` · ${props.phase.codec === 'av1' ? 'AV1' : 'H.264'}`}
          {props.phase.shortSide && ` · ${props.phase.shortSide}p${missed ? '' : ' to fit'}`}
        </h1>
        <p className="result-sizes">
          {/* A part's share of the original is worked out, not measured. */}
          <span className="from">{part.trim ? `~${fmt.bytes(before)}` : fmt.bytes(before)}</span>
          <span className="arrow" aria-label="to">
            →
          </span>
          <span className="to">{fmt.bytes(after)}</span>
          <span className={!smaller ? 'delta bad' : missed || after >= before ? 'delta muted' : 'delta'}>{fmt.change(before, after)}</span>
        </p>
        <p className="result-quality" data-short={short || undefined} aria-live="polite">
          {props.copy ? (
            'Bit-identical frames. Nothing was re-encoded.'
          ) : quality === 'pending' ? (
            <span className="pending">Checking quality against the original…</span>
          ) : quality === 'failed' ? (
            'Quality check unavailable for this file.'
          ) : (
            <>
              <strong>{verdict(quality.ssim)}</strong>
              <span className="muted">
                SSIM {quality.ssim.toFixed(4)}
                {quality.scored > quality.frames.length
                  ? ` across all ${quality.scored.toLocaleString()} frames, lowest ${quality.min.toFixed(4)}`
                  : ` · PSNR ${quality.psnr.toFixed(1)}\u00a0dB`}
              </span>
            </>
          )}
        </p>
        {damaged && (
          <p className="error" role="alert">
            Played back, this copy doesn’t match the original, most likely because this browser handed the encoder broken
            frames. Try compressing it in another browser.
          </p>
        )}
        {quality !== 'pending' && quality !== 'failed' && quality.mismatch && !damaged && (
          <p className="note">
            Played back, this copy looks less like the original than the encoder measured, so these numbers come from the
            frames below. Compare them before keeping it.
          </p>
        )}
        {!smaller && !damaged && (
          <p className="note">
            {part.trim
              ? 'This part was already efficiently compressed. Try a lower quality.'
              : 'This video was already efficiently compressed. Keep the original, or try a lower quality.'}
          </p>
        )}
        {smaller && missed && !damaged && (
          <p className="note">
            {!props.phase.codec
              ? `${missed.label} came out over ${missed.target ? `the ${fmt.bytes(missed.target)} you chose` : 'half the size'}. The Thorough encoder aims closer.`
              : missed.target
                ? `It came out at ${fmt.bytes(after)}, over the ${fmt.bytes(missed.target)} you chose: that’s as small as ${missed.label} gets with this video${missed.lower ? ' at this resolution' : ''}.`
                : `This video was already efficiently compressed, and this is as small as ${missed.label} could make it: short of half the size.`}
            {!props.phase.codec
              ? ''
              : missed.lower
                ? ' A lower resolution would get further.'
                : missed.noAv1
                  ? ' A browser that plays AV1 would get further.'
                  : missed.target ? ' A larger size will fit.' : ''}
          </p>
        )}
        {shareFailed && <p className="note">This file couldn’t be shared from here. Download it instead.</p>}
        <div className="result-actions">
          {/* The original holds no copy of a part on its own, so downloading stays the main action for one. */}
          <a className={(smaller || part.trim) && !damaged ? 'button primary' : 'button'} href={url} download={name}>
            Download {ext.toUpperCase()}
          </a>
          {shareable && !damaged && (
            <button type="button" className="button share" onClick={share}>
              Share
            </button>
          )}
          <button type="button" className={shareable && !damaged ? 'button' : 'button ghost'} onClick={props.onAdjust}>
            Change settings
          </button>
          <button type="button" className="link push" onClick={props.onNew}>
            Compress another video
          </button>
        </div>
      </div>
      {typeof quality === 'object' && <Compare frames={quality.frames} timeline={quality.timeline} />}
    </section>
  )
}
