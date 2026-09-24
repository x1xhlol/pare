export function bytes(n: number) {
  if (n < 1000) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1000
    u++
  } while (v >= 1000 && u < units.length - 1)
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`
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
  if (!Number.isFinite(seconds)) return 'Estimating time left…'
  if (seconds < 5) return 'Almost done'
  if (seconds < 60) return `About ${Math.ceil(seconds / 5) * 5} s left`
  return `About ${Math.ceil(seconds / 60)} min left`
}

export function change(from: number, to: number) {
  const pct = Math.round((1 - to / from) * 100)
  return pct >= 0 ? `−${pct}%` : `+${-pct}%`
}
