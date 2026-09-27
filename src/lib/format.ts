export function bytes(n: number) {
  if (n < 1000) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1000
    u++
  } while (v >= 1000 && u < units.length - 1)
  // Three figures at most, without trailing zeros: a typed 0.05 MB reads back as 50 KB, not 50.0 KB.
  return `${Number(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2))} ${units[u]}`
}

export function duration(s: number) {
  const total = Math.max(0, Math.round(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function bitrate(bps: number) {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`
}

export function fps(n: number) {
  const r = Math.round(n * 100) / 100
  return `${Number.isInteger(r) ? r : r.toFixed(2)} fps`
}

export function eta(seconds: number) {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 5) return 'A few seconds'
  if (seconds < 60) return `About ${Math.ceil(seconds / 5) * 5} s left`
  return `About ${Math.ceil(seconds / 60)} min left`
}

export function change(from: number, to: number) {
  const pct = Math.round((1 - to / from) * 100)
  return pct >= 0 ? `−${pct}%` : `+${-pct}%`
}

/** A time to a tenth of a second (or `digits` places): 0:03.4, 1:02:05.0. */
export function clock(s: number, digits = 1) {
  const scale = 10 ** digits
  const parts = Math.max(0, Math.round(s * scale))
  return `${duration(Math.floor(parts / scale))}.${String(parts % scale).padStart(digits, '0')}`
}

/** Seconds from a typed time: 83.5, 1:23.5 or 1:01:23.5. Null when it isn't one. */
export function parseClock(text: string) {
  const parts = text.trim().split(':')
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d*)?$|^\.\d+$/.test(p.trim()))) return null
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}
