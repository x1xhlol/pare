import type { MetadataTags, Output } from 'mediabunny'

/** When and where a video was recorded, as its file says. */
export type Origin = {
  date: Date | null
  /** ISO 6709, as phones write it: "+52.5163+013.3777+034.000/". */
  place: string | null
}

/** Seconds from QuickTime's epoch (1904) to Unix's. */
const EPOCH_1904 = 2082844800

/**
 * What the source says about its recording. iPhones write the date and place as QuickTime keys; Android phones and
 * most cameras put the date only in the movie header (mvhd), which Mediabunny doesn't read, and the place in a
 * `©xyz` box. Photo libraries sort by that date, so a copy without it lands on the day it was made.
 */
export async function readOrigin(file: Blob, tags: MetadataTags): Promise<Origin> {
  const raw = tags.raw ?? {}
  const apple = raw['com.apple.quicktime.creationdate']
  const date = [typeof apple === 'string' ? new Date(apple) : null, await movieCreated(file).catch(() => null), tags.date]
    .find((d): d is Date => !!d && plausible(d)) ?? null
  const iso = raw['com.apple.quicktime.location.ISO6709']
  const xyz = raw['©xyz']
  const place = typeof iso === 'string' ? iso : typeof xyz === 'string' ? xyz : xyz instanceof Uint8Array ? userText(xyz) : null
  return { date, place: place && /^[+-]\d/.test(place) ? place : null }
}

/** "52.5163° N, 13.3777° E" for a place in decimal degrees, as phones write it; null for other forms. */
export function placeLabel(place: string) {
  const m = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(place)
  if (!m) return null
  const [lat, lon] = [Number(m[1]), Number(m[2])]
  return `${Math.abs(lat).toFixed(4)}°\u00a0${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}°\u00a0${lon < 0 ? 'W' : 'E'}`
}

/** Dates from before digital video or after tomorrow are unset or wrong clocks (a header of 0 is 1904). */
const plausible = (d: Date) => !Number.isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getTime() < Date.now() + 864e5

/** A QuickTime user data string: its length, a language code, then the text. */
function userText(box: Uint8Array) {
  if (box.length < 4) return null
  const length = (box[0] << 8) | box[1]
  return new TextDecoder().decode(box.subarray(4, 4 + length))
}

/** The creation time in an MP4 or QuickTime file's movie header, walking box headers rather than reading the file. */
async function movieCreated(file: Blob): Promise<Date | null> {
  const moov = await findBox(file, 0, file.size, 'moov')
  const mvhd = moov && (await findBox(file, moov.start, moov.end, 'mvhd'))
  if (!mvhd) return null
  const body = new DataView(await file.slice(mvhd.start, mvhd.start + 12).arrayBuffer())
  const seconds = body.getUint8(0) === 1 ? Number(body.getBigUint64(4)) : body.getUint32(4)
  return seconds ? new Date((seconds - EPOCH_1904) * 1000) : null
}

/** The body of the first box of `type` between `from` and `to`. */
async function findBox(file: Blob, from: number, to: number, type: string) {
  for (let at = from; at + 8 <= to; ) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer())
    let size = head.getUint32(0)
    let header = 8
    if (size === 1 && head.byteLength >= 16) {
      size = Number(head.getBigUint64(8))
      header = 16
    } else if (size === 0) size = to - at
    if (size < header) return null
    const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7))
    if (name === type) return { start: at + header, end: Math.min(at + size, to) }
    at += size
  }
  return null
}

/**
 * Gives an MP4 output the source's recording date, in the movie header, where Android phones, cameras and FFmpeg put
 * it and photo libraries read it. Mediabunny otherwise writes the time the file was made, with no option to change
 * it. Call before the output starts.
 */
export function stampDate(output: Output, origin: Origin | undefined) {
  const muxer = (output as unknown as { _muxer?: { creationTime?: unknown } })._muxer
  if (origin?.date && typeof muxer?.creationTime === 'number')
    muxer.creationTime = Math.floor(origin.date.getTime() / 1000) + EPOCH_1904
}

/**
 * The output's tags: the source's place, in a `©xyz` box as Android and FFmpeg write it, for an output writing
 * QuickTime user data (metadataFormat 'udta'). It goes in whether or not it's kept, so that choice can change after
 * an encode has started: dropPlace blanks it afterwards.
 */
export const originTags = (origin: Origin | undefined): MetadataTags =>
  origin?.place ? { raw: { '©xyz': origin.place } } : {}

/** The file with its `©xyz` box turned into padding of the same size, so nothing else in it moves. */
export async function dropPlace(file: Blob): Promise<Blob> {
  const moov = await findBox(file, 0, file.size, 'moov')
  const udta = moov && (await findBox(file, moov.start, moov.end, 'udta'))
  const xyz = udta && (await findBox(file, udta.start, udta.end, '©xyz'))
  if (!xyz) return file
  const start = xyz.start - 8
  const padding = new Uint8Array(xyz.end - start)
  new DataView(padding.buffer).setUint32(0, padding.length)
  padding.set([0x66, 0x72, 0x65, 0x65], 4) // 'free'
  return new Blob([file.slice(0, start), padding, file.slice(xyz.end)], { type: file.type })
}
