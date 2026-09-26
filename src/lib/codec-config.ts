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
 * The codec string for AV1 in MP4 ("av01.P.LLT.DD"), from the sequence header OBU SVT-AV1 returns as its headers.
 * Mediabunny builds the av1C box from it; the sequence header itself travels in every keyframe. Reads profile, level
 * and tier of operating point 0, and the bit depth from the colour config (AV1 spec 5.5).
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
  const reduced = read(1)
  if (reduced) {
    level = read(5)
  } else {
    let decoderModel = 0
    let delayLength = 0
    if (read(1)) {
      // timing_info, then decoder_model_info if present
      read(32)
      read(32)
      if (read(1)) uvlc()
      decoderModel = read(1)
      if (decoderModel) {
        delayLength = read(5) + 1
        read(32)
        read(5)
        read(5)
      }
    }
    const displayDelay = read(1)
    const points = read(5) + 1
    for (let i = 0; i < points; i++) {
      read(12) // operating_point_idc
      const pointLevel = read(5)
      const pointTier = pointLevel > 7 ? read(1) : 0
      if (i === 0) (level = pointLevel), (tier = pointTier)
      if (decoderModel && read(1)) read(2 * delayLength + 1)
      if (displayDelay && read(1)) read(4)
    }
  }
  // Up to color_config, for the bit depth.
  const widthBits = read(4) + 1
  const heightBits = read(4) + 1
  read(widthBits)
  read(heightBits)
  if (!reduced && read(1)) read(7) // frame ids
  read(3) // 128x128 superblocks, filter intra, intra edge filter
  if (!reduced) {
    read(4) // interintra, masked compound, warped motion, dual filter
    const orderHint = read(1)
    if (orderHint) read(2)
    const screenContent = read(1) ? 2 : read(1)
    if (screenContent > 0 && !read(1)) read(1)
    if (orderHint) read(3)
  }
  read(3) // superres, cdef, restoration
  const high = read(1)
  const depth = profile === 2 && high ? (read(1) ? 12 : 10) : high ? 10 : 8
  const codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
  return { codec, codedWidth: width, codedHeight: height }
}

/** The decoder config for either encoder's output. */
export const decoderConfig = (codec: 'avc' | 'av1', headers: Uint8Array, width: number, height: number) =>
  codec === 'av1' ? av1Config(headers, width, height) : avcConfig(headers, width, height)
