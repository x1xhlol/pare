import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Choice, type Option } from './components/Choice'
import { Compare } from './components/Compare'
import * as fmt from './lib/format'
import type { Calibration, Job, Progress, QualityReport } from './lib/media'
import { CODEC_LABEL, outputSize, type Engine, type OutputCodec, type Preset, type Probe, type Settings } from './lib/shared'

const media = () => import('./lib/media')
const x264 = () => import('./lib/x264')

type Phase =
  | { kind: 'empty'; error?: string }
  | { kind: 'probing'; name: string }
  | { kind: 'ready'; probe: Probe; error?: string }
  | { kind: 'running'; probe: Probe; progress: Progress | null }
  | { kind: 'done'; probe: Probe; blob: Blob; url: string; quality: QualityReport | 'pending' | 'failed' }

type Tuning = { round: number } | { result: Calibration } | { error: string }
type CalibrationEntry = { promise: Promise<Calibration>; controller: AbortController; result?: Calibration }

const usesX264 = (s: Settings) => s.engine === 'thorough' && s.preset !== 'copy'
const settingsKey = (s: Settings) =>
  `${s.preset}|${usesX264(s) ? 'x264' : s.codec}|${s.shortSide}|${s.keepAudio}`
const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'ConversionCanceledError')

const supported = typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoDecoder' in window

const PRESETS: { value: Preset; label: string; hint: string }[] = [
  {
    value: 'visually-lossless',
    label: 'Visually lossless',
    hint: 'Looks the same as the original at any normal viewing size. Every result is checked frame by frame.',
  },
  { value: 'high', label: 'High', hint: 'Smaller. Differences only show up when you pause and zoom in.' },
  { value: 'compact', label: 'Compact', hint: 'Smallest. Fine texture softens, which is fine for chats and uploads.' },
  {
    value: 'copy',
    label: 'Exact copy',
    hint: 'Repackages the original streams without re-encoding, so every frame is bit-identical. It only saves space when the container itself is wasteful.',
  },
]

const ENGINES: Option<Engine>[] = [
  { value: 'thorough', label: 'Thorough' },
  { value: 'fast', label: 'Fast' },
]

const ENGINE_HINT: Record<Engine, string> = {
  thorough:
    'x264, the encoder inside HandBrake and ffmpeg, running on every CPU core. The smallest files for the quality. H.264 output plays everywhere.',
  fast: "Your browser's built-in encoder, often hardware-accelerated. Several times quicker, but files come out larger at the same quality.",
}

const CODEC_HINT: Record<OutputCodec, string> = {
  avc: 'Plays everywhere.',
  hevc: 'About 40% smaller than H.264. Plays on Apple devices, Windows, and Chrome.',
  av1: 'Smallest files, slowest to encode. Plays in current browsers and newer phones.',
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
    shortSide: null,
    keepAudio: true,
  })
  const [tuning, setTuning] = useState<(Tuning & { key: string }) | null>(null)
  const calibrations = useRef(new Map<string, CalibrationEntry>())
  const currentKey = useRef('')
  const cancelRun = useRef<(() => void) | null>(null)
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
    for (const entry of calibrations.current.values()) entry.controller.abort()
    calibrations.current.clear()
    setTuning(null)
    try {
      const probe = await (await media()).probeFile(file)
      if (!probe.canDecode) {
        const codec = probe.videoCodec ? CODEC_LABEL[probe.videoCodec] ?? probe.videoCodec : 'this codec'
        throw new Error(`This browser can't decode ${codec} video. Try Chrome or Edge.`)
      }
      setSettings((s) => ({ ...s, codec: probe.encodable[s.codec] ? s.codec : firstEncodable(probe), shortSide: null }))
      setPhase({ kind: 'ready', probe })
    } catch (err) {
      setPhase({ kind: 'empty', error: `Couldn't open ${file.name}. ${message(err)}` })
    }
  }, [])

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

  const ensureCalibration = (probe: Probe, settings: Settings) => {
    const key = settingsKey(settings)
    const existing = calibrations.current.get(key)
    if (existing) return existing
    const controller = new AbortController()
    const onRound = (round: number) => {
      if (currentKey.current === key) setTuning({ key, round })
    }
    const entry: CalibrationEntry = {
      controller,
      promise: usesX264(settings)
        ? x264().then(async (m) => {
            const size = await m.estimate(probe, settings, controller.signal)
            const crf = m.CRF[settings.preset as Exclude<Preset, 'copy'>]
            return { bitrate: 0, size, ssim: 0, target: 0, reached: true, crf }
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
    calibrations.current.set(key, entry)
    return entry
  }

  // Tune the bitrate for the current settings while the user is still choosing. Results are cached per setting.
  useEffect(() => {
    if (!probe) return
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
      if (entry && !entry.result) {
        entry.controller.abort()
        map.delete(key)
      }
    }
    // `key` captures every setting that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe, key])

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
    cancelRun.current = () => {
      run.canceled = true
      if (run.job) run.job.cancel()
      else setPhase({ kind: 'ready', probe })
    }
    setPhase({ kind: 'running', probe, progress: null })
    const onProgress = (progress: Progress) => setPhase((p) => (p.kind === 'running' ? { ...p, progress } : p))
    try {
      if (usesX264(settings)) {
        // The size estimate competes with the encode for the same cores, so drop it if it's still running.
        const pending = calibrations.current.get(key)
        if (pending && !pending.result) {
          pending.controller.abort()
          calibrations.current.delete(key)
        }
        const engine = await x264()
        if (run.canceled) return
        run.job = engine.encode(probe, settings, onProgress)
      } else {
        const { bitrate } = await ensureCalibration(probe, settings).promise
        if (run.canceled) return
        run.job = (await media()).compress(probe, settings, bitrate, onProgress)
      }
      const { measureQuality } = await media()
      const blob = await run.job.promise
      const url = URL.createObjectURL(blob)
      setPhase({ kind: 'done', probe, blob, url, quality: settings.preset === 'copy' ? 'failed' : 'pending' })
      if (settings.preset === 'copy') return
      const quality = await measureQuality(probe, blob).catch(() => 'failed' as const)
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
        <p className="header-note">Runs on your device. Nothing is uploaded.</p>
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
            preparing={usesX264(settings) ? 'Starting encoders…' : 'Finishing tuning…'}
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
          Compression runs in this browser and the file never leaves your device. Pare tests encodes against your
          video until it finds the smallest size that still looks the same, then checks the result frame by frame.
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
      <dl className="principles">
        <div>
          <dt>Private</dt>
          <dd>Your browser reads the file directly. Nothing is uploaded, not even a thumbnail.</dd>
        </div>
        <div>
          <dt>Tuned per video</dt>
          <dd>Short test encodes find the lowest bitrate that meets the quality target for this footage.</dd>
        </div>
        <div>
          <dt>Verified</dt>
          <dd>The finished file is compared with the original and scored, so you can see what you're getting.</dd>
        </div>
      </dl>
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
            <dd>{probe.audio ? CODEC_LABEL[probe.audio.codec ?? ''] ?? probe.audio.codec ?? 'Unknown' : 'None'}</dd>
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
  const presetLabel = PRESETS.find((p) => p.value === settings.preset)?.label.toLowerCase()
  const better = (['hevc', 'av1'] as const).filter((c) => c !== settings.codec && probe.encodable[c])

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
          legend="Encoder"
          value={settings.engine}
          options={ENGINES}
          disabled={copy}
          onChange={(engine) => setSettings((s) => ({ ...s, engine }))}
          hint={copy ? 'Not used. Nothing is re-encoded.' : ENGINE_HINT[settings.engine]}
        />
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
          hint={copy ? 'Unchanged.' : `${target.width}×${target.height}`}
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
          hint={!probe.audio ? 'This video has no audio.' : undefined}
        />
        {probe.hdr && !copy && (
          <p className="note">This is an HDR video. The compressed copy is SDR, so highlights and colors may look flatter.</p>
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
            {result?.crf
              ? "Measured on short test encodes"
              : result && !copy
              ? `SSIM ${result.ssim.toFixed(3)} on test clips at ${fmt.bitrate(result.bitrate)}`
              : tuning && 'round' in tuning && tuning.round > 0
                ? `Test encode ${tuning.round}`
                : copy
                  ? 'Same streams, new container'
                  : '\u00a0'}
          </span>
        </div>
        <button type="submit" className="button primary" disabled={noEncoder || (!!tuning && 'error' in tuning && !usesX264(settings))}>
          {copy ? 'Repackage video' : 'Compress video'}
        </button>
      </div>
      {result && !result.reached && !copy && (
        <p className="note">
          {CODEC_LABEL[settings.codec]} in this browser can't reach {presetLabel} quality on this video without growing
          past the original's bitrate, so this is as close as it gets.{' '}
          {better.length
            ? `${better.map((c) => CODEC_LABEL[c]).join(' or ')} should do better.`
            : 'A lower quality setting will make it smaller.'}
        </p>
      )}
      {result?.crf && result.size > probe.file.size * 0.95 && (
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
    </form>
  )
}

function Running(props: { probe: Probe; progress: Progress | null; preparing: string; onCancel: () => void }) {
  const { probe, progress, onCancel } = props
  const fraction = progress?.fraction ?? 0
  const speed = progress && progress.elapsed > 0.5 ? progress.processed / progress.elapsed : null
  const left = speed ? (probe.duration - (progress?.processed ?? 0)) / speed : Infinity
  return (
    <section className="stack">
      <FileSummary probe={probe} />
      <div className="panel running">
        <div className="running-head">
          {progress ? (
            <span className="percent" aria-hidden>
              {Math.floor(fraction * 100)}
              <span className="percent-sign">%</span>
            </span>
          ) : (
            <span className="running-status pending">{props.preparing}</span>
          )}
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
            <dd>{fmt.eta(left)}</dd>
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

  return (
    <section className="stack">
      <div className="panel result">
        <p className="result-kicker">{smaller ? 'Done' : 'Done, but the original is smaller'}</p>
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
                SSIM {quality.ssim.toFixed(4)} · PSNR {quality.psnr.toFixed(1)}&nbsp;dB
              </span>
            </>
          )}
        </p>
        {!smaller && (
          <p className="note">This video was already efficiently compressed. Keep the original, or try a lower quality.</p>
        )}
        <div className="result-actions">
          <a className={smaller ? 'button primary' : 'button'} href={url} download={name}>
            Download {ext.toUpperCase()}
          </a>
          <button type="button" className="button ghost" onClick={props.onAdjust}>
            Change settings
          </button>
          <button type="button" className="link push" onClick={props.onNew}>
            Compress another video
          </button>
        </div>
      </div>
      {typeof quality === 'object' && <Compare frames={quality.frames} />}
    </section>
  )
}
