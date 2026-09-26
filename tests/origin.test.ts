import { describe, expect, test } from 'bun:test'
import {
  BufferSource, BufferTarget, EncodedPacket, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output, QTFF,
  type MetadataTags,
} from 'mediabunny'
import { dropPlace, originTags, readOrigin, stampDate, type Origin } from '../src/lib/origin'

/** A one-frame MP4 written the way Pare writes its outputs, or with other metadata settings. */
async function mp4(origin?: Origin, format: 'udta' | 'mdta' = 'udta', tags?: MetadataTags) {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory', metadataFormat: format }), target: new BufferTarget() })
  stampDate(output, origin)
  output.setMetadataTags(tags ?? originTags(origin))
  const video = new EncodedVideoPacketSource('vp9')
  output.addVideoTrack(video)
  await output.start()
  await video.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 1 / 30),
    { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } })
  await output.finalize()
  return new Blob([output.target.buffer!])
}

async function read(file: Blob) {
  const input = new Input({ source: new BufferSource(await file.arrayBuffer()), formats: [MP4, QTFF] })
  try {
    return await readOrigin(file, await input.getMetadataTags())
  } finally {
    input.dispose()
  }
}

const recorded = { date: new Date('2025-06-01T12:34:56Z'), place: '+48.8584+002.2945/' }

describe('recording date and place', () => {
  test('carry over into an output', async () => {
    expect(await read(await mp4(recorded))).toEqual(recorded)
  })

  test('dropping the place keeps the date and the size', async () => {
    const file = await mp4(recorded)
    const dropped = await dropPlace(file)
    expect(dropped.size).toBe(file.size)
    expect(await read(dropped)).toEqual({ date: recorded.date, place: null })
    // The file still opens.
    const input = new Input({ source: new BufferSource(await dropped.arrayBuffer()), formats: [MP4] })
    expect((await input.getPrimaryVideoTrack())?.codec).toBe('vp9')
  })

  test('iPhone keys win over the movie header', async () => {
    const file = await mp4({ date: new Date('2024-12-24T18:05:09Z'), place: null }, 'mdta', {
      raw: {
        'com.apple.quicktime.creationdate': '2024-12-24T19:05:07+0100',
        'com.apple.quicktime.location.ISO6709': '+52.5163+013.3777+034.000/',
      },
    })
    expect(await read(file)).toEqual({ date: new Date('2024-12-24T18:05:07Z'), place: '+52.5163+013.3777+034.000/' })
  })

  test('a file without them has neither', async () => {
    // Mediabunny's own creation time is the moment the file was written, which is a plausible date; a header of 0
    // (1904) is not.
    const origin = await read(await mp4())
    expect(origin.place).toBeNull()
    expect(Math.abs(origin.date!.getTime() - Date.now())).toBeLessThan(60_000)
    expect(await readOrigin(new Blob([new Uint8Array(32)]), {})).toEqual({ date: null, place: null })
  })
})
