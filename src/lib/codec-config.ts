// Decoder configs for Pare's own encoders' output, built from the headers each encoder returns. The muxer needs
// them for the MP4 sample entry, and plan workers decode their test encodes with them to score quality.

/** Splits x264's headers (4-byte length-prefixed SPS, PPS, SEI) into an avcC record and codec string. */
export function avcConfig(headers: Uint8Array, width: number, height: number): VideoDecoderConfig {
  const nals: Uint8Array[] = []
  for (let i = 0; i < headers.length; ) {
    const len = (headers[i] << 24) | (headers[i + 1] << 16) | (headers[i + 2] << 8) | headers[i + 3]
    nals.push(headers.subarray(i + 4, i + 4 + len))
    i += 4 + len
  }
  const sps = nals.find((n) => (n[0] & 0x1f) === 7)
  const pps = nals.find((n) => (n[0] & 0x1f) === 8)
  if (!sps || !pps) throw new Error('The encoder produced no SPS/PPS.')
  const avcC = new Uint8Array(11 + sps.length + pps.length)
  avcC.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff])
  avcC.set(sps, 8)
  avcC.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length)
  avcC.set(pps, 11 + sps.length)
  const hex = (b: number) => b.toString(16).padStart(2, '0')
  return { codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`, codedWidth: width, codedHeight: height, description: avcC }
}

/**
 * The codec string for AV1 in MP4 ("av01.P.LLT.08"), from the sequence header OBU SVT-AV1 returns as its headers.
 * Mediabunny builds the av1C box from it; the sequence header itself travels in every keyframe. Reads profile, and
 * level and tier of operating point 0 (AV1 spec 5.5).
 */
export function av1Config(headers: Uint8Array, width: number, height: number): VideoDecoderConfig {
  let bit = 0
  const read = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((headers[bit >> 3] >> (7 - (bit & 7))) & 1)
    return v
  }
  const uvlc = () => {
    let zeros = 0
    while (!read(1)) zeros++
    return zeros >= 32 ? 2 ** 32 - 1 : read(zeros) + 2 ** zeros - 1
  }
  const leb128 = () => {
    let v = 0
    for (let i = 0; i < 8; i++) {
      const byte = read(8)
      v += (byte & 0x7f) * 2 ** (7 * i)
      if (!(byte & 0x80)) break
    }
    return v
  }
  // OBU header: forbidden bit, type, extension flag, has_size_field, reserved.
  read(1)
  if (read(4) !== 1) throw new Error('The AV1 encoder returned no sequence header.')
  const extension = read(1)
  const hasSize = read(1)
  read(1)
  if (extension) read(8)
  if (hasSize) leb128()
  const profile = read(3)
  read(1) // still_picture
  let level = 0
  let tier = 0
  if (read(1)) {
    level = read(5) // reduced_still_picture_header
  } else {
    if (read(1)) {
      // timing_info, then decoder_model_info if present
      read(32)
      read(32)
      if (read(1)) uvlc()
      if (read(1)) {
        read(5)
        read(32)
        read(5)
        read(5)
      }
    }
    read(1) // initial_display_delay_present_flag
    read(5) // operating_points_cnt_minus_1
    read(12) // operating_point_idc[0]
    level = read(5)
    if (level > 7) tier = read(1)
  }
  const codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.08`
  return { codec, codedWidth: width, codedHeight: height }
}

/** The decoder config for either encoder's output. */
export const decoderConfig = (codec: 'avc' | 'av1', headers: Uint8Array, width: number, height: number) =>
  codec === 'av1' ? av1Config(headers, width, height) : avcConfig(headers, width, height)
