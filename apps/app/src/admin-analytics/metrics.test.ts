import { describe, expect, test } from 'vitest'
import {
  calendarDayWindow,
  csvCell,
  formatMetric,
  overheadPercent,
  percentile,
  percentiles,
} from './metrics'

test('percentile is taken from the population, not an average of daily tails', () => {
  const values = [10n, 20n, 30n, 40n, 100n]
  expect(percentile(values, 50)).toBe(30n)
  expect(percentile(values, 90)).toBe(100n)
  expect(percentile([], 99)).toBeNull()
})

test('small samples flag an unstable p99 instead of hiding it', () => {
  const set = percentiles([1n, 2n, 3n])
  expect(set.tailUnstable).toBe(true)
  expect(set.samples).toBe(3)
  expect(percentiles(Array.from({ length: 20 }, (_, i) => BigInt(i + 1))).tailUnstable).toBe(false)
})

test('unavailable metrics never render as zero', () => {
  expect(formatMetric({ state: 'unavailable', reason: 'No retained request bytes' })).toBe('Unavailable')
  expect(formatMetric({ state: 'measured', value: 0n, coverage: 1 })).toBe('0 B')
})

test('overhead uses weighted sums and refuses a zero denominator', () => {
  const encrypted = { state: 'measured' as const, value: 150n, coverage: 1 }
  const plaintext = { state: 'measured' as const, value: 100n, coverage: 0.8 }
  const overhead = overheadPercent(encrypted, plaintext)
  expect(overhead.state).toBe('measured')
  if (overhead.state === 'measured') expect(overhead.value).toBe(5000n)
  expect(overheadPercent(encrypted, { state: 'measured', value: 0n, coverage: 1 }).state).toBe('unavailable')
  expect(overheadPercent(encrypted, { state: 'unavailable', reason: 'missing' }).state).toBe('unavailable')
})

test('csv cells cannot inject spreadsheet formulas', () => {
  expect(csvCell('=cmd|calc')).toBe("'=cmd|calc")
  expect(csvCell('+1')).toBe("'+1")
  expect(csvCell('-1')).toBe("'-1")
  expect(csvCell('@sum')).toBe("'@sum")
  expect(csvCell('safe,value')).toBe('"safe,value"')
  expect(csvCell('plain')).toBe('plain')
})

describe('Asia/Ho_Chi_Minh calendar day', () => {
  test('11 October 2026 is the half-open UTC window starting 17:00 the previous day', () => {
    const window = calendarDayWindow('2026-10-11', 'Asia/Ho_Chi_Minh')
    expect(window.start.toISOString()).toBe('2026-10-10T17:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-10-11T17:00:00.000Z')
  })
})
