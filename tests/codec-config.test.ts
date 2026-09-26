import { expect, test } from 'bun:test'
import { av1Config } from '../src/lib/codec-config'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16))

test('reads profile, level, tier and bit depth from AV1 sequence headers', () => {
  // The 64x64 keyframes Pare decodes to check AV1 support (shared.ts), after their temporal delimiter.
  expect(av1Config(hex('0a0a00000002afff9b5f2008'), 64, 64).codec).toBe('av01.0.00M.08')
  expect(av1Config(hex('0a0a00000002afff9b5f2808'), 64, 64).codec).toBe('av01.0.00M.10')
  // SVT-AV1's, from the 10-bit HLG test clip (1080p, level 4.0).
  expect(av1Config(hex('0a0f020000429 55dfe1b8d5f3a12241248'.replace(/ /g, '')), 1920, 1080).codec).toBe('av01.0.08M.10')
})

test('refuses headers that aren\'t a sequence header', () => {
  expect(() => av1Config(hex('12000a0a'), 64, 64)).toThrow()
})
