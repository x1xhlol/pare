import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { FramePair } from '../lib/media'
import { duration } from '../lib/format'

function Bitmap({ bitmap, className, width }: { bitmap: ImageBitmap; className?: string; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const scale = width ? width / bitmap.width : 1
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  }, [bitmap, width])
  return <canvas ref={ref} className={className} />
}

type Point = { time: number; ssim: number }

/**
 * The encoder's SSIM for every frame across the video: a line along the top means identical, dips are where it
 * compressed hardest. The sampled frames are marked, and picking a point opens the nearest one.
 */
function Timeline({ points, frames, index, onPick }: {
  points: Point[]
  frames: FramePair[]
  index: number
  onPick: (index: number) => void
}) {
  const end = Math.max(points[points.length - 1].time, ...frames.map((f) => f.time)) || 1
  const lowest = points.reduce((a, b) => (b.ssim < a.ssim ? b : a))
  // The deepest dip reaches the bottom, but a spread under 0.02 isn't blown up to look dramatic.
  const range = Math.max(0.02, 1 - lowest.ssim)
  const x = (t: number) => (t / end) * 1000
  const y = (s: number) => 4 + ((1 - s) / range) * 56
  const line = points.map((p) => `${x(p.time).toFixed(1)},${y(p.ssim).toFixed(1)}`).join(' ')
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const time = ((e.clientX - rect.left) / rect.width) * end
    onPick(frames.reduce((best, f, i) => (Math.abs(f.time - time) < Math.abs(frames[best].time - time) ? i : best), 0))
  }
  return (
    <figure className="timeline">
      <div className="timeline-plot">
        <svg
          viewBox="0 0 1000 64"
          preserveAspectRatio="none"
          role="img"
          aria-label={`SSIM of every frame, from ${lowest.ssim.toFixed(3)} at ${duration(lowest.time)} to 1.000`}
          onPointerDown={pick}
        >
          <polygon className="timeline-loss" points={`0,4 ${line} 1000,4`} />
          <polyline className="timeline-line" points={line} vectorEffect="non-scaling-stroke" />
          {frames.map((f, i) => (
            <line
              key={f.time}
              className="timeline-mark"
              data-current={i === index || undefined}
              x1={x(f.time)}
              x2={x(f.time)}
              y1={0}
              y2={64}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      <figcaption className="timeline-caption">
        <span>SSIM of every frame</span>
        <span>
          lowest {lowest.ssim.toFixed(3)} at {duration(lowest.time)}
        </span>
      </figcaption>
    </figure>
  )
}

export function Compare({ frames, timeline, title = 'Compare frames', note }: {
  frames: FramePair[]
  timeline?: Point[]
  title?: string
  note?: ReactNode
}) {
  const titleId = useId()
  const [index, setIndex] = useState(() => frames.reduce((w, f, i) => (f.ssim < frames[w].ssim ? i : w), 0))
  const [split, setSplit] = useState(50)
  const [actual, setActual] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const frame = frames[index]

  const moveTo = (e: PointerEvent) => {
    const rect = stage.current?.getBoundingClientRect()
    if (!rect) return
    setSplit(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)))
  }

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2
    if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0, s - step))
    else if (e.key === 'ArrowRight') setSplit((s) => Math.min(100, s + step))
    else if (e.key === 'Home') setSplit(0)
    else if (e.key === 'End') setSplit(100)
    else return
    e.preventDefault()
  }

  return (
    <section className="compare" aria-labelledby={titleId}>
      <div className="compare-head">
        {/* Focusable for a view that moves the focus here (the preview, when it opens). */}
        <h2 id={titleId} tabIndex={-1}>{title}</h2>
        <label className="toggle">
          <input type="checkbox" checked={actual} onChange={(e) => setActual(e.target.checked)} />
          <span>Actual pixels</span>
        </label>
      </div>

      <div className="viewer" data-actual={actual || undefined}>
        <div
          ref={stage}
          className="stage"
          style={{ aspectRatio: `${frame.original.width} / ${frame.original.height}`, width: actual ? frame.original.width : undefined }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            moveTo(e)
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) moveTo(e)
          }}
        >
          <Bitmap bitmap={frame.original} className="layer" />
          <div className="layer" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
            <Bitmap bitmap={frame.compressed} className="layer" />
          </div>
          <span className="stage-tag" data-side="left" aria-hidden>Original</span>
          <span className="stage-tag" data-side="right" aria-hidden>Compressed</span>
          <div
            className="divider"
            style={{ left: `${split}%` }}
            role="slider"
            tabIndex={0}
            aria-label="Split between original and compressed"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split)}
            aria-valuetext={`${Math.round(split)}% original`}
            onKeyDown={onKey}
          >
            <span className="divider-grip" />
          </div>
        </div>
      </div>

      {timeline && timeline.length > 1 && <Timeline points={timeline} frames={frames} index={index} onPick={setIndex} />}

      <div className="strip" data-count={frames.length} role="group" aria-label="Sampled frames">
        {frames.map((f, i) => (
          <button
            key={f.time}
            type="button"
            className="strip-item"
            aria-pressed={i === index}
            aria-label={`Frame at ${duration(f.time)}, SSIM ${f.ssim.toFixed(3)}`}
            onClick={() => setIndex(i)}
          >
            <Bitmap bitmap={f.compressed} className="strip-thumb" width={240} />
            <span className="strip-meta">
              <span>{duration(f.time)}</span>
              <span>{f.ssim.toFixed(3)}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="note">
        {note ?? (
          <>
            The weakest frames the encoder measured, plus an even spread across the video. SSIM of 1.000 means
            identical; the view opens on the weakest.
          </>
        )}
      </p>
    </section>
  )
}
