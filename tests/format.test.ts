import { expect, test } from 'bun:test'
import { bytes, clock, parseClock } from '../src/lib/format'

test('times read as seconds or minutes:seconds, with a decimal point or comma', () => {
  expect(parseClock('83.5')).toBe(83.5)
  expect(parseClock('1:23.5')).toBe(83.5)
  expect(parseClock('1:01:23.5')).toBe(3683.5)
  expect(parseClock(' 12,5 ')).toBe(12.5)
  expect(parseClock('.5')).toBe(0.5)
  expect(parseClock('1,2,3')).toBeNull()
  expect(parseClock('1:2:3:4')).toBeNull()
  expect(parseClock('abc')).toBeNull()
  expect(parseClock('')).toBeNull()
})

test('times show to a tenth, or as many places as asked', () => {
  expect(clock(2.36667)).toBe('0:02.4')
  expect(clock(2.36667, 2)).toBe('0:02.37')
  expect(clock(3723.456, 2)).toBe('1:02:03.46')
  expect(clock(59.996, 2)).toBe('1:00.00')
})

test('sizes drop trailing zeros', () => {
  expect(bytes(50_000)).toBe('50 KB')
  expect(bytes(3_300_000)).toBe('3.3 MB')
  expect(bytes(117_400)).toBe('117 KB')
})
