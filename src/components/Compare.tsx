import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
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

export function Compare({ frames }: { frames: FramePair[] }) {
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
    <section className="compare" aria-labelledby="compare-title">
      <div className="compare-head">
        <h2 id="compare-title">Compare frames</h2>
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

      <div className="strip" role="group" aria-label="Sampled frames">
        {frames.map((f, i) => (
          <button
            key={f.time}
            type="button"
            className="strip-item"
            aria-pressed={i === index}
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
        {frames.length} frames sampled across the video, scored by SSIM (1.000 is identical). Opens on the weakest one.
      </p>
    </section>
  )
}
