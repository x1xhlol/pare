import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Choice, type Option } from './components/Choice'
import { Compare } from './components/Compare'
import { BENCHMARKS, BENCHMARK_SETUP } from './benchmarks'
import * as fmt from './lib/format'
import { dropPlace, placeLabel } from './lib/origin'
import type { Calibration, FramePair, Job, QualityReport } from './lib/media'
import type { Progress, SizePlan } from './lib/x264'
import {
  audioFor, CODEC_LABEL, codecName, copiesFrames, deepFormat, forEngine, keepsHdr, reachable, targetBytes, outputSize, type Engine, type OutputCodec, type Preset, type Probe,
  type Settings,
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
      blob: Blob
      url: string
      quality: QualityReport | 'pending' | 'failed'
      /** The format Pare's own encoders wrote, when they ran. */
      codec?: 'avc' | 'av1'
      /** The size target was on and the file still came out over it: the target, or null for half the original. */
      missed?: { target: number | null }
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
  `${s.preset}|${usesX264(s) ? `wasm-${thoroughFormat(s)}` : s.codec}|${s.shortSide}|${s.keepAudio}|${s.sizeTarget}|${s.targetBytes ?? ''}`
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

const SIZE_HINT: Record<SizeMode, string> = {
  half: "Keeps the chosen quality when that already halves the file. If it wouldn't, compression is raised just enough to get there, and the quality check shows how close it stayed.",
  fit: 'Keeps the chosen quality when that already fits. If it wouldn’t, compression is raised just enough to get under the size. For much smaller files, a lower resolution usually looks better.',
  any: 'Always encodes at the chosen quality, even if the file barely shrinks.',
}

/** Common upload limits, in MB: Discord's free tier, email attachments, and two larger ones. */
const FIT_PRESETS = [10, 25, 50, 100]

/** Where "Fit under" starts: 10 MB, or a quarter of a smaller file. */
const defaultFit = (size: number) => (size > 20e6 ? 10e6 : Math.max(1e6, Math.round(size / 4 / 1e5) * 1e5))

/** Phones record where a video was taken. Left out by default, since a compressed copy is often one to share. */
const placeHint = (place: string, keep: boolean) => {
  const where = placeLabel(place)
  return keep
    ? `The copy says it was recorded at ${where ?? 'the same place'}, as the original does.`
    : `The original says where it was recorded${where ? ` (${where})` : ''}. The copy leaves that out and keeps the recording date.`
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
        throw new Error(`This browser can't decode ${codec} video. Try Chrome or Edge.`)
      }
      // The browser's own encoders need browser support; Pare's WebAssembly ones work everywhere.
      setSettings((s) => ({
        ...s,
        codec: s.engine === 'thorough' || probe.encodable[s.codec] ? s.codec : firstEncodable(probe),
        shortSide: null,
      }))
      setPhase({ kind: 'ready', probe })
    } catch (err) {
      setPhase({ kind: 'empty', error: `Couldn't open ${file.name}. ${message(err)}` })
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
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue
    queue?.setConsumer(async ({ files }) => {
      const handle = files?.[0]
      if (handle) void open(await handle.getFile())
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

  const ensureCalibration = (probe: Probe, chosen: Settings) => {
    const key = settingsKey(chosen)
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
            return { ...fromPlan(plan), codec, choice: { reason, vmaf }, shortSide }
          })
        : usesX264(settings)
          ? x264().then(async (m) => {
              const { result, shortSide } = await shrink(m, await m.plan(probe, settings, controller.signal),
                (p) => [p, thoroughCodec(settings)], (s) => m.plan(probe, s, controller.signal))
              return { ...fromPlan(result), shortSide }
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
      const sized = { ...forEngine(probe, settings), codec, shortSide: settled.shortSide ?? settings.shortSide }
      spec.job = engine.encode(probe, sized, start, (p) => {
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
    // With the size target, x264 starts from the size plan's rate factor and steers from there while it encodes.
    // Without it there is nothing to plan, and the browser's encoders need their tuned bitrate up front.
    const engine = forEngine(probe, settings)
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
            const why = first?.reaches ? "H.264 isn't near 1:1 at this size" : "H.264 can't reach half the size"
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
        run.job = x264Engine.encode(probe, { ...engine, codec, shortSide: shortSide ?? engine.shortSide },
          { crf: plan?.crf, slope: plan?.slope, points: plan?.points, reuse: codec === 'avc' ? plan?.reuse : undefined,
            fast: codec === 'avc' && plan?.fast, long: plan?.long }, onProgress)
      } else {
        const { bitrate } = await ensureCalibration(probe, settings).promise
        if (run.canceled) return
        run.job = (await media()).compress(probe, engine, bitrate, onProgress)
      }
      const { measureQuality } = await media()
      const { blob: made, scores } = await run.job.promise
      const blob = settings.keepPlace ? made : await dropPlace(made)
      const url = URL.createObjectURL(blob)
      const missed = engine.sizeTarget && settings.preset !== 'copy' && blob.size > targetBytes(probe, settings)
        ? { target: settings.targetBytes ?? null } : undefined
      setPhase({ kind: 'done', probe, blob, url, quality: settings.preset === 'copy' ? 'failed' : 'pending', codec, missed,
        shortSide })
      if (settings.preset === 'copy') return
      // The encoder's own scores are at the size it encoded; a resolution Pare chose itself is judged at the original's.
      const quality = await (shortSide ? measureQuality(probe, blob, undefined, 8, true) : measureQuality(probe, blob, scores))
        .catch(() => 'failed' as const)
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

      <main className="main" key={view} data-enter={view !== 'empty' || undefined}>
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
            progress={phase.progress}
            status={phase.status}
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
      <h1 className="display">This browser can't encode video.</h1>
      <p className="lede">Pare uses the WebCodecs API. Open it in a current Chrome, Edge, Safari (17+), or Firefox (130+).</p>
    </section>
  )
}

function Empty(props: { dragging: boolean; probing: string | null; error?: string; onPick: () => void }) {
  return (
    <section className="stack intro">
      <div className="intro-head">
        <h1 className="display">Make a video smaller without making it worse.</h1>
        <p className="lede">
          Pare cuts a video to half its size or less and keeps it looking like the original. It encodes on every core of
          your computer, in this tab, and the file never leaves your device.
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
        <p className="filename" title={probe.file.name}>
          {probe.file.name}
        </p>
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
function choiceDetail({ reason, vmaf }: NonNullable<Calibration['choice']>, fit: boolean) {
  const gain = vmaf?.av1 !== undefined ? vmaf.av1 - vmaf.avc : 0
  if (reason === 'testing') return 'H.264 so far, testing AV1'
  if (reason === 'high' && vmaf) return `H.264: already ${Math.round(vmaf.avc)} VMAF here`
  if (vmaf?.av1 === undefined && reason === 'even') return 'Measured on short test encodes'
  if (reason === 'device') return "H.264: this device can't play AV1"
  if (reason === 'size') return `AV1: H.264 can't get ${fit ? 'under that size' : 'to half the size'}`
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
  const copy = settings.preset === 'copy'
  const short = Math.min(probe.width, probe.height)
  const target = outputSize(probe, settings.shortSide)
  const fitted = outputSize(probe, (tuning && 'result' in tuning && tuning.result.shortSide) || null)
  const noEncoder = !copy && settings.engine === 'fast' && !probe.encodable[settings.codec]

  const resolutions: Option<string>[] = [
    { value: 'original', label: `Original` },
    ...[1080, 720, 480].filter((r) => r < short).map((r) => ({ value: String(r), label: `${r}p` })),
  ]

  const codecs: Option<OutputCodec>[] = (['avc', 'hevc', 'av1'] as const).map((c) => ({
    value: c,
    label: CODEC_LABEL[c],
    disabled: !probe.encodable[c],
    title: probe.encodable[c] ? undefined : `This browser can't encode ${CODEC_LABEL[c]}`,
  }))

  const unavailable = (['avc', 'hevc', 'av1'] as const).filter((c) => !probe.encodable[c]).map((c) => CODEC_LABEL[c])
  const result = tuning && 'result' in tuning ? tuning.result : null
  // A few frames encoded as the compression will encode them, on request, for a look before it runs.
  const [preview, setPreview] = useState<{ key: string; frames?: FramePair[]; error?: string } | null>(null)
  const previewing = useRef<AbortController | null>(null)
  const previewKey = result ? `${settingsKey(settings)}|${result.codec}|${result.crf}|${result.shortSide}|${result.fast}` : ''
  const shown = preview && preview.key === previewKey ? preview : null
  const canPreview = usesX264(settings) && !copy && result?.crf !== undefined && result.choice?.reason !== 'testing'
  useEffect(() => {
    previewing.current?.abort()
    setPreview(null)
  }, [previewKey])
  // Compressing leaves this screen; a preview still encoding would take cores from it.
  useEffect(() => () => previewing.current?.abort(), [])
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
      const sized = { ...forEngine(probe, settings), codec, shortSide: result.shortSide ?? settings.shortSide }
      const clip = await (await x264()).preview(probe, sized, result.crf, codec === 'avc' && !!result.fast, controller.signal)
      const frames = await (await media()).framePairs(probe, clip.blob, clip.times, clip.first)
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
  const sizeMode: SizeMode = !settings.sizeTarget ? 'any' : settings.targetBytes ? 'fit' : 'half'
  const audioNote = () => {
    const audio = probe.audio
    if (!audio) return 'This video has no audio.'
    const plan = audioFor(probe, settings)
    if (copy || !plan || plan.kind === 'copy') return undefined
    const name = audio.codec ? `${codecName(audio.codec)} audio` : 'this video’s audio'
    if (plan.kind === 'drop')
      return plan.reason === 'decode'
        ? `This browser can’t decode ${name}, so the copy will be silent.`
        : 'This browser can’t encode audio, so the copy will be silent.'
    const changes = [
      plan.channels < audio.channels && `mixed down to ${plan.channels === 1 ? 'mono' : 'stereo'}`,
      plan.sampleRate !== audio.sampleRate && `at ${plan.sampleRate / 1000} kHz`,
    ].filter(Boolean)
    const converted = `is converted to ${CODEC_LABEL[plan.codec]}${changes.length ? `, ${changes.join(' and ')}` : ''}.`
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
    copy || !settings.shortSide ? (result?.shortSide && !copy ? `${result.shortSide}p to fit` : 'Original resolution')
      : `${settings.shortSide}p`,
    // Repackaging copies the audio whatever the plan says Pare's own encoders could do with it.
    !probe.audio ? 'No audio' : settings.keepAudio && (copy || audioFor(probe, settings)?.kind !== 'drop') ? 'Audio kept' : 'Audio removed',
    probe.origin.place && (settings.keepPlace ? 'Location kept' : 'Location removed'),
  ].filter(Boolean).join(' · ')

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
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
          onChange={(v) => setSettings((s) => ({ ...s, sizeTarget: v !== 'any',
            targetBytes: v === 'fit' ? (s.targetBytes ?? defaultFit(probe.file.size)) : null }))}
          hint={copy ? 'Unchanged.' : SIZE_HINT[sizeMode]}
        >
          {sizeMode === 'fit' && !copy && (
            <FitSize
              bytes={settings.targetBytes ?? defaultFit(probe.file.size)}
              limit={probe.file.size}
              onChange={(targetBytes) => setSettings((s) => ({ ...s, targetBytes }))}
            />
          )}
        </Choice>
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
                hint={[CODEC_HINT[settings.codec], unavailable.length ? `${unavailable.join(' and ')} can't be encoded in this browser.` : '']
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
                : result?.shortSide && !settings.shortSide
                  ? `${fitted.width}×${fitted.height}: ${outOfReach}, at any quality.`
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
                hint={placeHint(probe.origin.place, !!settings.keepPlace)}
              />
            )}
          </div>
        </details>
        {probe.hdr && !copy && <p className="note">{hdrNote()}</p>}
        {settings.sizeTarget && !copy && !reachable(probe, settings) && (
          <p className="note">
            The audio alone takes up most of {settings.targetBytes ? 'that size' : 'half this file'}, so no video size
            gets under it. The video is compressed at the quality you chose instead.
          </p>
        )}
      </div>

      <div className="action-bar">
        <div className="estimate" aria-live="polite">
          <span className="estimate-label">Estimated size</span>
          {result ? (
            <span className="estimate-value">
              ~{fmt.bytes(result.size)}
              <span className="delta">{fmt.change(probe.file.size, result.size)}</span>
            </span>
          ) : tuning && 'error' in tuning ? (
            <span className="estimate-value unavailable">Not available</span>
          ) : (
            <span className="estimate-value pending">
              {settings.engine === 'thorough' && !copy ? 'Estimating…' : 'Tuning to this video…'}
            </span>
          )}
          <span className="estimate-detail">
            {tuning && 'side' in tuning && tuning.side
              ? `Trying ${tuning.side}p: ${outOfReach}`
              : result?.shortSide
              ? `${result.codec === 'av1' ? 'AV1' : result.codec === 'avc' ? 'H.264' : 'Encoding'} at ${result.shortSide}p: ${outOfReach}`
              : result?.choice && result.choice.reason !== 'unlimited' && result.choice.reason !== 'fits'
              ? result.choice.reason === 'device' && result.size > targetBytes(probe, settings)
                ? `H.264 can’t get this one ${settings.targetBytes ? 'under that size' : 'to half'}, and this device can’t play AV1`
                : choiceDetail(result.choice, !!settings.targetBytes)
              : !result && usesX264(settings) && settings.autoCodec && settings.sizeTarget && !(tuning && 'error' in tuning)
              ? 'Test-encoding to pick the format'
              : result?.fast
              ? 'Fits easily, so it uses a faster preset'
              : result?.fitted === false
              ? 'Highest quality already fits in half the size'
              : result?.fitted
              ? 'Best quality that fits in half the size'
              : result?.raised
              ? 'Compression raised to reach 50% smaller'
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
          {canPreview && !shown?.frames && (
            <button type="button" className="link estimate-preview" onClick={() => void runPreview()}
                    disabled={!!shown && !shown.frames && !shown.error}>
              {shown && !shown.error ? 'Encoding a preview…' : 'Preview frames at this size'}
            </button>
          )}
        </div>
        <button type="submit" className="button primary" disabled={noEncoder || (!!tuning && 'error' in tuning && !usesX264(settings))}>
          {copy ? 'Repackage video' : 'Compress video'}
        </button>
      </div>
      {result && !result.reached && !copy && (
        <p className="note">
          {CODEC_LABEL[settings.codec]} in this browser can't reach {presetLabel} quality on this video{' '}
          {settings.sizeTarget
            ? settings.targetBytes ? `under ${fmt.bytes(settings.targetBytes)}` : 'at half the original size'
            : "without growing past the original's bitrate"}, so this is
          as close as it gets.{' '}
          {better.length
            ? `${better.map((c) => CODEC_LABEL[c]).join(' or ')} should do better.`
            : 'A lower quality setting will make it smaller.'}
        </p>
      )}
      {result?.crf && !settings.sizeTarget && result.size > probe.file.size * 0.95 && (
        <p className="note">
          This video is already compressed about as tightly as x264 manages at {presetLabel} quality. Compact or a
          smaller resolution will shrink it.
        </p>
      )}
      {tuning && 'error' in tuning && (
        <p className="error" role="alert">
          Couldn't test this setting. {tuning.error}
        </p>
      )}
      {props.error && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
      {shown?.error && (
        <p className="error" role="alert">
          Couldn't make a preview. {shown.error}
        </p>
      )}
      {shown?.frames && (
        <Compare
          frames={shown.frames}
          title="Preview"
          note={`Three moments of this video, encoded with the settings the compression will use${result?.shortSide ? `, at ${result.shortSide}p` : ''}. SSIM of 1.000 means identical.`}
        />
      )}
    </form>
  )
}

function Running(props: { probe: Probe; progress: Progress | null; status: string; onCancel: () => void }) {
  const { probe, progress, onCancel } = props
  const fraction = progress?.fraction ?? 0
  const speed = progress && progress.elapsed > 0.5 ? progress.processed / progress.elapsed : null
  // Encoders start slower than they run, so wait for some progress before predicting the end.
  const left = speed && fraction > 0.1 ? (probe.duration - (progress?.processed ?? 0)) / speed : Infinity
  const stage = !progress
    ? props.status
    : progress.stage === 'finishing'
      ? 'Writing the file…'
      : progress.stage === 'refitting'
        ? 'Encoding the busiest parts again to reach 50% smaller'
        : progress.workers
        ? `Encoding on ${progress.workers} ${progress.workers === 1 ? 'core' : 'cores'}`
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
            <dt>Frames per second</dt>
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

/** The size for "Fit under": typed in megabytes, or one of the common limits smaller than the file. */
function FitSize({ bytes, limit, onChange }: { bytes: number; limit: number; onChange: (bytes: number) => void }) {
  const [text, setText] = useState(() => String(bytes / 1e6))
  const presets = FIT_PRESETS.filter((mb) => mb * 1e6 < limit)
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
          min={0.1}
          step="any"
          value={text}
          aria-label="Largest size, in megabytes"
          onChange={(e) => {
            setText(e.target.value)
            const mb = Number(e.target.value)
            if (mb > 0) onChange(Math.round(mb * 1e6))
          }}
        />
        <span>MB</span>
      </label>
      {presets.map((mb) => (
        <button key={mb} type="button" className="fit-preset" aria-pressed={bytes === mb * 1e6} onClick={() => set(mb)}>
          {mb} MB
        </button>
      ))}
    </div>
  )
}

function Done(props: {
  phase: Extract<Phase, { kind: 'done' }>
  copy: boolean
  onAdjust: () => void
  onNew: () => void
}) {
  const { probe, blob, url, quality } = props.phase
  const before = probe.file.size
  const after = blob.size
  const smaller = after < before
  const ext = blob.type.includes('matroska') ? 'mkv' : 'mp4'
  const name = `${probe.file.name.replace(/\.[^.]+$/, '')} (compressed).${ext}`
  // Phones and most desktop browsers can hand the file straight to another app: a chat, mail, or the photo library.
  const file = useMemo(() => new File([blob], name, { type: blob.type }), [blob, name])
  const shareable = typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] })

  return (
    <section className="stack">
      <div className="panel result">
        <p className="result-kicker">
          {smaller ? 'Done' : 'Done, but the original is smaller'}
          {props.phase.codec && ` · ${props.phase.codec === 'av1' ? 'AV1' : 'H.264'}`}
          {props.phase.shortSide && ` · ${props.phase.shortSide}p to fit`}
        </p>
        <p className="result-sizes">
          <span className="from">{fmt.bytes(before)}</span>
          <span className="arrow" aria-label="to">
            →
          </span>
          <span className="to">{fmt.bytes(after)}</span>
          <span className={smaller ? 'delta' : 'delta bad'}>{fmt.change(before, after)}</span>
        </p>
        <p className="result-quality" aria-live="polite">
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
        {quality !== 'pending' && quality !== 'failed' && quality.mismatch && (
          <p className="note">
            Played back, this copy looks less like the original than the encoder measured, so these numbers come from the
            frames below. Compare them before keeping it.
          </p>
        )}
        {!smaller && (
          <p className="note">This video was already efficiently compressed. Keep the original, or try a lower quality.</p>
        )}
        {smaller && props.phase.missed && (
          <p className="note">
            This video was already efficiently compressed, and this is as small as{' '}
            {props.phase.codec === 'av1' ? 'AV1' : 'H.264'} could make it: short of{' '}
            {props.phase.missed.target ? fmt.bytes(props.phase.missed.target) : 'half the size'}. A lower resolution
            would get further.
          </p>
        )}
        <div className="result-actions">
          <a className={smaller ? 'button primary' : 'button'} href={url} download={name}>
            Download {ext.toUpperCase()}
          </a>
          {shareable && (
            <button type="button" className="button ghost" onClick={() => void navigator.share({ files: [file] }).catch(() => {})}>
              Share
            </button>
          )}
          <button type="button" className="button ghost" onClick={props.onAdjust}>
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
